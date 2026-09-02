import type { Pool } from "pg";
import type {
  GoogleStorageConnection,
  GoogleStorageRepository,
  SaveGoogleOAuthTransactionInput,
  SaveGoogleStorageConnectionInput,
  StoredGoogleOAuthTransaction,
} from "./types.js";

interface OAuthTransactionRow {
  code_verifier: string;
}

interface GoogleStorageConnectionRow {
  user_id: string;
  encrypted_refresh_token: string;
  granted_scopes: string[];
  connected_at: Date;
}

/**
 * PostgreSQL stores one encrypted refresh-token envelope per product user. It
 * never sees the plaintext token encryption key, access tokens, OAuth codes,
 * workbook keys, recovery phrases, or cell content.
 */
export class PostgresGoogleStorageRepository implements GoogleStorageRepository {
  public constructor(private readonly pool: Pool) {}

  public async assertReady(): Promise<void> {
    const result = await this.pool.query<{ present: boolean }>(
      `
        SELECT EXISTS (
          SELECT 1
          FROM schema_migrations
          WHERE version = '005_google_storage_oauth'
        ) AS present
      `,
    );
    if (result.rows[0]?.present !== true) {
      throw new Error(
        "The Google storage OAuth migration is missing; run pnpm infra:db:migrate",
      );
    }
  }

  public async saveOAuthTransaction(
    input: SaveGoogleOAuthTransactionInput,
  ): Promise<void> {
    await this.pool.query(
      "DELETE FROM google_storage_oauth_transactions WHERE expires_at <= $1",
      [input.createdAt],
    );
    await this.pool.query(
      `
        INSERT INTO google_storage_oauth_transactions (
          selector_hash,
          user_id,
          state,
          code_verifier,
          created_at,
          expires_at
        )
        VALUES ($1, $2, $3, $4, $5, $6)
      `,
      [
        input.selectorHash,
        input.userId,
        input.state,
        input.codeVerifier,
        input.createdAt,
        input.expiresAt,
      ],
    );
  }

  public async consumeOAuthTransaction(
    selectorHash: string,
    state: string,
    userId: string,
    now: Date,
  ): Promise<StoredGoogleOAuthTransaction | null> {
    // DELETE ... RETURNING makes the PKCE verifier one-use even if two browser
    // callbacks race or Google rejects the authorization code.
    const result = await this.pool.query<OAuthTransactionRow>(
      `
        DELETE FROM google_storage_oauth_transactions
        WHERE selector_hash = $1
          AND state = $2
          AND user_id = $3
          AND expires_at > $4
        RETURNING code_verifier
      `,
      [selectorHash, state, userId, now],
    );
    const row = result.rows[0];
    return row ? { codeVerifier: row.code_verifier } : null;
  }

  public async saveConnection(
    input: SaveGoogleStorageConnectionInput,
  ): Promise<void> {
    await this.pool.query(
      `
        INSERT INTO google_storage_connections (
          user_id,
          encrypted_refresh_token,
          token_key_version,
          granted_scopes,
          connected_at,
          updated_at
        )
        VALUES ($1, $2, 1, $3, $4, $5)
        ON CONFLICT (user_id)
        DO UPDATE SET
          encrypted_refresh_token = EXCLUDED.encrypted_refresh_token,
          token_key_version = EXCLUDED.token_key_version,
          granted_scopes = EXCLUDED.granted_scopes,
          connected_at = EXCLUDED.connected_at,
          updated_at = EXCLUDED.updated_at
      `,
      [
        input.userId,
        input.encryptedRefreshToken,
        [...input.grantedScopes],
        input.connectedAt,
        input.updatedAt,
      ],
    );
  }

  public async findConnection(
    userId: string,
  ): Promise<GoogleStorageConnection | null> {
    const result = await this.pool.query<GoogleStorageConnectionRow>(
      `
        SELECT
          user_id,
          encrypted_refresh_token,
          granted_scopes,
          connected_at
        FROM google_storage_connections
        WHERE user_id = $1
          AND token_key_version = 1
      `,
      [userId],
    );
    const row = result.rows[0];
    return row
      ? {
          userId: row.user_id,
          encryptedRefreshToken: row.encrypted_refresh_token,
          grantedScopes: row.granted_scopes,
          connectedAt: row.connected_at,
        }
      : null;
  }

  public async deleteConnection(userId: string): Promise<void> {
    await this.pool.query(
      "DELETE FROM google_storage_connections WHERE user_id = $1",
      [userId],
    );
  }
}
