import type pg from "pg";
import { describe, expect, it, vi } from "vitest";
import { PostgresSharingDriftRepository } from "./sharing-drift-repository.js";

/**
 * The SQL itself is exercised against PostgreSQL by the release verifier. This
 * unit test pins privacy-safe aggregation, stale-time calculation, and invalid
 * result handling without requiring Docker for the normal test command.
 */
describe("PostgresSharingDriftRepository", () => {
  it("returns aggregate categories and the exact total", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          active_shares_missing_material: "2",
          orphaned_share_material: "1",
          stale_pending_rotations: "3",
          committed_revocations_still_active: "4",
        },
      ],
    });
    const repository = new PostgresSharingDriftRepository({
      query,
    } as unknown as pg.Pool);
    const now = new Date("2026-09-03T10:00:00.000Z");

    await expect(repository.inspect(now, 45)).resolves.toEqual({
      generatedAt: now,
      staleAfterMinutes: 45,
      activeSharesMissingMaterial: 2,
      orphanedShareMaterial: 1,
      stalePendingRotations: 3,
      committedRevocationsStillActive: 4,
      totalFindings: 10,
    });
    expect(query.mock.calls[0]?.[1]).toEqual([
      new Date("2026-09-03T09:15:00.000Z"),
    ]);
  });

  it("rejects unsafe thresholds and malformed database counts", async () => {
    const repository = new PostgresSharingDriftRepository({
      query: vi.fn().mockResolvedValue({
        rows: [
          {
            active_shares_missing_material: "-1",
            orphaned_share_material: "0",
            stale_pending_rotations: "0",
            committed_revocations_still_active: "0",
          },
        ],
      }),
    } as unknown as pg.Pool);

    await expect(repository.inspect(new Date(), 1)).rejects.toThrow(
      /at least 5/u,
    );
    await expect(repository.inspect()).rejects.toThrow(/invalid count/u);
  });
});
