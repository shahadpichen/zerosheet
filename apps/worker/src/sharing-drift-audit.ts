import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import pg from "pg";
import { PostgresSharingDriftRepository } from "./sharing-drift-repository.js";

const { Pool } = pg;

/** Read one secret file without ever copying its contents into an error. */
function databasePassword(environment: NodeJS.ProcessEnv): string {
  // Production provides the dedicated aggregate-only role. A local learning
  // database created before that role existed may explicitly reuse the app
  // credential so developers can validate the function without deleting their
  // volume. The production Compose file never takes this fallback.
  const direct = (
    environment.ZEROSHEET_AUDIT_DB_PASSWORD ?? environment.ZEROSHEET_DB_PASSWORD
  )?.trim();
  const filePath = (
    environment.ZEROSHEET_AUDIT_DB_PASSWORD_FILE ??
    environment.ZEROSHEET_DB_PASSWORD_FILE
  )?.trim();
  if (direct && filePath) {
    throw new Error(
      "ZEROSHEET_AUDIT_DB_PASSWORD and ZEROSHEET_AUDIT_DB_PASSWORD_FILE cannot both be set.",
    );
  }
  if (direct) return direct;
  if (!filePath || !isAbsolute(filePath)) {
    throw new Error(
      "ZEROSHEET_AUDIT_DB_PASSWORD_FILE must be an absolute path.",
    );
  }
  let document: string;
  try {
    document = readFileSync(filePath, "utf8");
  } catch {
    throw new Error("ZEROSHEET_AUDIT_DB_PASSWORD_FILE could not be read.");
  }
  const value = document.replace(/\r?\n$/u, "");
  if (!value || /[\r\n\0]/u.test(value) || value.length > 65_536) {
    throw new Error(
      "ZEROSHEET_AUDIT_DB_PASSWORD_FILE must contain one secret value.",
    );
  }
  return value;
}

/** Parse a bounded positive integer without silently accepting suffix text. */
function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error("A sharing audit numeric setting is invalid.");
  }
  return parsed;
}

async function main(): Promise<void> {
  const pool = new Pool({
    host: process.env.ZEROSHEET_DB_HOST ?? "127.0.0.1",
    port: positiveInteger(process.env.ZEROSHEET_DB_PORT, 5434),
    database: process.env.ZEROSHEET_DB_NAME ?? "zerosheet",
    user:
      process.env.ZEROSHEET_AUDIT_DB_USER ??
      process.env.ZEROSHEET_DB_USER ??
      "zerosheet_auditor",
    password: databasePassword(process.env),
    max: 2,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 10_000,
  });

  try {
    const repository = new PostgresSharingDriftRepository(pool);
    await repository.assertReady();
    const report = await repository.inspect(
      new Date(),
      positiveInteger(process.env.ZEROSHEET_SHARING_DRIFT_MINUTES, 30),
    );

    // Only aggregate counts enter stdout. Workbook IDs, user IDs, emails,
    // permission IDs, envelopes, and database errors remain absent.
    console.log(
      JSON.stringify({
        event: "sharing_drift_audit_completed",
        generatedAt: report.generatedAt.toISOString(),
        staleAfterMinutes: report.staleAfterMinutes,
        activeSharesMissingMaterial: report.activeSharesMissingMaterial,
        orphanedShareMaterial: report.orphanedShareMaterial,
        stalePendingRotations: report.stalePendingRotations,
        committedRevocationsStillActive: report.committedRevocationsStillActive,
        totalFindings: report.totalFindings,
      }),
    );
    if (report.totalFindings > 0) process.exitCode = 2;
  } finally {
    await pool.end();
  }
}

await main().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      event: "sharing_drift_audit_failed",
      errorType: error instanceof Error ? error.name : "UnknownError",
    }),
  );
  process.exitCode = 1;
});
