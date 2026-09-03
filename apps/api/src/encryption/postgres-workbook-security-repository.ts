import type {
  EncryptionIdentityResponse,
  RecipientEncryptionKeyResponse,
  UserPublicEncryptionKey,
  WorkbookEncryptionAccessResponse,
  WorkbookEncryptionStateResponse,
  WorkbookKeyEnvelope,
  WorkbookRotationResponse,
  WorkbookRotationPlanResponse,
} from "@zerosheet/contracts";
import type { Pool, PoolClient } from "pg";
import {
  ProductConflictError,
  ProductForbiddenError,
  ProductNotFoundError,
} from "../product/errors.js";
import type {
  CommitRotationRecordInput,
  InitializeWorkbookRecordInput,
  RegisterIdentityRecordInput,
  StageRotationRecordInput,
  StoreSecureShareMaterialInput,
  WorkbookSecurityRepository,
} from "./types.js";
import { assertEnvelopeMatches } from "./validation.js";

interface EncryptionKeyRow {
  user_id: string;
  email?: string;
  key_version: number;
  format_version: 1;
  suite: UserPublicEncryptionKey["suite"];
  public_key: string;
  fingerprint: string;
  encrypted_private_key_backup: Buffer;
}

interface WorkbookEncryptionRow {
  workbook_id: string;
  google_spreadsheet_id: string;
  google_sheet_id: number;
  google_sheet_title: string;
  active_key_version: number;
  pending_key_version: number | null;
  rotation_state: "active" | "rotation_pending";
}

interface EnvelopeRow {
  format_version: 1;
  suite: WorkbookKeyEnvelope["suite"];
  workbook_key_version: number;
  recipient_key_version: number;
  recipient_fingerprint: string;
  encapsulated_key: string;
  ciphertext: string;
}

interface RotationRow {
  workbook_id: string;
  from_key_version: number;
  to_key_version: number;
  revoked_user_id: string;
  state: "pending" | "committed";
}

/**
 * PostgreSQL is a directory and encrypted-envelope store, never a key server.
 * Every multi-row transition is locally atomic; external Google/OpenFGA work is
 * coordinated by the service with fail-closed ordering and idempotent retries.
 */
export class PostgresWorkbookSecurityRepository implements WorkbookSecurityRepository {
  public constructor(private readonly pool: Pool) {}

  public async assertReady(): Promise<void> {
    const result = await this.pool.query<{ present: boolean }>(
      `
        SELECT EXISTS (
          SELECT 1
          FROM schema_migrations
          WHERE version = '006_workbook_key_sharing'
        ) AS present
      `,
    );
    if (result.rows[0]?.present !== true) {
      throw new Error(
        "The workbook key-sharing migration is missing; run pnpm infra:db:migrate",
      );
    }
  }

  public async registerIdentity(
    input: RegisterIdentityRecordInput,
  ): Promise<EncryptionIdentityResponse> {
    return this.transaction(async (client) => {
      const user = await client.query(
        "SELECT 1 FROM product_users WHERE id = $1 FOR UPDATE",
        [input.userId],
      );
      if (user.rowCount !== 1) throw new ProductNotFoundError();

      const existing = await client.query<EncryptionKeyRow>(
        `
          SELECT user_id,
                 key_version,
                 format_version,
                 suite,
                 public_key,
                 fingerprint,
                 encrypted_private_key_backup
          FROM user_encryption_keys
          WHERE user_id = $1 AND retired_at IS NULL
          FOR UPDATE
        `,
        [input.userId],
      );
      const current = existing.rows[0];

      if (current && this.sameIdentity(current, input)) {
        return this.identity(current);
      }
      const requiredVersion = current ? current.key_version + 1 : 1;
      if (input.publicKey.keyVersion !== requiredVersion) {
        throw new ProductConflictError(
          `The next encryption key version must be ${requiredVersion}.`,
        );
      }

      if (current) {
        await client.query(
          `
            UPDATE user_encryption_keys
            SET retired_at = $2
            WHERE user_id = $1 AND retired_at IS NULL
          `,
          [input.userId, input.now],
        );
      }
      const inserted = await client.query<EncryptionKeyRow>(
        `
          INSERT INTO user_encryption_keys (
            user_id,
            key_version,
            format_version,
            suite,
            public_key,
            fingerprint,
            encrypted_private_key_backup,
            created_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          RETURNING user_id,
                    key_version,
                    format_version,
                    suite,
                    public_key,
                    fingerprint,
                    encrypted_private_key_backup
        `,
        [
          input.userId,
          input.publicKey.keyVersion,
          input.publicKey.formatVersion,
          input.publicKey.suite,
          input.publicKey.publicKey,
          input.publicKey.fingerprint,
          Buffer.from(input.encryptedPrivateKeyBackup),
          input.now,
        ],
      );
      return this.identity(inserted.rows[0] as EncryptionKeyRow);
    });
  }

