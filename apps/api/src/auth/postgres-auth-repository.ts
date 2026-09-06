import type { AuthenticatedUser } from "@zerosheet/contracts";
import type { Pool, PoolClient } from "pg";
import type {
  AuthRepository,
  CreateSessionInput,
  SaveLoginTransactionInput,
  StoredLoginTransaction,
  UpsertExternalIdentityInput,
} from "./types.js";

interface UserRow {
  id: string;
  email: string;
  display_name: string;
}

interface LoginTransactionRow {
  state: string;
  nonce: string;
  code_verifier: string;
}

/**
 * PostgreSQL implements the durable side of the BFF pattern. Keycloak remains
 * the authority for authentication, while these tables connect its stable
 * `(issuer, subject)` identity to a ZeroSheet product user and opaque session.
 */
export class PostgresAuthRepository implements AuthRepository {
  public constructor(private readonly pool: Pool) {}

  public async assertReady(): Promise<void> {
    const table = await this.pool.query<{ name: string | null }>(
      "SELECT to_regclass('public.schema_migrations')::text AS name",
    );

    if (!table.rows[0]?.name) {
      throw new Error(
        "The OIDC BFF database migration is missing; run pnpm infra:db:migrate",
      );
    }

    const result = await this.pool.query<{ present: boolean }>(
      `
        SELECT EXISTS (
          SELECT 1
          FROM schema_migrations
          WHERE version = '001_oidc_bff_authentication'
        ) AS present
      `,
    );

    if (result.rows[0]?.present !== true) {
      throw new Error(
        "The OIDC BFF database migration is missing; run pnpm infra:db:migrate",
      );
    }
  }

  public async saveLoginTransaction(
    input: SaveLoginTransactionInput,
  ): Promise<void> {
    /**
     * Expired rows are cheap to remove here because a login already performs a
     * write. A worker will own general retention later; this bounded cleanup
     * prevents abandoned browser redirects accumulating during Milestone 2.
     */
    await this.pool.query(
      `
        DELETE FROM oidc_login_transactions
        WHERE expires_at <= $1
      `,
      [input.createdAt],
    );

    await this.pool.query(
      `
        INSERT INTO oidc_login_transactions (
          selector_hash,
          state,
          nonce,
          code_verifier,
          created_at,
          expires_at
        )
        VALUES ($1, $2, $3, $4, $5, $6)
      `,
      [
        input.selectorHash,
        input.state,
        input.nonce,
        input.codeVerifier,
        input.createdAt,
        input.expiresAt,
      ],
    );
  }

  public async consumeLoginTransaction(
    selectorHash: string,
    state: string,
    now: Date,
  ): Promise<StoredLoginTransaction | null> {
    /**
     * DELETE ... RETURNING is atomic. Only one concurrent callback can receive
     * this transaction, and both the hashed browser selector and OIDC state
     * must match before PostgreSQL releases the PKCE verifier and nonce.
     */
    const result = await this.pool.query<LoginTransactionRow>(
      `
        DELETE FROM oidc_login_transactions
        WHERE selector_hash = $1
          AND state = $2
          AND expires_at > $3
        RETURNING state, nonce, code_verifier
      `,
      [selectorHash, state, now],
    );
    const row = result.rows[0];

    if (!row) {
      return null;
    }

    return {
      state: row.state,
      nonce: row.nonce,
      codeVerifier: row.code_verifier,
    };
  }

  public async upsertExternalIdentity(
    input: UpsertExternalIdentityInput,
  ): Promise<AuthenticatedUser> {
    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");

      /**
       * The transaction-scoped advisory lock serializes first login for the
       * same external identity. Without it, two callbacks could both observe no
       * mapping, create two product users, and race on the unique constraint.
       * The lock key is derived inside PostgreSQL and is released at COMMIT.
       *
       * PostgreSQL `text` cannot contain a zero byte. Do not join issuer and
       * subject with `\u0000`, even though that separator is common in in-memory
       * code: the database rejects the parameter before hashing it. A JSON
       * array preserves the two string boundaries without introducing a byte
       * that PostgreSQL cannot encode, so pairs such as (`ab`, `c`) and (`a`,
       * `bc`) cannot accidentally acquire the same pre-hash representation.
       */
      await client.query(
        `
          SELECT pg_advisory_xact_lock(
            hashtextextended(
              jsonb_build_array($1::text, $2::text)::text,
              0
            )
          )
        `,
        [input.issuer, input.subject],
      );

      const existing = await this.findIdentityUser(
        client,
        input.issuer,
        input.subject,
      );

      if (existing) {
        await client.query(
          `
            UPDATE external_identities
            SET email_at_provider = $1,
                email_verified = $2,
                last_login_at = $3
            WHERE issuer = $4 AND subject = $5
          `,
          [
            input.email,
            input.emailVerified,
            input.now,
            input.issuer,
            input.subject,
          ],
        );
        const updated = await this.updateProductUser(
          client,
          existing.id,
          input,
        );

        await client.query("COMMIT");
        return updated;
      }

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
        [input.candidateUserId, input.email, input.displayName, input.now],
      );

