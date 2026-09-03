import { createECDH, createHash } from "node:crypto";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import type {
  UserPublicEncryptionKey,
  WorkbookKeyEnvelope,
} from "@zerosheet/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresWorkbookSecurityRepository } from "./postgres-workbook-security-repository.js";

const runDatabaseIntegration =
  process.env.ZEROSHEET_RUN_DB_INTEGRATION === "true"
    ? describe
    : describe.skip;
const SUITE = "DHKEM_P256_HKDF_SHA256_HKDF_SHA256_AES_256_GCM" as const;
const ownerId = "a1000000-0000-4000-8000-000000000001";
const recipientId = "a1000000-0000-4000-8000-000000000002";
const organizationId = "a1000000-0000-4000-8000-000000000003";
const workbookId = "a1000000-0000-4000-8000-000000000004";
const organizationOperationId = "a1000000-0000-4000-8000-000000000005";
const workbookOperationId = "a1000000-0000-4000-8000-000000000006";
const shareOperationId = "a1000000-0000-4000-8000-000000000007";
const now = new Date("2026-09-03T04:00:00.000Z");

const { Pool } = pg;
let pool: pg.Pool;
let repository: PostgresWorkbookSecurityRepository;

function publicKey(keyVersion = 1): UserPublicEncryptionKey {
  const key = createECDH("prime256v1");
  const bytes = key.generateKeys();
  return {
    formatVersion: 1,
    keyVersion,
    suite: SUITE,
    publicKey: bytes.toString("base64url"),
    fingerprint: createHash("sha256").update(bytes).digest("hex"),
  };
}

function envelope(
  recipient: UserPublicEncryptionKey,
  workbookKeyVersion: number,
): WorkbookKeyEnvelope {
  const ephemeral = createECDH("prime256v1");
  return {
    formatVersion: 1,
    suite: SUITE,
    workbookKeyVersion,
    recipientKeyVersion: recipient.keyVersion,
    recipientFingerprint: recipient.fingerprint,
    encapsulatedKey: ephemeral.generateKeys().toString("base64url"),
    ciphertext: Buffer.alloc(48, workbookKeyVersion).toString("base64url"),
  };
}

/**
 * This test is opt-in because the normal unit suite must run without Docker.
 * The milestone verifier enables it against disposable, fixed UUID fixtures
 * and removes them afterward, proving the real SQL transitions and constraints.
 */