  public async findCurrentIdentity(
    userId: string,
  ): Promise<EncryptionIdentityResponse | null> {
    const result = await this.pool.query<EncryptionKeyRow>(
      `
        SELECT user_id,
               key_version,
               format_version,
               suite,
               public_key,
               fingerprint,
               encrypted_private_key_backup
        FROM user_encryption_keys
        WHERE user_id = $1 AND retired_at IS NULL
      `,
      [userId],
    );
    return result.rows[0] ? this.identity(result.rows[0]) : null;
  }

  public async findIdentity(
    userId: string,
    keyVersion: number,
  ): Promise<EncryptionIdentityResponse | null> {
    const result = await this.pool.query<EncryptionKeyRow>(
      `
        SELECT user_id,
               key_version,
               format_version,
               suite,
               public_key,
               fingerprint,
               encrypted_private_key_backup
        FROM user_encryption_keys
        WHERE user_id = $1 AND key_version = $2
      `,
      [userId, keyVersion],
    );
    return result.rows[0] ? this.identity(result.rows[0]) : null;
  }

  public async findRecipientIdentity(
    userId: string,
  ): Promise<RecipientEncryptionKeyResponse | null> {
    const result = await this.pool.query<EncryptionKeyRow>(
      `
        SELECT encryption_key.user_id,
               product_user.primary_email AS email,
               encryption_key.key_version,
               encryption_key.format_version,
               encryption_key.suite,
               encryption_key.public_key,
               encryption_key.fingerprint,
               encryption_key.encrypted_private_key_backup
        FROM user_encryption_keys AS encryption_key
        INNER JOIN product_users AS product_user
          ON product_user.id = encryption_key.user_id
        WHERE encryption_key.user_id = $1
          AND encryption_key.retired_at IS NULL
          AND product_user.account_status = 'active'
      `,
      [userId],
    );
    const row = result.rows[0];
    return row
      ? {
          userId: row.user_id,
          email: row.email as string,
          publicKey: this.publicKey(row),
        }
      : null;
  }

  public async initializeWorkbook(
    input: InitializeWorkbookRecordInput,
  ): Promise<WorkbookEncryptionStateResponse> {
    return this.transaction(async (client) => {
      const workbook = await client.query<{ created_by: string }>(
        `
          SELECT created_by
          FROM workbooks
          WHERE id = $1 AND authorization_state = 'active'
          FOR UPDATE
        `,
        [input.workbookId],
      );
      const creatorId = workbook.rows[0]?.created_by;
      if (!creatorId) throw new ProductNotFoundError();
      if (creatorId !== input.actorId) throw new ProductForbiddenError();

      const existing = await client.query<WorkbookEncryptionRow>(
        "SELECT * FROM workbook_encryption WHERE workbook_id = $1 FOR UPDATE",
        [input.workbookId],
      );
      if (existing.rows[0]) {
        const state = this.state(existing.rows[0]);
        if (
          state.googleSpreadsheetId !== input.googleSpreadsheetId ||
          state.googleSheetId !== input.googleSheetId ||
          state.googleSheetTitle !== input.googleSheetTitle
        ) {
          throw new ProductConflictError(
            "This workbook is already bound to a different Google Sheet.",
          );
        }
        return state;
      }

      const identity = await this.currentKeyForUpdate(client, creatorId);
      if (!identity) throw new ProductConflictError();
      assertEnvelopeMatches({
        envelope: input.creatorEnvelope,
        workbookKeyVersion: 1,
        recipient: this.publicKey(identity),
      });

      const inserted = await client.query<WorkbookEncryptionRow>(
        `
          INSERT INTO workbook_encryption (
            workbook_id,
            google_spreadsheet_id,
            google_sheet_id,
            google_sheet_title,
            active_key_version,
            pending_key_version,
            rotation_state,
            created_at,
            updated_at
          )
          VALUES ($1, $2, $3, $4, 1, NULL, 'active', $5, $5)
          RETURNING *
        `,
        [
          input.workbookId,
          input.googleSpreadsheetId,
          input.googleSheetId,
          input.googleSheetTitle,
          input.now,
        ],
      );
      await this.insertEnvelope(
        client,
        input.workbookId,
        creatorId,
        input.creatorEnvelope,
        input.now,
      );
      return this.state(inserted.rows[0] as WorkbookEncryptionRow);
    });
  }