      /**
       * We never link accounts merely because two providers return the same
       * email address. Only the verified `(issuer, subject)` pair identifies an
       * existing login. Explicit, authenticated account linking comes later.
       */
      await client.query(
        `
          INSERT INTO external_identities (
            user_id,
            issuer,
            subject,
            email_at_provider,
            email_verified,
            created_at,
            last_login_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $6)
        `,
        [
          input.candidateUserId,
          input.issuer,
          input.subject,
          input.email,
          input.emailVerified,
          input.now,
        ],
      );

      await client.query("COMMIT");

      return {
        id: input.candidateUserId,
        email: input.email,
        displayName: input.displayName,
      };
    } catch (error) {
      await this.rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  public async createSession(input: CreateSessionInput): Promise<void> {
    await this.pool.query(
      `
        INSERT INTO user_sessions (
          selector_hash,
          user_id,
          created_at,
          expires_at
        )
        VALUES ($1, $2, $3, $4)
      `,
      [input.selectorHash, input.userId, input.createdAt, input.expiresAt],
    );
  }

  public async findSessionUser(
    selectorHash: string,
    now: Date,
  ): Promise<AuthenticatedUser | null> {
    const result = await this.pool.query<UserRow>(
      `
        SELECT
          product_users.id,
          product_users.primary_email AS email,
          product_users.display_name
        FROM user_sessions
        INNER JOIN product_users
          ON product_users.id = user_sessions.user_id
        WHERE user_sessions.selector_hash = $1
          AND user_sessions.expires_at > $2
      `,
      [selectorHash, now],
    );

    return this.mapUser(result.rows[0]);
  }

  public async deleteSession(selectorHash: string): Promise<void> {
    // Logout is idempotent: deleting a missing or already-expired session still
    // leaves the caller safely logged out.
    await this.pool.query(
      "DELETE FROM user_sessions WHERE selector_hash = $1",
      [selectorHash],
    );
  }

  private async findIdentityUser(
    client: PoolClient,
    issuer: string,
    subject: string,
  ): Promise<AuthenticatedUser | null> {
    const result = await client.query<UserRow>(
      `
        SELECT
          product_users.id,
          product_users.primary_email AS email,
          product_users.display_name
        FROM external_identities
        INNER JOIN product_users
          ON product_users.id = external_identities.user_id
        WHERE external_identities.issuer = $1
          AND external_identities.subject = $2
      `,
      [issuer, subject],
    );

    return this.mapUser(result.rows[0]);
  }

  private async updateProductUser(
    client: PoolClient,
    userId: string,
    input: UpsertExternalIdentityInput,
  ): Promise<AuthenticatedUser> {
    const result = await client.query<UserRow>(
      `
        UPDATE product_users
        SET primary_email = $1,
            display_name = $2,
            updated_at = $3
        WHERE id = $4
        RETURNING id, primary_email AS email, display_name
      `,
      [input.email, input.displayName, input.now, userId],
    );
    const user = this.mapUser(result.rows[0]);

    if (!user) {
      throw new Error("The mapped ZeroSheet user no longer exists");
    }

    return user;
  }

  private mapUser(row: UserRow | undefined): AuthenticatedUser | null {
    if (!row) {
      return null;
    }

    return {
      id: row.id,
      email: row.email,
      displayName: row.display_name,
    };
  }

  private async rollback(client: PoolClient): Promise<void> {
    try {
      await client.query("ROLLBACK");
    } catch {
      // The original database exception is more useful than a secondary error
      // saying an already-broken connection could not roll back.
    }
  }
}
