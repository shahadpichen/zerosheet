-- ZeroSheet HPKE directory, workbook envelopes, and resumable key rotation
-- ========================================================================
--
-- The database stores only public user keys, recovery-phrase-encrypted private
-- key backups, and HPKE-encrypted workbook keys. It never receives a recovery
-- phrase, usable private key, raw workbook key, or protected cell plaintext.
--
-- A workbook rotation is staged before Google ciphertext is rewritten. This
-- guarantees that the creator's new HPKE envelope is durable before the only
-- in-memory copy of the new workbook key could disappear. The old version stays
-- active until the browser confirms the rewrite, after which the API advances
-- the active version and removes the revoked OpenFGA relationship.

BEGIN;

CREATE TABLE IF NOT EXISTS user_encryption_keys (
  user_id uuid NOT NULL REFERENCES product_users(id) ON DELETE RESTRICT,
  key_version integer NOT NULL CHECK (key_version BETWEEN 1 AND 2147483647),
  format_version smallint NOT NULL CHECK (format_version = 1),
  suite text NOT NULL CHECK (
    suite = 'DHKEM_P256_HKDF_SHA256_HKDF_SHA256_AES_256_GCM'
  ),

  -- A P-256 uncompressed public point and its SHA-256 fingerprint are public
  -- directory material. Tight bounds make malformed/oversized records fail at
  -- both the API and database boundaries.
  public_key text NOT NULL CHECK (length(public_key) BETWEEN 80 AND 100),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),

  -- This bytea value is a ZeroDrive Capsule encrypted by the 12-word phrase.
  -- Database access alone cannot open it, but it remains sensitive metadata and
  -- must never be copied into logs or ordinary API error responses.
  encrypted_private_key_backup bytea NOT NULL CHECK (
    octet_length(encrypted_private_key_backup) BETWEEN 1 AND 262144
  ),
  created_at timestamp with time zone NOT NULL,
  retired_at timestamp with time zone,
  PRIMARY KEY (user_id, key_version),
  UNIQUE (user_id, fingerprint),
  CONSTRAINT user_encryption_key_retired_time
    CHECK (retired_at IS NULL OR retired_at >= created_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS user_encryption_keys_one_current_idx
  ON user_encryption_keys (user_id)
  WHERE retired_at IS NULL;

CREATE TABLE IF NOT EXISTS workbook_encryption (
  workbook_id uuid PRIMARY KEY REFERENCES workbooks(id) ON DELETE CASCADE,
  google_spreadsheet_id text NOT NULL UNIQUE,
  google_sheet_id integer NOT NULL CHECK (google_sheet_id >= 0),
  google_sheet_title text NOT NULL CHECK (
    length(google_sheet_title) BETWEEN 1 AND 100
  ),
  active_key_version integer NOT NULL CHECK (active_key_version >= 1),
  pending_key_version integer CHECK (pending_key_version >= 2),
  rotation_state text NOT NULL CHECK (
    rotation_state IN ('active', 'rotation_pending')
  ),
  created_at timestamp with time zone NOT NULL,
  updated_at timestamp with time zone NOT NULL,
  CONSTRAINT workbook_encryption_google_spreadsheet_id_check CHECK (
    length(google_spreadsheet_id) BETWEEN 10 AND 256
    AND google_spreadsheet_id ~ '^[A-Za-z0-9_-]+$'
  ),
  CONSTRAINT workbook_encryption_version_state CHECK (
    (rotation_state = 'active' AND pending_key_version IS NULL)
    OR
    (rotation_state = 'rotation_pending'
      AND pending_key_version = active_key_version + 1)
  ),
  CONSTRAINT workbook_encryption_time_order CHECK (updated_at >= created_at)
);

CREATE TABLE IF NOT EXISTS workbook_key_envelopes (
  workbook_id uuid NOT NULL
    REFERENCES workbook_encryption(workbook_id) ON DELETE CASCADE,
  workbook_key_version integer NOT NULL CHECK (workbook_key_version >= 1),
  recipient_user_id uuid NOT NULL REFERENCES product_users(id) ON DELETE RESTRICT,
  recipient_key_version integer NOT NULL,
  format_version smallint NOT NULL CHECK (format_version = 1),
  suite text NOT NULL CHECK (
    suite = 'DHKEM_P256_HKDF_SHA256_HKDF_SHA256_AES_256_GCM'
  ),
  recipient_fingerprint text NOT NULL CHECK (
    recipient_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  encapsulated_key text NOT NULL CHECK (length(encapsulated_key) BETWEEN 80 AND 100),
  ciphertext text NOT NULL CHECK (length(ciphertext) BETWEEN 60 AND 80),
  created_at timestamp with time zone NOT NULL,
  PRIMARY KEY (workbook_id, workbook_key_version, recipient_user_id),
  FOREIGN KEY (recipient_user_id, recipient_key_version)
    REFERENCES user_encryption_keys(user_id, key_version) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS workbook_key_envelopes_recipient_idx
  ON workbook_key_envelopes (recipient_user_id, workbook_id, workbook_key_version);

CREATE TABLE IF NOT EXISTS workbook_google_permissions (
  workbook_id uuid NOT NULL
    REFERENCES workbook_encryption(workbook_id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES product_users(id) ON DELETE RESTRICT,
  permission_id text NOT NULL,
  created_at timestamp with time zone NOT NULL,
  revoked_at timestamp with time zone,
  PRIMARY KEY (workbook_id, user_id),
  UNIQUE (workbook_id, permission_id),
  CONSTRAINT workbook_google_permissions_permission_id_check CHECK (
    length(permission_id) BETWEEN 3 AND 256
    AND permission_id ~ '^[A-Za-z0-9_-]+$'
  ),
  CONSTRAINT workbook_google_permission_time
    CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);

CREATE TABLE IF NOT EXISTS workbook_key_rotations (
  workbook_id uuid NOT NULL
    REFERENCES workbook_encryption(workbook_id) ON DELETE CASCADE,
  from_key_version integer NOT NULL CHECK (from_key_version >= 1),
  to_key_version integer NOT NULL CHECK (to_key_version = from_key_version + 1),
  revoked_user_id uuid NOT NULL REFERENCES product_users(id) ON DELETE RESTRICT,
  staged_by uuid NOT NULL REFERENCES product_users(id) ON DELETE RESTRICT,
  state text NOT NULL CHECK (state IN ('pending', 'committed')),
  created_at timestamp with time zone NOT NULL,
  committed_at timestamp with time zone,
  PRIMARY KEY (workbook_id, to_key_version),
  CONSTRAINT workbook_key_rotation_commit_time CHECK (
    (state = 'pending' AND committed_at IS NULL)
    OR
    (state = 'committed' AND committed_at >= created_at)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS workbook_key_rotations_one_pending_idx
  ON workbook_key_rotations (workbook_id)
  WHERE state = 'pending';

-- The migration runner deliberately replays files in development. Replacing
-- these two constraints also repairs an early local Milestone 13 draft whose
-- PostgreSQL regex used a repetition upper bound of 256; PostgreSQL accepts at
-- most 255 in `{min,max}` even though the column itself may allow 256 chars.
ALTER TABLE workbook_encryption
  DROP CONSTRAINT IF EXISTS workbook_encryption_google_spreadsheet_id_check;
ALTER TABLE workbook_encryption
  ADD CONSTRAINT workbook_encryption_google_spreadsheet_id_check CHECK (
    length(google_spreadsheet_id) BETWEEN 10 AND 256
    AND google_spreadsheet_id ~ '^[A-Za-z0-9_-]+$'
  );

ALTER TABLE workbook_google_permissions
  DROP CONSTRAINT IF EXISTS workbook_google_permissions_permission_id_check;
ALTER TABLE workbook_google_permissions
  ADD CONSTRAINT workbook_google_permissions_permission_id_check CHECK (
    length(permission_id) BETWEEN 3 AND 256
    AND permission_id ~ '^[A-Za-z0-9_-]+$'
  );

INSERT INTO schema_migrations (version)
VALUES ('006_workbook_key_sharing')
ON CONFLICT (version) DO NOTHING;

COMMIT;