  public async findWorkbookAccess(
    workbookId: string,
    userId: string,
  ): Promise<WorkbookEncryptionAccessResponse | null> {
    const stateResult = await this.pool.query<WorkbookEncryptionRow>(
      "SELECT * FROM workbook_encryption WHERE workbook_id = $1",
      [workbookId],
    );
    const row = stateResult.rows[0];
    if (!row) return null;

    const versions = [
      row.active_key_version,
      ...(row.pending_key_version === null ? [] : [row.pending_key_version]),
    ];
    const envelopes = await this.pool.query<EnvelopeRow>(
      `
        SELECT format_version,
               suite,
               workbook_key_version,
               recipient_key_version,
               recipient_fingerprint,
               encapsulated_key,
               ciphertext
        FROM workbook_key_envelopes
        WHERE workbook_id = $1
          AND recipient_user_id = $2
          AND workbook_key_version = ANY($3::integer[])
      `,
      [workbookId, userId, versions],
    );
    const byVersion = new Map(
      envelopes.rows.map((envelope) => [
        envelope.workbook_key_version,
        this.envelope(envelope),
      ]),
    );
    const active = byVersion.get(row.active_key_version);
    if (!active) return null;

    return {
      workbookId,
      googleSpreadsheetId: row.google_spreadsheet_id,
      googleSheetId: row.google_sheet_id,
      googleSheetTitle: row.google_sheet_title,
      activeKeyVersion: row.active_key_version,
      envelope: active,
      pendingRotation:
        row.pending_key_version === null ||
        !byVersion.has(row.pending_key_version)
          ? null
          : {
              toKeyVersion: row.pending_key_version,
              envelope: byVersion.get(
                row.pending_key_version,
              ) as WorkbookKeyEnvelope,
            },
    };
  }

  /**
   * Return the exact active Drive permissions ZeroSheet knows about. Missing
   * permission/envelope records are intentionally absent here and counted by
   * the aggregate worker; the browser compares these IDs with Google's live
   * list without sending that provider list back to the API.
   */
  public async listSharingAuditExpectation(workbookId: string) {
    const workbook = await this.pool.query<{ google_spreadsheet_id: string }>(
      `
        SELECT google_spreadsheet_id
        FROM workbook_encryption
        WHERE workbook_id = $1
      `,
      [workbookId],
    );
    const googleSpreadsheetId = workbook.rows[0]?.google_spreadsheet_id;
    if (!googleSpreadsheetId) throw new ProductNotFoundError();

    const permissions = await this.pool.query<{
      user_id: string;
      email: string;
      role: "editor" | "viewer";
      permission_id: string;
    }>(
      `
        SELECT share.user_id,
               product_user.primary_email AS email,
               share.role,
               permission.permission_id
        FROM workbook_user_shares AS share
        INNER JOIN product_users AS product_user
          ON product_user.id = share.user_id
        INNER JOIN workbook_google_permissions AS permission
          ON permission.workbook_id = share.workbook_id
         AND permission.user_id = share.user_id
         AND permission.revoked_at IS NULL
        WHERE share.workbook_id = $1
          AND share.authorization_state = 'active'
        ORDER BY share.user_id
        LIMIT 10000
      `,
      [workbookId],
    );

    return {
      workbookId,
      googleSpreadsheetId,
      expectedPermissions: permissions.rows.map((permission) => ({
        userId: permission.user_id,
        email: permission.email,
        role: permission.role,
        googlePermissionId: permission.permission_id,
      })),
    };
  }

