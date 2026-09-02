-- ZeroSheet product and authorization lifecycle schema
-- ===================================================
--
-- PostgreSQL owns product metadata such as organization and workbook names.
-- OpenFGA owns the relationship graph used for access decisions. Those are two
-- independent databases, so a PostgreSQL transaction cannot atomically commit
-- an OpenFGA tuple. The relationship_outbox table records the intended tuple
-- mutation in the same transaction as the product change. A product row stays
-- pending and is never returned by normal reads until that mutation succeeds.
--
-- This is a transactional-outbox pattern, not a distributed transaction. If a
-- process stops after OpenFGA accepts a tuple but before PostgreSQL records the
-- completion, retrying is safe because the writer treats duplicate writes and
-- missing deletes as successful no-ops.

BEGIN;

CREATE TABLE IF NOT EXISTS relationship_outbox (
  id uuid PRIMARY KEY,

  -- Tuple payloads contain stable product UUIDs and relationship names only.
  -- Passwords, tokens, workbook keys, recovery phrases, and cell values must
  -- never be placed in this operational queue.
  writes jsonb NOT NULL DEFAULT '[]'::jsonb,
  deletes jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'applied')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error_code text,
  next_attempt_at timestamp with time zone NOT NULL,
  created_at timestamp with time zone NOT NULL,
  applied_at timestamp with time zone,

  CONSTRAINT relationship_outbox_writes_array
    CHECK (jsonb_typeof(writes) = 'array'),
  CONSTRAINT relationship_outbox_deletes_array
    CHECK (jsonb_typeof(deletes) = 'array'),
  CONSTRAINT relationship_outbox_has_mutation
    CHECK (jsonb_array_length(writes) + jsonb_array_length(deletes) > 0),
  CONSTRAINT relationship_outbox_applied_time
    CHECK (
      (status = 'pending' AND applied_at IS NULL)
      OR (status = 'applied' AND applied_at IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS relationship_outbox_pending_idx
  ON relationship_outbox (next_attempt_at, created_at)
  WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS organizations (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  created_by uuid NOT NULL REFERENCES product_users(id) ON DELETE RESTRICT,
  authorization_state text NOT NULL
    CHECK (authorization_state IN ('pending', 'active')),
  authorization_operation_id uuid NOT NULL
    REFERENCES relationship_outbox(id) ON DELETE RESTRICT,
  created_at timestamp with time zone NOT NULL,
  updated_at timestamp with time zone NOT NULL,
  CONSTRAINT organization_time_order CHECK (updated_at >= created_at)
);

CREATE TABLE IF NOT EXISTS organization_members (
  organization_id uuid NOT NULL
    REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES product_users(id) ON DELETE RESTRICT,
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  authorization_state text NOT NULL
    CHECK (authorization_state IN ('pending', 'active', 'pending_delete')),
  authorization_operation_id uuid NOT NULL
    REFERENCES relationship_outbox(id) ON DELETE RESTRICT,
  created_at timestamp with time zone NOT NULL,
  updated_at timestamp with time zone NOT NULL,
  PRIMARY KEY (organization_id, user_id),
  CONSTRAINT organization_member_time_order CHECK (updated_at >= created_at)
);

CREATE INDEX IF NOT EXISTS organization_members_user_idx
  ON organization_members (user_id, organization_id)
  WHERE authorization_state = 'active';

CREATE TABLE IF NOT EXISTS teams (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL
    REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  created_by uuid NOT NULL REFERENCES product_users(id) ON DELETE RESTRICT,
  authorization_state text NOT NULL
    CHECK (authorization_state IN ('pending', 'active')),
  authorization_operation_id uuid NOT NULL
    REFERENCES relationship_outbox(id) ON DELETE RESTRICT,
  created_at timestamp with time zone NOT NULL,
  updated_at timestamp with time zone NOT NULL,
  CONSTRAINT team_name_unique_per_organization
    UNIQUE (organization_id, name),
  CONSTRAINT team_time_order CHECK (updated_at >= created_at)
);

CREATE TABLE IF NOT EXISTS team_members (
  team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES product_users(id) ON DELETE RESTRICT,
  role text NOT NULL CHECK (role IN ('manager', 'member')),
  authorization_state text NOT NULL
    CHECK (authorization_state IN ('pending', 'active', 'pending_delete')),
  authorization_operation_id uuid NOT NULL
    REFERENCES relationship_outbox(id) ON DELETE RESTRICT,
  created_at timestamp with time zone NOT NULL,
  updated_at timestamp with time zone NOT NULL,
  PRIMARY KEY (team_id, user_id),
  CONSTRAINT team_member_time_order CHECK (updated_at >= created_at)
);

CREATE INDEX IF NOT EXISTS team_members_user_idx
  ON team_members (user_id, team_id)
  WHERE authorization_state = 'active';

CREATE TABLE IF NOT EXISTS workbooks (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL
    REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),

  -- The creator is useful product metadata and is also provisioned as the
  -- immutable initial OpenFGA owner. No encryption material belongs here.
  created_by uuid NOT NULL REFERENCES product_users(id) ON DELETE RESTRICT,
  authorization_state text NOT NULL
    CHECK (authorization_state IN ('pending', 'active')),
  authorization_operation_id uuid NOT NULL
    REFERENCES relationship_outbox(id) ON DELETE RESTRICT,
  created_at timestamp with time zone NOT NULL,
  updated_at timestamp with time zone NOT NULL,
  CONSTRAINT workbook_time_order CHECK (updated_at >= created_at)
);

CREATE INDEX IF NOT EXISTS workbooks_organization_idx
  ON workbooks (organization_id, created_at)
  WHERE authorization_state = 'active';

CREATE TABLE IF NOT EXISTS workbook_user_shares (
  workbook_id uuid NOT NULL REFERENCES workbooks(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES product_users(id) ON DELETE RESTRICT,
  role text NOT NULL CHECK (role IN ('editor', 'viewer')),
  authorization_state text NOT NULL
    CHECK (authorization_state IN ('pending', 'active', 'pending_delete')),
  authorization_operation_id uuid NOT NULL
    REFERENCES relationship_outbox(id) ON DELETE RESTRICT,
  created_at timestamp with time zone NOT NULL,
  updated_at timestamp with time zone NOT NULL,
  PRIMARY KEY (workbook_id, user_id),
  CONSTRAINT workbook_user_share_time_order CHECK (updated_at >= created_at)
);

CREATE INDEX IF NOT EXISTS workbook_user_shares_user_idx
  ON workbook_user_shares (user_id, workbook_id)
  WHERE authorization_state = 'active';

CREATE TABLE IF NOT EXISTS workbook_team_shares (
  workbook_id uuid NOT NULL REFERENCES workbooks(id) ON DELETE CASCADE,
  team_id uuid NOT NULL REFERENCES teams(id) ON DELETE RESTRICT,
  role text NOT NULL CHECK (role IN ('editor', 'viewer')),
  authorization_state text NOT NULL
    CHECK (authorization_state IN ('pending', 'active', 'pending_delete')),
  authorization_operation_id uuid NOT NULL
    REFERENCES relationship_outbox(id) ON DELETE RESTRICT,
  created_at timestamp with time zone NOT NULL,
  updated_at timestamp with time zone NOT NULL,
  PRIMARY KEY (workbook_id, team_id),
  CONSTRAINT workbook_team_share_time_order CHECK (updated_at >= created_at)
);

CREATE INDEX IF NOT EXISTS workbook_team_shares_team_idx
  ON workbook_team_shares (team_id, workbook_id)
  WHERE authorization_state = 'active';

INSERT INTO schema_migrations (version)
VALUES ('002_product_authorization_lifecycle')
ON CONFLICT (version) DO NOTHING;

COMMIT;
