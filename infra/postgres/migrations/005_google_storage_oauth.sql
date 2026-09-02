-- ZeroSheet delegated Google storage authorization
-- =================================================
--
-- Keycloak's Google connection authenticates a human. These separate records
-- authorize Drive and Sheets operations after an already authenticated product
-- user explicitly consents. Google refresh tokens are encrypted by the API
-- before insertion; the database never stores a directly usable bearer token.

BEGIN;

CREATE TABLE IF NOT EXISTS google_storage_oauth_transactions (
  -- The HttpOnly cookie contains the random selector. Keeping only its digest
  -- means a database reader cannot directly complete an intercepted callback.
  selector_hash character(64) PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES product_users(id) ON DELETE CASCADE,
  state text NOT NULL UNIQUE CHECK (length(state) BETWEEN 32 AND 512),
  code_verifier text NOT NULL CHECK (length(code_verifier) BETWEEN 43 AND 128),
  created_at timestamp with time zone NOT NULL,
  expires_at timestamp with time zone NOT NULL,
  CONSTRAINT google_storage_oauth_transaction_time_order
    CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS google_storage_oauth_transactions_expiry_idx
  ON google_storage_oauth_transactions (expires_at);

CREATE TABLE IF NOT EXISTS google_storage_connections (
  user_id uuid PRIMARY KEY REFERENCES product_users(id) ON DELETE CASCADE,

  -- Envelope v1 is AES-256-GCM and authenticates the immutable product-user ID
  -- as AAD. `token_key_version` reserves an explicit rotation path instead of
  -- silently changing the secret used for existing ciphertext.
  encrypted_refresh_token text NOT NULL
    CHECK (length(encrypted_refresh_token) BETWEEN 40 AND 16_384),
  token_key_version integer NOT NULL DEFAULT 1 CHECK (token_key_version = 1),
  granted_scopes text[] NOT NULL CHECK (cardinality(granted_scopes) BETWEEN 1 AND 16),
  connected_at timestamp with time zone NOT NULL,
  updated_at timestamp with time zone NOT NULL,
  CONSTRAINT google_storage_connection_time_order
    CHECK (updated_at >= connected_at)
);

INSERT INTO schema_migrations (version)
VALUES ('005_google_storage_oauth')
ON CONFLICT (version) DO NOTHING;

COMMIT;
