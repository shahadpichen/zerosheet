import type { Pool, PoolClient } from "pg";
import { LifecycleConflictError } from "./errors.js";
import type {
  CreateScimConnectionRecordInput,
  CreateScimManagedUserInput,
  LifecycleRepository,
  ReplaceScimManagedUserInput,
  ScimConnection,
  ScimManagedUser,
  ScimUserFilter,
} from "./types.js";

interface ConnectionRow {
  id: string;
  organization_id: string;
  display_name: string;
  active: boolean;
}

interface ManagedUserRow {
  id: string;
  connection_id: string;
  organization_id: string;
  product_user_id: string;
  external_id: string;
  user_name: string;
  display_name: string;
  active: boolean;
  version: string;
  created_at: Date;
  updated_at: Date;
}

/**
 * This adapter treats one SCIM connection as one tenant-scoped directory
 * authority. Every user query includes connection_id, preventing a valid token
 * for one organization from discovering another tenant's provisioning state.
 */
export class PostgresLifecycleRepository implements LifecycleRepository {
  public constructor(private readonly pool: Pool) {}

  public async assertReady(): Promise<void> {
    const result = await this.pool.query<{ present: boolean }>(
      `
        SELECT EXISTS (
          SELECT 1 FROM schema_migrations
          WHERE version = '004_enterprise_lifecycle_audit'
        ) AS present
      `,
    );

    if (result.rows[0]?.present !== true) {
      throw new Error(
        "The enterprise lifecycle migration is missing; run pnpm infra:db:migrate",
      );
    }
  }

  public async createConnection(
    input: CreateScimConnectionRecordInput,
  ): Promise<ScimConnection> {
    const result = await this.pool.query<ConnectionRow>(
      `
        INSERT INTO scim_connections (
          id,
          organization_id,
          display_name,
          token_hash,
          token_hint,
          active,
          created_by,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, true, $6, $7, $7)
        RETURNING id, organization_id, display_name, active
      `,
      [
        input.id,
        input.organizationId,
        input.displayName,
        input.tokenHash,
        input.tokenHint,
        input.createdBy,
        input.now,
      ],
    );

    return this.mapConnection(result.rows[0]);
  }

  public async findConnectionByTokenHash(
    tokenHash: string,
  ): Promise<ScimConnection | null> {
    const result = await this.pool.query<ConnectionRow>(
      `
        SELECT id, organization_id, display_name, active
        FROM scim_connections
        WHERE token_hash = $1 AND active = true
      `,
      [tokenHash],
    );
    return result.rows[0] ? this.mapConnection(result.rows[0]) : null;
  }

  public async createManagedUser(
    input: CreateScimManagedUserInput,
  ): Promise<ScimManagedUser> {
    try {
      return await this.transaction(async (client) => {
        await client.query(
          `
            INSERT INTO product_users (
              id,
              primary_email,
              display_name,
              created_at,
              updated_at
            )
            VALUES ($1, $2, $3, $4, $4)
          `,
          [input.productUserId, input.userName, input.displayName, input.now],
        );
        const result = await client.query<ManagedUserRow>(
          `
            INSERT INTO scim_managed_users (
              id,
              connection_id,
              organization_id,
              product_user_id,
              external_id,
              user_name,
              display_name,
              active,
              created_at,
              updated_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
            RETURNING *
          `,
          [
            input.id,
            input.connection.id,
            input.connection.organizationId,
            input.productUserId,
            input.externalId,
            input.userName,
            input.displayName,
            input.active,
            input.now,
          ],
        );
        await this.upsertTenantStatus(
          client,
          input.connection.organizationId,
          input.productUserId,
          input.active,
          input.connection.id,
          input.now,
        );

        return this.mapUser(result.rows[0]);
      });
    } catch (error) {
      this.translateUniqueViolation(error);
      throw error;
    }
  }

