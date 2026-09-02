-- Milestone 6 adds operational status facts for contextual authorization.
--
-- `authorization_state` from migration 002 describes whether PostgreSQL and
-- OpenFGA have synchronized a resource. The new status columns describe a
-- business decision: whether an account or tenant may currently operate. They
-- must remain separate so an administrator can suspend access without deleting
-- relationships or corrupting outbox synchronization state.

BEGIN;

ALTER TABLE product_users
  ADD COLUMN IF NOT EXISTS account_status text NOT NULL DEFAULT 'active'
    CHECK (account_status IN ('active', 'suspended'));

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS tenant_status text NOT NULL DEFAULT 'active'
    CHECK (tenant_status IN ('active', 'suspended'));

-- The current PIP queries look up rows by primary key, so no status-only index
-- is needed. Avoiding unused indexes keeps writes and the small VPS footprint
-- predictable; a later administrative list endpoint can add one with evidence.

INSERT INTO schema_migrations (version)
VALUES ('003_contextual_authorization_status')
ON CONFLICT (version) DO NOTHING;

COMMIT;
