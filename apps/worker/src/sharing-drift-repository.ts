import type pg from "pg";

export interface SharingDriftReport {
  readonly generatedAt: Date;
  readonly staleAfterMinutes: number;
  readonly activeSharesMissingMaterial: number;
  readonly orphanedShareMaterial: number;
  readonly stalePendingRotations: number;
  readonly committedRevocationsStillActive: number;
  readonly totalFindings: number;
}

interface SharingDriftRow extends pg.QueryResultRow {
  readonly active_shares_missing_material: string;
  readonly orphaned_share_material: string;
  readonly stale_pending_rotations: string;
  readonly committed_revocations_still_active: string;
}

/** Convert PostgreSQL bigint text without accepting negative/corrupt counts. */
function safeCount(value: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("The sharing drift query returned an invalid count.");
  }
  return parsed;
}

/**
 * Read-only auditor for the durable portions of the three-system sharing saga.
 * It returns aggregate counts rather than user/workbook identifiers so normal
 * monitoring logs cannot become a map of collaboration relationships.
 *
 * This repository deliberately does not mutate state. A human or a narrowly
 * reviewed reconciler must decide whether to resume a rotation, recreate an
 * envelope, or remove a Drive permission; presence alone is not enough proof
 * that deletion is the correct action.
 */
export class PostgresSharingDriftRepository {
  public constructor(private readonly pool: pg.Pool) {}

  public async assertReady(): Promise<void> {
    const result = await this.pool.query<{ auditor: string | null }>(
      `
        SELECT to_regprocedure(
          'public.inspect_sharing_drift(timestamp with time zone)'
        )::text AS auditor
      `,
    );
    if (!result.rows[0]?.auditor) {
      throw new Error("The sharing drift auditor migration is not applied.");
    }
  }

  public async inspect(
    now = new Date(),
    staleAfterMinutes = 30,
  ): Promise<SharingDriftReport> {
    if (!Number.isSafeInteger(staleAfterMinutes) || staleAfterMinutes < 5) {
      throw new Error("staleAfterMinutes must be an integer of at least 5.");
    }

    const staleBefore = new Date(now.getTime() - staleAfterMinutes * 60_000);
    const result = await this.pool.query<SharingDriftRow>(
      `
        SELECT active_shares_missing_material::text,
               orphaned_share_material::text,
               stale_pending_rotations::text,
               committed_revocations_still_active::text
        FROM public.inspect_sharing_drift($1)
      `,
      [staleBefore],
    );
    const row = result.rows[0];
    if (!row) throw new Error("The sharing drift query returned no result.");

    const report = {
      generatedAt: now,
      staleAfterMinutes,
      activeSharesMissingMaterial: safeCount(
        row.active_shares_missing_material,
      ),
      orphanedShareMaterial: safeCount(row.orphaned_share_material),
      stalePendingRotations: safeCount(row.stale_pending_rotations),
      committedRevocationsStillActive: safeCount(
        row.committed_revocations_still_active,
      ),
    };
    return {
      ...report,
      totalFindings:
        report.activeSharesMissingMaterial +
        report.orphanedShareMaterial +
        report.stalePendingRotations +
        report.committedRevocationsStillActive,
    };
  }
}
