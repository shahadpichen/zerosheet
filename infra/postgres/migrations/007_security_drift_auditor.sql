-- Aggregate-only sharing drift auditor
-- ====================================
--
-- A monitoring worker needs to know that the three-part sharing saga drifted;
-- it does not need workbook IDs, user IDs, email addresses, permission IDs,
-- OAuth envelopes, or key material. This SECURITY DEFINER function executes as
-- the application table owner and exposes only four counts. PUBLIC loses its
-- default function privilege, and an optional production auditor receives the
-- single narrow EXECUTE grant.

BEGIN;

CREATE OR REPLACE FUNCTION public.inspect_sharing_drift(
  stale_before timestamp with time zone
)
RETURNS TABLE (
  active_shares_missing_material bigint,
  orphaned_share_material bigint,
  stale_pending_rotations bigint,
  committed_revocations_still_active bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  WITH active_direct_shares AS (
    SELECT share.workbook_id, share.user_id
    FROM public.workbook_user_shares AS share
    INNER JOIN public.workbook_encryption AS workbook
      ON workbook.workbook_id = share.workbook_id
    WHERE share.authorization_state = 'active'
  ),
  active_shares_missing_material AS (
    SELECT DISTINCT share.workbook_id, share.user_id
    FROM active_direct_shares AS share
    INNER JOIN public.workbook_encryption AS workbook
      ON workbook.workbook_id = share.workbook_id
    LEFT JOIN public.workbook_key_envelopes AS envelope
      ON envelope.workbook_id = share.workbook_id
     AND envelope.recipient_user_id = share.user_id
     AND envelope.workbook_key_version = workbook.active_key_version
    LEFT JOIN public.workbook_google_permissions AS permission
      ON permission.workbook_id = share.workbook_id
     AND permission.user_id = share.user_id
     AND permission.revoked_at IS NULL
    WHERE envelope.workbook_id IS NULL OR permission.workbook_id IS NULL
  ),
  material_recipients AS (
    SELECT permission.workbook_id, permission.user_id
    FROM public.workbook_google_permissions AS permission
    WHERE permission.revoked_at IS NULL
    UNION
    SELECT envelope.workbook_id, envelope.recipient_user_id AS user_id
    FROM public.workbook_key_envelopes AS envelope
    INNER JOIN public.workbook_encryption AS workbook
      ON workbook.workbook_id = envelope.workbook_id
     AND workbook.active_key_version = envelope.workbook_key_version
    INNER JOIN public.workbooks AS product_workbook
      ON product_workbook.id = envelope.workbook_id
    WHERE envelope.recipient_user_id <> product_workbook.created_by
  ),
  orphaned_share_material AS (
    SELECT material.workbook_id, material.user_id
    FROM material_recipients AS material
    LEFT JOIN active_direct_shares AS share
      ON share.workbook_id = material.workbook_id
     AND share.user_id = material.user_id
    WHERE share.workbook_id IS NULL
  )
  SELECT
    (SELECT count(*) FROM active_shares_missing_material),
    (SELECT count(*) FROM orphaned_share_material),
    (
      SELECT count(*)
      FROM public.workbook_key_rotations
      WHERE state = 'pending' AND created_at <= stale_before
    ),
    (
      SELECT count(*)
      FROM public.workbook_key_rotations AS rotation
      INNER JOIN public.workbook_user_shares AS share
        ON share.workbook_id = rotation.workbook_id
       AND share.user_id = rotation.revoked_user_id
       AND share.authorization_state = 'active'
      WHERE rotation.state = 'committed'
    );
$function$;

REVOKE ALL ON FUNCTION public.inspect_sharing_drift(timestamp with time zone)
FROM PUBLIC;

\if :{?audit_role}
SELECT format('GRANT USAGE ON SCHEMA public TO %I', :'audit_role')
WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'audit_role')
\gexec

SELECT format(
  'GRANT EXECUTE ON FUNCTION public.inspect_sharing_drift(timestamp with time zone) TO %I',
  :'audit_role'
)
WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'audit_role')
\gexec
\endif

INSERT INTO public.schema_migrations (version)
VALUES ('007_security_drift_auditor')
ON CONFLICT (version) DO NOTHING;

COMMIT;