runDatabaseIntegration("PostgresWorkbookSecurityRepository", () => {
  beforeAll(async () => {
    // Vitest's package root is `apps/api`, while the development database
    // credential lives in the repository-root `.env`. Node 24 loads it without
    // printing or copying any secret into a command-line argument.
    loadEnvFile(fileURLToPath(new URL("../../../../.env", import.meta.url)));
    pool = new Pool({
      host: process.env.ZEROSHEET_DB_HOST ?? "127.0.0.1",
      port: Number(process.env.ZEROSHEET_DB_PORT ?? "5434"),
      database: process.env.ZEROSHEET_DB_NAME ?? "zerosheet",
      user: process.env.ZEROSHEET_DB_USER ?? "zerosheet_app",
      password: process.env.ZEROSHEET_DB_PASSWORD,
      max: 3,
    });
    repository = new PostgresWorkbookSecurityRepository(pool);
    await cleanup();
    await repository.assertReady();

    await pool.query(
      `
        INSERT INTO product_users (
          id, primary_email, display_name, account_status, created_at, updated_at
        )
        VALUES
          ($1, 'owner-integration@zerosheet.local', 'Owner', 'active', $3, $3),
          ($2, 'recipient-integration@zerosheet.local', 'Recipient', 'active', $3, $3)
      `,
      [ownerId, recipientId, now],
    );
    for (const operationId of [
      organizationOperationId,
      workbookOperationId,
      shareOperationId,
    ]) {
      await pool.query(
        `
          INSERT INTO relationship_outbox (
            id, writes, deletes, status, next_attempt_at, created_at, applied_at
          )
          VALUES ($1, '[{}]'::jsonb, '[]'::jsonb, 'applied', $2, $2, $2)
        `,
        [operationId, now],
      );
    }
    await pool.query(
      `
        INSERT INTO organizations (
          id, name, created_by, authorization_state,
          authorization_operation_id, tenant_status, created_at, updated_at
        )
        VALUES ($1, 'Integration Org', $2, 'active', $3, 'active', $4, $4)
      `,
      [organizationId, ownerId, organizationOperationId, now],
    );
    await pool.query(
      `
        INSERT INTO workbooks (
          id, organization_id, name, created_by, authorization_state,
          authorization_operation_id, created_at, updated_at
        )
        VALUES ($1, $2, 'Integration Workbook', $3, 'active', $4, $5, $5)
      `,
      [workbookId, organizationId, ownerId, workbookOperationId, now],
    );
  });

  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  it("persists creator/recipient envelopes and a resumable rotation", async () => {
    const ownerKey = publicKey();
    const recipientKey = publicKey();
    await repository.registerIdentity({
      userId: ownerId,
      publicKey: ownerKey,
      encryptedPrivateKeyBackup: new Uint8Array([90, 83, 1, 1]),
      now,
    });
    await repository.registerIdentity({
      userId: recipientId,
      publicKey: recipientKey,
      encryptedPrivateKeyBackup: new Uint8Array([90, 83, 1, 2]),
      now,
    });
    await repository.initializeWorkbook({
      actorId: ownerId,
      workbookId,
      googleSpreadsheetId: "1Integration_Spreadsheet_123",
      googleSheetId: 1938472,
      googleSheetTitle: "Customers",
      creatorEnvelope: envelope(ownerKey, 1),
      now,
    });
    await repository.storeSecureShareMaterial({
      workbookId,
      recipientUserId: recipientId,
      googlePermissionId: "1Integration_Permission_123",
      recipientEnvelope: envelope(recipientKey, 1),
      now,
    });
    await pool.query(
      `
        INSERT INTO workbook_user_shares (
          workbook_id, user_id, role, authorization_state,
          authorization_operation_id, created_at, updated_at
        )
        VALUES ($1, $2, 'viewer', 'active', $3, $4, $4)
      `,
      [workbookId, recipientId, shareOperationId, now],
    );

    await expect(
      repository.listSharingAuditExpectation(workbookId),
    ).resolves.toEqual({
      workbookId,
      googleSpreadsheetId: "1Integration_Spreadsheet_123",
      expectedPermissions: [
        {
          userId: recipientId,
          email: "recipient-integration@zerosheet.local",
          role: "viewer",
          googlePermissionId: "1Integration_Permission_123",
        },
      ],
    });

    await expect(
      repository.findWorkbookAccess(workbookId, recipientId),
    ).resolves.toMatchObject({ activeKeyVersion: 1, pendingRotation: null });
    const plan = await repository.createRotationPlan(workbookId, recipientId);
    expect(plan).toMatchObject({
      fromKeyVersion: 1,
      toKeyVersion: 2,
      rotationState: "new",
      remainingRecipients: [{ userId: ownerId }],
    });

    await repository.stageRotation({
      actorId: ownerId,
      workbookId,
      revokedUserId: recipientId,
      toKeyVersion: 2,
      remainingRecipientEnvelopes: [
        { userId: ownerId, envelope: envelope(ownerKey, 2) },
      ],
      now: new Date(now.getTime() + 1_000),
    });
    await expect(
      repository.findWorkbookAccess(workbookId, ownerId),
    ).resolves.toMatchObject({
      activeKeyVersion: 1,
      pendingRotation: { toKeyVersion: 2 },
    });
    await expect(
      repository.createRotationPlan(workbookId, recipientId),
    ).resolves.toMatchObject({ rotationState: "pending", toKeyVersion: 2 });

    await expect(
      repository.commitRotation({
        actorId: ownerId,
        workbookId,
        toKeyVersion: 2,
        now: new Date(now.getTime() + 2_000),
      }),
    ).resolves.toMatchObject({ state: "committed", toKeyVersion: 2 });
    await expect(
      repository.findWorkbookAccess(workbookId, ownerId),
    ).resolves.toMatchObject({ activeKeyVersion: 2, pendingRotation: null });
  });
});

async function cleanup(): Promise<void> {
  if (!pool) return;
  await pool.query("DELETE FROM organizations WHERE id = $1", [organizationId]);
  await pool.query(
    "DELETE FROM relationship_outbox WHERE id = ANY($1::uuid[])",
    [[organizationOperationId, workbookOperationId, shareOperationId]],
  );
  await pool.query(
    "DELETE FROM user_encryption_keys WHERE user_id = ANY($1::uuid[])",
    [[ownerId, recipientId]],
  );
  await pool.query("DELETE FROM product_users WHERE id = ANY($1::uuid[])", [
    [ownerId, recipientId],
  ]);
}