  public async replaceManagedUser(
    input: ReplaceScimManagedUserInput,
  ): Promise<ScimManagedUser | null> {
    try {
      return await this.transaction(async (client) => {
        const existing = await client.query<ManagedUserRow>(
          `
            SELECT * FROM scim_managed_users
            WHERE id = $1 AND connection_id = $2
            FOR UPDATE
          `,
          [input.id, input.connection.id],
        );
        const row = existing.rows[0];
        if (!row) return null;

        await client.query(
          `
            UPDATE product_users
            SET primary_email = $1,
                display_name = $2,
                updated_at = $3
            WHERE id = $4
          `,
          [input.userName, input.displayName, input.now, row.product_user_id],
        );
        const updated = await client.query<ManagedUserRow>(
          `
            UPDATE scim_managed_users
            SET external_id = $1,
                user_name = $2,
                display_name = $3,
                active = $4,
                version = version + 1,
                updated_at = $5
            WHERE id = $6 AND connection_id = $7
            RETURNING *
          `,
          [
            input.externalId,
            input.userName,
            input.displayName,
            input.active,
            input.now,
            input.id,
            input.connection.id,
          ],
        );
        await this.upsertTenantStatus(
          client,
          input.connection.organizationId,
          row.product_user_id,
          input.active,
          input.connection.id,
          input.now,
        );

        if (!input.active) {
          // Session rows are global in this architecture. Revoking them is the
          // safer enterprise-leaver behavior; another tenant relationship can
          // still be used after the person authenticates again there.
          await client.query("DELETE FROM user_sessions WHERE user_id = $1", [
            row.product_user_id,
          ]);
        }

        return this.mapUser(updated.rows[0]);
      });
    } catch (error) {
      this.translateUniqueViolation(error);
      throw error;
    }
  }

  public async findManagedUser(
    connectionId: string,
    id: string,
  ): Promise<ScimManagedUser | null> {
    const result = await this.pool.query<ManagedUserRow>(
      "SELECT * FROM scim_managed_users WHERE id = $1 AND connection_id = $2",
      [id, connectionId],
    );
    return result.rows[0] ? this.mapUser(result.rows[0]) : null;
  }

  public async listManagedUsers(
    connectionId: string,
    filter?: ScimUserFilter,
  ): Promise<ScimManagedUser[]> {
    const attribute = filter?.attribute;
    const result = await this.pool.query<ManagedUserRow>(
      `
        SELECT * FROM scim_managed_users
        WHERE connection_id = $1
          AND ($2::text IS NULL OR
            CASE $2
              WHEN 'externalId' THEN external_id = $3
              WHEN 'userName' THEN lower(user_name) = lower($3)
              ELSE false
            END)
        ORDER BY created_at, id
        LIMIT 200
      `,
      [connectionId, attribute ?? null, filter?.value ?? null],
    );
    return result.rows.map((row) => this.mapUser(row));
  }

  private async upsertTenantStatus(
    client: PoolClient,
    organizationId: string,
    userId: string,
    active: boolean,
    connectionId: string,
    now: Date,
  ): Promise<void> {
    await client.query(
      `
        INSERT INTO organization_user_lifecycle (
          organization_id,
          user_id,
          status,
          source,
          source_connection_id,
          updated_at
        )
        VALUES ($1, $2, $3, 'scim', $4, $5)
        ON CONFLICT (organization_id, user_id) DO UPDATE
        SET status = EXCLUDED.status,
            source = 'scim',
            source_connection_id = EXCLUDED.source_connection_id,
            updated_at = EXCLUDED.updated_at
      `,
      [
        organizationId,
        userId,
        active ? "active" : "suspended",
        connectionId,
        now,
      ],
    );
  }

  private mapConnection(row: ConnectionRow | undefined): ScimConnection {
    if (!row) throw new Error("SCIM connection write returned no row.");
    return {
      id: row.id,
      organizationId: row.organization_id,
      displayName: row.display_name,
      active: row.active,
    };
  }

  private mapUser(row: ManagedUserRow | undefined): ScimManagedUser {
    if (!row) throw new Error("SCIM user write returned no row.");
    return {
      id: row.id,
      connectionId: row.connection_id,
      organizationId: row.organization_id,
      productUserId: row.product_user_id,
      externalId: row.external_id,
      userName: row.user_name,
      displayName: row.display_name,
      active: row.active,
      version: Number(row.version),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private translateUniqueViolation(error: unknown): void {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "23505"
    ) {
      throw new LifecycleConflictError();
    }
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
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the state-transition error rather than replacing it with a
        // secondary rollback failure from an already-broken connection.
      }
      throw error;
    } finally {
      client.release();
    }
  }
}
