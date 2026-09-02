-- Milestone 7: tenant-scoped enterprise lifecycle, SCIM connections, and
-- immutable security audit events.
--
-- SCIM provisioning is a workload-authenticated control plane. Its bearer
-- token is never stored directly: only a SHA-256 digest and a non-secret hint
-- are persisted. SCIM resource IDs are ZeroSheet-issued UUIDs, while
-- external_id remains the provisioning client's stable identifier.

BEGIN;

CREATE TABLE IF NOT EXISTS scim_connections (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  display_name text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 200),
  token_hash character(64) NOT NULL UNIQUE
    CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  token_hint text NOT NULL CHECK (length(token_hint) BETWEEN 4 AND 32),
  active boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL REFERENCES product_users(id) ON DELETE RESTRICT,
  created_at timestamp with time zone NOT NULL,
  updated_at timestamp with time zone NOT NULL,
  CONSTRAINT scim_connection_time_order CHECK (updated_at >= created_at)
);

CREATE INDEX IF NOT EXISTS scim_connections_organization_idx
  ON scim_connections (organization_id, created_at);

-- Lifecycle status is scoped to an organization. A consultant can be removed
-- from Acme without disabling a separate relationship with another tenant.
-- Absence means unmanaged/active; a stored suspended row is an explicit deny
-- fact consumed by the PostgreSQL PIP and OPA.
CREATE TABLE IF NOT EXISTS organization_user_lifecycle (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES product_users(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('active', 'suspended')),
  source text NOT NULL CHECK (source IN ('manual', 'scim')),
  source_connection_id uuid REFERENCES scim_connections(id) ON DELETE SET NULL,
  updated_at timestamp with time zone NOT NULL,
  PRIMARY KEY (organization_id, user_id)
);

CREATE TABLE IF NOT EXISTS scim_managed_users (
  id uuid PRIMARY KEY,
  connection_id uuid NOT NULL REFERENCES scim_connections(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  product_user_id uuid NOT NULL REFERENCES product_users(id) ON DELETE RESTRICT,
  external_id text NOT NULL CHECK (length(external_id) BETWEEN 1 AND 512),
  user_name text NOT NULL CHECK (length(user_name) BETWEEN 3 AND 320),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  active boolean NOT NULL,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamp with time zone NOT NULL,
  updated_at timestamp with time zone NOT NULL,
  CONSTRAINT scim_managed_user_time_order CHECK (updated_at >= created_at),
  CONSTRAINT scim_user_external_id_unique UNIQUE (connection_id, external_id),
  CONSTRAINT scim_user_product_mapping_unique UNIQUE (connection_id, product_user_id)
);

-- SCIM userName is case-insensitive by specification unless a schema marks it
-- case-exact. A functional unique index avoids requiring the PostgreSQL citext
-- extension merely for this bounded service-provider implementation.
CREATE UNIQUE INDEX IF NOT EXISTS scim_user_name_unique
  ON scim_managed_users (connection_id, lower(user_name));

CREATE INDEX IF NOT EXISTS scim_users_organization_idx
  ON scim_managed_users (organization_id, updated_at);

CREATE TABLE IF NOT EXISTS security_audit_events (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id uuid NOT NULL UNIQUE,
  occurred_at timestamp with time zone NOT NULL,
  actor_type text NOT NULL
    CHECK (actor_type IN ('user', 'scim_client', 'workload', 'system')),
  actor_id text NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 512),
  organization_id uuid,
  action text NOT NULL CHECK (length(action) BETWEEN 1 AND 200),
  resource_type text NOT NULL CHECK (length(resource_type) BETWEEN 1 AND 100),
  resource_id text CHECK (resource_id IS NULL OR length(resource_id) BETWEEN 1 AND 512),
  outcome text NOT NULL
    CHECK (outcome IN ('allowed', 'denied', 'succeeded', 'failed')),
  reason_code text NOT NULL CHECK (length(reason_code) BETWEEN 1 AND 100),
  details jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(details) = 'object')
);

CREATE INDEX IF NOT EXISTS security_audit_events_organization_idx
  ON security_audit_events (organization_id, occurred_at DESC, sequence DESC);

-- The runtime database role owns these tables in the local lab, so database
-- ownership can still alter schema deliberately. This trigger prevents normal
-- application code and accidental maintenance queries from rewriting evidence.
CREATE OR REPLACE FUNCTION reject_security_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'security audit events are append-only';
END;
$$;

DROP TRIGGER IF EXISTS security_audit_events_append_only
  ON security_audit_events;
CREATE TRIGGER security_audit_events_append_only
BEFORE UPDATE OR DELETE ON security_audit_events
FOR EACH ROW EXECUTE FUNCTION reject_security_audit_mutation();

INSERT INTO schema_migrations (version)
VALUES ('004_enterprise_lifecycle_audit')
ON CONFLICT (version) DO NOTHING;

COMMIT;
