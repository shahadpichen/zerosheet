#!/usr/bin/env node

/**
 * A security-heavy application can still fail users by shipping an unbounded
 * browser payload. The spreadsheet editor is intentionally lazy, so this gate
 * separately caps the initial JavaScript, every individual chunk, and the
 * aggregate compressed JavaScript. Gzip is measured locally from exact build
 * bytes; network/CDN reporting is not required for a reproducible release gate.
 */
import { readFile, readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { gzipSync } from "node:zlib";

const distributionDirectory = resolve(process.argv[2] ?? "apps/web/dist");
const indexHtml = await readFile(
  join(distributionDirectory, "index.html"),
  "utf8",
);
const initialScriptMatch = indexHtml.match(/<script[^>]+src="\/([^"]+\.js)"/u);
if (!initialScriptMatch?.[1]) {
  throw new Error("The web build has no discoverable initial module script.");
}

const entries = await readdir(distributionDirectory, {
  recursive: true,
  withFileTypes: true,
});
const javascriptFiles = entries
  .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
  .map((entry) => resolve(entry.parentPath, entry.name));
if (javascriptFiles.length === 0) {
  throw new Error("The web build contains no JavaScript chunks.");
}

const measurements = await Promise.all(
  javascriptFiles.map(async (path) => ({
    path,
    gzipBytes: gzipSync(await readFile(path), { level: 9 }).byteLength,
  })),
);
const initialPath = resolve(distributionDirectory, initialScriptMatch[1]);
const initial = measurements.find(({ path }) => path === initialPath);
if (!initial) throw new Error("The initial JavaScript chunk is missing.");

const largest = measurements.reduce((left, right) =>
  left.gzipBytes >= right.gzipBytes ? left : right,
);
const totalGzipBytes = measurements.reduce(
  (total, measurement) => total + measurement.gzipBytes,
  0,
);
const INITIAL_LIMIT = 128 * 1024;
const CHUNK_LIMIT = 1_800 * 1024;
// Univer emits optional on-demand locale/data chunks even though ZeroSheet
// registers only en-US. They are not fetched by the initial page or editor
// entry chunk, but a total cap still catches accidental dependency explosions.
const TOTAL_LIMIT = 3_000 * 1024;

if (initial.gzipBytes > INITIAL_LIMIT) {
  throw new Error("The initial web JavaScript exceeds 128 KiB gzip.");
}
if (largest.gzipBytes > CHUNK_LIMIT) {
  throw new Error("A lazy web JavaScript chunk exceeds 1,800 KiB gzip.");
}
if (totalGzipBytes > TOTAL_LIMIT) {
  throw new Error("The total web JavaScript exceeds 3,000 KiB gzip.");
}

console.log(
  JSON.stringify({
    event: "web_bundle_budget_passed",
    initialGzipBytes: initial.gzipBytes,
    largestChunk: relative(distributionDirectory, largest.path),
    largestChunkGzipBytes: largest.gzipBytes,
    totalGzipBytes,
    chunkCount: measurements.length,
  }),
);