  public async createRotationPlan(
    workbookId: string,
    revokedUserId: string,
  ): Promise<WorkbookRotationPlanResponse> {
    return this.transaction(async (client) => {
      const state = await this.lockWorkbookEncryption(client, workbookId);
      let rotationState: "new" | "pending" = "new";
      if (state.rotation_state === "rotation_pending") {
        const pending = await client.query<RotationRow>(
          `
            SELECT workbook_id,
                   from_key_version,
                   to_key_version,
                   revoked_user_id,
                   state
            FROM workbook_key_rotations
            WHERE workbook_id = $1 AND state = 'pending'
            FOR SHARE
          `,
          [workbookId],
        );
        if (pending.rows[0]?.revoked_user_id !== revokedUserId) {
          throw new ProductConflictError(
            "A different workbook-key rotation is already pending.",
          );
        }
        rotationState = "pending";
      }
      await this.requireNoActiveTeamShares(client, workbookId);

      const permission = await client.query<{ permission_id: string }>(
        `
          SELECT permission.permission_id
          FROM workbook_google_permissions AS permission
          INNER JOIN workbook_user_shares AS share
            ON share.workbook_id = permission.workbook_id
           AND share.user_id = permission.user_id
          WHERE permission.workbook_id = $1
            AND permission.user_id = $2
            AND permission.revoked_at IS NULL
            AND share.authorization_state = 'active'
          FOR SHARE OF permission, share
        `,
        [workbookId, revokedUserId],
      );
      const permissionId = permission.rows[0]?.permission_id;
      if (!permissionId) throw new ProductNotFoundError();

      const recipients = await client.query<EncryptionKeyRow>(
        `
          WITH remaining_users AS (
            SELECT created_by AS user_id
            FROM workbooks
            WHERE id = $1 AND authorization_state = 'active'
            UNION
            SELECT user_id
            FROM workbook_user_shares
            WHERE workbook_id = $1
              AND authorization_state = 'active'
              AND user_id <> $2
          )
          SELECT encryption_key.user_id,
                 product_user.primary_email AS email,
                 encryption_key.key_version,
                 encryption_key.format_version,
                 encryption_key.suite,
                 encryption_key.public_key,
                 encryption_key.fingerprint,
                 encryption_key.encrypted_private_key_backup
          FROM remaining_users
          INNER JOIN product_users AS product_user
            ON product_user.id = remaining_users.user_id
          INNER JOIN user_encryption_keys AS encryption_key
            ON encryption_key.user_id = remaining_users.user_id
           AND encryption_key.retired_at IS NULL
          WHERE product_user.account_status = 'active'
          ORDER BY encryption_key.user_id
          FOR SHARE OF encryption_key, product_user
        `,
        [workbookId, revokedUserId],
      );
      const expected = await client.query<{ count: number }>(
        `
          SELECT count(*)::integer AS count
          FROM (
            SELECT created_by AS user_id
            FROM workbooks
            WHERE id = $1 AND authorization_state = 'active'
            UNION
            SELECT user_id
            FROM workbook_user_shares
            WHERE workbook_id = $1
              AND authorization_state = 'active'
              AND user_id <> $2
          ) AS remaining_users
        `,
        [workbookId, revokedUserId],
      );
      if (recipients.rows.length !== expected.rows[0]?.count) {
        throw new ProductConflictError(
          "Every remaining recipient must set up an encryption identity first.",
        );
      }

      return {
        workbookId,
        fromKeyVersion: state.active_key_version,
        toKeyVersion: state.active_key_version + 1,
        revokedUserId,
        rotationState,
        googlePermissionId: permissionId,
        remainingRecipients: recipients.rows.map((recipient) => ({
          userId: recipient.user_id,
          email: recipient.email as string,
          publicKey: this.publicKey(recipient),
        })),
      };
    });
  }

  public async storeSecureShareMaterial(
    input: StoreSecureShareMaterialInput,
  ): Promise<void> {
    await this.transaction(async (client) => {
      const state = await this.lockWorkbookEncryption(client, input.workbookId);
      if (state.rotation_state !== "active") {
        throw new ProductConflictError(
          "Finish the pending key rotation before changing shares.",
        );
      }
      const recipient = await this.currentKeyForUpdate(
        client,
        input.recipientUserId,
      );
      if (!recipient) throw new ProductNotFoundError();
      assertEnvelopeMatches({
        envelope: input.recipientEnvelope,
        workbookKeyVersion: state.active_key_version,
        recipient: this.publicKey(recipient),
      });

      await this.upsertEnvelope(
        client,
        input.workbookId,
        input.recipientUserId,
        input.recipientEnvelope,
        input.now,
      );
      await client.query(
        `
          INSERT INTO workbook_google_permissions (
            workbook_id,
            user_id,
            permission_id,
            created_at,
            revoked_at
          )
          VALUES ($1, $2, $3, $4, NULL)
          ON CONFLICT (workbook_id, user_id) DO UPDATE
          SET permission_id = EXCLUDED.permission_id,
              created_at = EXCLUDED.created_at,
              revoked_at = NULL
        `,
        [
          input.workbookId,
          input.recipientUserId,
          input.googlePermissionId,
          input.now,
        ],
      );
    });
  }

