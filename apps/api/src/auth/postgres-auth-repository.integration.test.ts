import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresAuthRepository } from "./postgres-auth-repository.js";

/**
 * Normal unit tests use an in-memory AuthRepository so contributors can run
 * them without Docker. This opt-in suite exists because JavaScript accepts a
 * null byte in a string while PostgreSQL `text` does not; only the real driver
 * and database can protect the OIDC callback from that class of integration
 * bug.
 */
const runDatabaseIntegration =
  process.env.ZEROSHEET_RUN_DB_INTEGRATION === "true"
    ? describe
    : describe.skip;

const firstCandidateUserId = "b1000000-0000-4000-8000-000000000001";
const secondCandidateUserId = "b1000000-0000-4000-8000-000000000002";
const issuer = "http://localhost:8080/realms/zerosheet";
const subject = "auth-repository-integration-user";
const firstLoginAt = new Date("2026-09-03T08:00:00.000Z");
const secondLoginAt = new Date("2026-09-03T08:05:00.000Z");

const { Pool } = pg;
let pool: pg.Pool;
let repository: PostgresAuthRepository;

runDatabaseIntegration("PostgresAuthRepository", () => {
  beforeAll(async () => {
    // Vitest runs from `apps/api`, so load the ignored repository-root file
    // without copying its database password into process arguments or output.
    loadEnvFile(fileURLToPath(new URL("../../../../.env", import.meta.url)));
    pool = new Pool({
      host: process.env.ZEROSHEET_DB_HOST ?? "127.0.0.1",
      port: Number(process.env.ZEROSHEET_DB_PORT ?? "5434"),
      database: process.env.ZEROSHEET_DB_NAME ?? "zerosheet",
      user: process.env.ZEROSHEET_DB_USER ?? "zerosheet_app",
      password: process.env.ZEROSHEET_DB_PASSWORD,
      max: 2,
    });
    repository = new PostgresAuthRepository(pool);
    await cleanup();
    await repository.assertReady();
  });

  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  it("creates and revisits an OIDC identity using a PostgreSQL-safe advisory lock", async () => {
    const created = await repository.upsertExternalIdentity({
      issuer,
      subject,
      email: "first-login@zerosheet.local",
      emailVerified: true,
      displayName: "First Login",
      candidateUserId: firstCandidateUserId,
      now: firstLoginAt,
    });

    expect(created).toEqual({
      id: firstCandidateUserId,
      email: "first-login@zerosheet.local",
      displayName: "First Login",
    });

    /**
     * A later login for the same `(issuer, subject)` must update the existing
     * product user. The unused candidate proves that provider email is mutable
     * metadata and does not create or silently link a second account.
     */
    const revisited = await repository.upsertExternalIdentity({
      issuer,
      subject,
      email: "renamed@zerosheet.local",
      emailVerified: true,
      displayName: "Renamed User",
      candidateUserId: secondCandidateUserId,
      now: secondLoginAt,
    });

    expect(revisited).toEqual({
      id: firstCandidateUserId,
      email: "renamed@zerosheet.local",
      displayName: "Renamed User",
    });

    const candidateCount = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM product_users WHERE id = $1",
      [secondCandidateUserId],
    );
    expect(candidateCount.rows[0]?.count).toBe("0");
  });
});

async function cleanup(): Promise<void> {
  /**
   * Deleting the product user cascades to its external identity. Both UUIDs
   * are fixed test-only values, which keeps cleanup narrow and makes rerunning
   * an interrupted suite safe without touching a manually created account.
   */
  await pool.query("DELETE FROM product_users WHERE id = ANY($1::uuid[])", [
    [firstCandidateUserId, secondCandidateUserId],
  ]);
}
