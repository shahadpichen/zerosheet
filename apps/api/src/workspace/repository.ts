import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { WorkspaceFolder } from "@zerosheet/contracts";
import {
  ProductConflictError,
  ProductNotFoundError,
} from "../product/errors.js";
import type { WorkbookCandidate, WorkspaceRepository } from "./service.js";

/** The database stores navigation metadata, never encryption secrets. Every
 * folder lookup includes the session user so guessed folder IDs are harmless. */
export class PostgresWorkspaceRepository implements WorkspaceRepository {
  constructor(private readonly pool: Pool) {}

  async assertReady() {
    const result = await this.pool.query(
      "SELECT version FROM schema_migrations WHERE version = '008_workbook_browser'",
    );
    if (!result.rowCount)
      throw new Error(
        "Run pnpm infra:db:migrate to enable the workbook browser",
      );
  }

  async candidates(
    userId: string,
    after?: string,
  ): Promise<WorkbookCandidate[]> {
    const result = await this.pool.query<
      Omit<WorkbookCandidate, "createdAt"> & { createdAt: Date }
    >(
      `
      SELECT w.id, w.organization_id AS "organizationId", w.name,
        w.created_by AS "createdBy", w.created_at AS "createdAt",
        l.folder_id AS "folderId", (e.workbook_id IS NOT NULL) AS ready
      FROM workbooks w
      LEFT JOIN workbook_encryption e ON e.workbook_id = w.id
      LEFT JOIN workspace_workbook_locations l ON l.workbook_id = w.id AND l.user_id = $1
      WHERE w.authorization_state = 'active' AND ($2::uuid IS NULL OR w.id > $2)
        AND (w.created_by = $1 OR
          EXISTS (SELECT 1 FROM organization_members m WHERE m.organization_id = w.organization_id AND m.user_id = $1 AND m.authorization_state = 'active') OR
          EXISTS (SELECT 1 FROM workbook_user_shares s WHERE s.workbook_id = w.id AND s.user_id = $1 AND s.authorization_state = 'active') OR
          EXISTS (SELECT 1 FROM workbook_team_shares s JOIN team_members m ON m.team_id = s.team_id WHERE s.workbook_id = w.id AND m.user_id = $1 AND s.authorization_state = 'active' AND m.authorization_state = 'active'))
      ORDER BY w.id LIMIT 51`,
      [userId, after ?? null],
    );
    return result.rows.map((row) => ({
      ...row,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  async organizations(userId: string) {
    const result = await this.pool.query<{ id: string; name: string }>(
      `SELECT o.id, o.name FROM organizations o
      JOIN organization_members m ON m.organization_id = o.id
      WHERE m.user_id = $1 AND m.authorization_state = 'active' AND o.authorization_state = 'active'
      ORDER BY o.created_at LIMIT 100`,
      [userId],
    );
    return result.rows;
  }
  async workbook(
    userId: string,
    workbookId: string,
  ): Promise<WorkbookCandidate> {
    const result = await this.pool.query<
      Omit<WorkbookCandidate, "createdAt"> & { createdAt: Date }
    >(
      `
      SELECT w.id, w.organization_id AS "organizationId", w.name, w.created_by AS "createdBy",
      w.created_at AS "createdAt", l.folder_id AS "folderId", (e.workbook_id IS NOT NULL) AS ready
      FROM workbooks w LEFT JOIN workbook_encryption e ON e.workbook_id = w.id
      LEFT JOIN workspace_workbook_locations l ON l.workbook_id = w.id AND l.user_id = $1
      WHERE w.id = $2 AND w.authorization_state = 'active'`,
      [userId, workbookId],
    );
    const row = result.rows[0];
    if (!row) throw new ProductNotFoundError();
    return { ...row, createdAt: row.createdAt.toISOString() };
  }
  async folders(userId: string) {
    const result = await this.pool.query<WorkspaceFolder>(
      `SELECT id, name, parent_id AS "parentId" FROM workspace_folders WHERE user_id = $1 ORDER BY name, id LIMIT 500`,
      [userId],
    );
    return result.rows;
  }
  async createFolder(userId: string, name: string, parentId: string | null) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Serialize folder creation per user so the UI's bounded list cannot
      // hide newly-created folders after a concurrent request exceeds the cap.
      await client.query(
        "SELECT id FROM product_users WHERE id = $1 FOR UPDATE",
        [userId],
      );
      const count = await client.query<{ count: string }>(
        "SELECT count(*) FROM workspace_folders WHERE user_id = $1",
        [userId],
      );
      if (Number(count.rows[0]?.count) >= 500) throw new ProductConflictError();
      if (parentId) {
        const parent = await client.query(
          "SELECT id FROM workspace_folders WHERE user_id = $1 AND id = $2",
          [userId, parentId],
        );
        if (!parent.rowCount) throw new ProductNotFoundError();
      }
      const folder = { id: randomUUID(), name, parentId };
      await client.query(
        "INSERT INTO workspace_folders(id, user_id, name, parent_id) VALUES ($1,$2,$3,$4)",
        [folder.id, userId, name, parentId],
      );
      await client.query("COMMIT");
      return folder;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async placeWorkbook(
    userId: string,
    workbookId: string,
    folderId: string | null,
  ) {
    if (!folderId) {
      await this.pool.query(
        "DELETE FROM workspace_workbook_locations WHERE user_id = $1 AND workbook_id = $2",
        [userId, workbookId],
      );
      return;
    }
    const result = await this.pool.query(
      `INSERT INTO workspace_workbook_locations(user_id, workbook_id, folder_id)
      SELECT $1, $2, id FROM workspace_folders WHERE user_id = $1 AND id = $3
      ON CONFLICT (user_id, workbook_id) DO UPDATE SET folder_id = EXCLUDED.folder_id RETURNING workbook_id`,
      [userId, workbookId, folderId],
    );
    if (!result.rowCount) throw new ProductNotFoundError();
  }
}