  public async stageRotation(
    input: StageRotationRecordInput,
  ): Promise<WorkbookRotationResponse> {
    return this.transaction(async (client) => {
      const state = await this.lockWorkbookEncryption(client, input.workbookId);
      const existing = await client.query<RotationRow>(
        `
          SELECT workbook_id,
                 from_key_version,
                 to_key_version,
                 revoked_user_id,
                 state
          FROM workbook_key_rotations
          WHERE workbook_id = $1 AND state = 'pending'
          FOR UPDATE
        `,
        [input.workbookId],
      );
      if (existing.rows[0]) {
        const rotation = this.rotation(existing.rows[0]);
        if (
          rotation.toKeyVersion === input.toKeyVersion &&
          rotation.revokedUserId === input.revokedUserId
        ) {
          return rotation;
        }
        throw new ProductConflictError(
          "Another workbook-key rotation is already pending.",
        );
      }
      if (
        state.rotation_state !== "active" ||
        input.toKeyVersion !== state.active_key_version + 1
      ) {
        throw new ProductConflictError(
          `The next workbook key version must be ${state.active_key_version + 1}.`,
        );
      }

      const revokedShare = await client.query(
        `
          SELECT 1
          FROM workbook_user_shares
          WHERE workbook_id = $1
            AND user_id = $2
            AND authorization_state = 'active'
          FOR UPDATE
        `,
        [input.workbookId, input.revokedUserId],
      );
      if (revokedShare.rowCount !== 1) throw new ProductNotFoundError();

      // Team shares require membership-to-envelope fan-out and Google Group
      // reconciliation. Blocking rotation is safer than silently omitting a
      // team recipient or issuing an envelope to the user being revoked.
      await this.requireNoActiveTeamShares(client, input.workbookId);

      const expectedResult = await client.query<{ user_id: string }>(
        `
          SELECT created_by AS user_id
          FROM workbooks
          WHERE id = $1
          UNION
          SELECT user_id
          FROM workbook_user_shares
          WHERE workbook_id = $1
            AND authorization_state = 'active'
            AND user_id <> $2
        `,
        [input.workbookId, input.revokedUserId],
      );
      const expected = new Set(
        expectedResult.rows.map(({ user_id }) => user_id),
      );
      const provided = new Map(
        input.remainingRecipientEnvelopes.map((entry) => [entry.userId, entry]),
      );
      if (
        provided.size !== input.remainingRecipientEnvelopes.length ||
        provided.size !== expected.size ||
        [...expected].some((userId) => !provided.has(userId)) ||
        provided.has(input.revokedUserId)
      ) {
        throw new ProductConflictError(
          "The rotation envelopes must cover every remaining direct recipient exactly once.",
        );
      }

      const identities = await client.query<EncryptionKeyRow>(
        `
          SELECT user_id,
                 key_version,
                 format_version,
                 suite,
                 public_key,
                 fingerprint,
                 encrypted_private_key_backup
          FROM user_encryption_keys
          WHERE user_id = ANY($1::uuid[]) AND retired_at IS NULL
          FOR SHARE
        `,
        [[...expected]],
      );
      const keyByUser = new Map(
        identities.rows.map((key) => [key.user_id, key]),
      );
      if (keyByUser.size !== expected.size) {
        throw new ProductConflictError(
          "Every remaining recipient must set up an encryption identity first.",
        );
      }
      for (const [userId, entry] of provided) {
        const identity = keyByUser.get(userId) as EncryptionKeyRow;
        assertEnvelopeMatches({
          envelope: entry.envelope,
          workbookKeyVersion: input.toKeyVersion,
          recipient: this.publicKey(identity),
        });
      }

      await client.query(
        `
          INSERT INTO workbook_key_rotations (
            workbook_id,
            from_key_version,
            to_key_version,
            revoked_user_id,
            staged_by,
            state,
            created_at,
            committed_at
          )
          VALUES ($1, $2, $3, $4, $5, 'pending', $6, NULL)
        `,
        [
          input.workbookId,
          state.active_key_version,
          input.toKeyVersion,
          input.revokedUserId,
          input.actorId,
          input.now,
        ],
      );
      for (const entry of input.remainingRecipientEnvelopes) {
        await this.insertEnvelope(
          client,
          input.workbookId,
          entry.userId,
          entry.envelope,
          input.now,
        );
      }
      await client.query(
        `
          UPDATE workbook_encryption
          SET pending_key_version = $2,
              rotation_state = 'rotation_pending',
              updated_at = $3
          WHERE workbook_id = $1
        `,
        [input.workbookId, input.toKeyVersion, input.now],
      );

      return {
        workbookId: input.workbookId,
        fromKeyVersion: state.active_key_version,
        toKeyVersion: input.toKeyVersion,
        revokedUserId: input.revokedUserId,
        state: "pending",
      };
    });
  }

