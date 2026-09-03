#!/usr/bin/env node

/**
 * pnpm's legacy deploy mode correctly copies private workspace dependencies,
 * but it preserves their development `exports` maps. Several ZeroSheet
 * packages intentionally expose TypeScript source to the monorepo toolchain;
 * plain Node in a runtime image must instead load compiled JavaScript.
 *
 * This build-only step rewrites packages inside one already-isolated deploy
 * directory. It never edits source manifests. Every discovered ZeroSheet
 * package must contain `dist/index.js` and `dist/index.d.ts`, so an incomplete
 * build fails while the image is being assembled rather than at startup.
 */
import { constants } from "node:fs";
import { access, readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const requestedDirectory = process.argv[2];
if (!requestedDirectory || !isAbsolute(requestedDirectory)) {
  throw new Error("Pass one absolute pnpm deploy directory.");
}

const deployDirectory = await realpath(resolve(requestedDirectory));
const applicationManifestPath = join(deployDirectory, "package.json");
const applicationManifest = JSON.parse(
  await readFile(applicationManifestPath, "utf8"),
);
if (
  typeof applicationManifest.name !== "string" ||
  !applicationManifest.name.startsWith("@zerosheet/")
) {
  throw new Error("The deploy directory must contain a ZeroSheet application.");
}

const workspaceDependencyNames = Object.keys({
  ...applicationManifest.dependencies,
  ...applicationManifest.optionalDependencies,
}).filter((name) => name.startsWith("@zerosheet/"));

if (workspaceDependencyNames.length === 0) {
  throw new Error("The deployed API has no ZeroSheet workspace dependencies.");
}

for (const dependencyName of workspaceDependencyNames) {
  const packageDirectory = await realpath(
    join(deployDirectory, "node_modules", dependencyName),
  );
  const pathFromDeploy = relative(deployDirectory, packageDirectory);
  if (pathFromDeploy.startsWith(`..${sep}`) || pathFromDeploy === "..") {
    throw new Error(`${dependencyName} resolves outside the deploy directory.`);
  }

  const javascriptPath = join(packageDirectory, "dist", "index.js");
  const declarationsPath = join(packageDirectory, "dist", "index.d.ts");
  await access(javascriptPath, constants.R_OK);
  await access(declarationsPath, constants.R_OK);

  const manifestPath = join(packageDirectory, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.exports = {
    ".": {
      types: "./dist/index.d.ts",
      default: "./dist/index.js",
    },
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o644,
  });
}

console.log(
  JSON.stringify({
    event: "deployed_workspace_exports_prepared",
    packageCount: workspaceDependencyNames.length,
  }),
);