  public async commitRotation(
    input: CommitRotationRecordInput,
  ): Promise<WorkbookRotationResponse> {
    return this.transaction(async (client) => {
      const rotationResult = await client.query<RotationRow>(
        `
          SELECT workbook_id,
                 from_key_version,
                 to_key_version,
                 revoked_user_id,
                 state
          FROM workbook_key_rotations
          WHERE workbook_id = $1 AND to_key_version = $2
          FOR UPDATE
        `,
        [input.workbookId, input.toKeyVersion],
      );
      const row = rotationResult.rows[0];
      if (!row) throw new ProductNotFoundError();
      if (row.state === "committed") return this.rotation(row);

      const state = await this.lockWorkbookEncryption(client, input.workbookId);
      if (
        state.rotation_state !== "rotation_pending" ||
        state.pending_key_version !== input.toKeyVersion
      ) {
        throw new ProductConflictError();
      }
      await client.query(
        `
          UPDATE workbook_encryption
          SET active_key_version = $2,
              pending_key_version = NULL,
              rotation_state = 'active',
              updated_at = $3
          WHERE workbook_id = $1
        `,
        [input.workbookId, input.toKeyVersion, input.now],
      );
      await client.query(
        `
          UPDATE workbook_key_rotations
          SET state = 'committed', committed_at = $3
          WHERE workbook_id = $1 AND to_key_version = $2
        `,
        [input.workbookId, input.toKeyVersion, input.now],
      );
      await client.query(
        `
          UPDATE workbook_google_permissions
          SET revoked_at = $3
          WHERE workbook_id = $1 AND user_id = $2 AND revoked_at IS NULL
        `,
        [input.workbookId, row.revoked_user_id, input.now],
      );
      return {
        ...this.rotation(row),
        state: "committed",
      };
    });
  }

  private async lockWorkbookEncryption(
    client: PoolClient,
    workbookId: string,
  ): Promise<WorkbookEncryptionRow> {
    const result = await client.query<WorkbookEncryptionRow>(
      "SELECT * FROM workbook_encryption WHERE workbook_id = $1 FOR UPDATE",
      [workbookId],
    );
    const row = result.rows[0];
    if (!row) throw new ProductNotFoundError();
    return row;
  }

  private async requireNoActiveTeamShares(
    client: PoolClient,
    workbookId: string,
  ): Promise<void> {
    const teamShare = await client.query(
      `
        SELECT 1
        FROM workbook_team_shares
        WHERE workbook_id = $1 AND authorization_state = 'active'
        LIMIT 1
      `,
      [workbookId],
    );
    if (teamShare.rowCount !== 0) {
      throw new ProductConflictError(
        "Remove team shares before rotating this encrypted workbook.",
      );
    }
  }

  private async currentKeyForUpdate(
    client: PoolClient,
    userId: string,
  ): Promise<EncryptionKeyRow | null> {
    const result = await client.query<EncryptionKeyRow>(
      `
        SELECT user_id,
               key_version,
               format_version,
               suite,
               public_key,
               fingerprint,
               encrypted_private_key_backup
        FROM user_encryption_keys
        WHERE user_id = $1 AND retired_at IS NULL
        FOR SHARE
      `,
      [userId],
    );
    return result.rows[0] ?? null;
  }

  private insertEnvelope(
    client: PoolClient,
    workbookId: string,
    recipientUserId: string,
    envelope: WorkbookKeyEnvelope,
    now: Date,
  ): Promise<unknown> {
    return client.query(
      `
        INSERT INTO workbook_key_envelopes (
          workbook_id,
          workbook_key_version,
          recipient_user_id,
          recipient_key_version,
          format_version,
          suite,
          recipient_fingerprint,
          encapsulated_key,
          ciphertext,
          created_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      `,
      [
        workbookId,
        envelope.workbookKeyVersion,
        recipientUserId,
        envelope.recipientKeyVersion,
        envelope.formatVersion,
        envelope.suite,
        envelope.recipientFingerprint,
        envelope.encapsulatedKey,
        envelope.ciphertext,
        now,
      ],
    );
  }

  private upsertEnvelope(
    client: PoolClient,
    workbookId: string,
    recipientUserId: string,
    envelope: WorkbookKeyEnvelope,
    now: Date,
  ): Promise<unknown> {
    return client.query(
      `
        INSERT INTO workbook_key_envelopes (
          workbook_id,
          workbook_key_version,
          recipient_user_id,
          recipient_key_version,
          format_version,
          suite,
          recipient_fingerprint,
          encapsulated_key,
          ciphertext,
          created_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT (workbook_id, workbook_key_version, recipient_user_id)
        DO UPDATE SET
          recipient_key_version = EXCLUDED.recipient_key_version,
          format_version = EXCLUDED.format_version,
          suite = EXCLUDED.suite,
          recipient_fingerprint = EXCLUDED.recipient_fingerprint,
          encapsulated_key = EXCLUDED.encapsulated_key,
          ciphertext = EXCLUDED.ciphertext,
          created_at = EXCLUDED.created_at
      `,
      [
        workbookId,
        envelope.workbookKeyVersion,
        recipientUserId,
        envelope.recipientKeyVersion,
        envelope.formatVersion,
        envelope.suite,
        envelope.recipientFingerprint,
        envelope.encapsulatedKey,
        envelope.ciphertext,
        now,
      ],
    );
  }

  private sameIdentity(
    current: EncryptionKeyRow,
    input: RegisterIdentityRecordInput,
  ): boolean {
    return (
      current.key_version === input.publicKey.keyVersion &&
      current.format_version === input.publicKey.formatVersion &&
      current.suite === input.publicKey.suite &&
      current.public_key === input.publicKey.publicKey &&
      current.fingerprint === input.publicKey.fingerprint &&
      current.encrypted_private_key_backup.equals(
        Buffer.from(input.encryptedPrivateKeyBackup),
      )
    );
  }

  private identity(row: EncryptionKeyRow): EncryptionIdentityResponse {
    return {
      userId: row.user_id,
      publicKey: this.publicKey(row),
      encryptedPrivateKeyBackup:
        row.encrypted_private_key_backup.toString("base64url"),
    };
  }

  private publicKey(row: EncryptionKeyRow): UserPublicEncryptionKey {
    return {
      formatVersion: row.format_version,
      keyVersion: row.key_version,
      suite: row.suite,
      publicKey: row.public_key,
      fingerprint: row.fingerprint,
    };
  }

  private state(row: WorkbookEncryptionRow): WorkbookEncryptionStateResponse {
    return {
      workbookId: row.workbook_id,
      googleSpreadsheetId: row.google_spreadsheet_id,
      googleSheetId: row.google_sheet_id,
      googleSheetTitle: row.google_sheet_title,
      activeKeyVersion: row.active_key_version,
      rotationState: row.rotation_state,
      pendingKeyVersion: row.pending_key_version,
    };
  }

  private envelope(row: EnvelopeRow): WorkbookKeyEnvelope {
    return {
      formatVersion: row.format_version,
      suite: row.suite,
      workbookKeyVersion: row.workbook_key_version,
      recipientKeyVersion: row.recipient_key_version,
      recipientFingerprint: row.recipient_fingerprint,
      encapsulatedKey: row.encapsulated_key,
      ciphertext: row.ciphertext,
    };
  }

  private rotation(row: RotationRow): WorkbookRotationResponse {
    return {
      workbookId: row.workbook_id,
      fromKeyVersion: row.from_key_version,
      toKeyVersion: row.to_key_version,
      revokedUserId: row.revoked_user_id,
      state: row.state,
    };
  }

  private async transaction<T>(
    operation: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const value = await operation(client);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
