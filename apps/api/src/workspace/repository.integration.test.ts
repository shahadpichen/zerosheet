import { randomUUID } from "node:crypto";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { describe, it, expect } from "vitest";
import { PostgresWorkspaceRepository } from "./repository.js";
import { ProductNotFoundError } from "../product/errors.js";

const databaseTest =
  process.env.ZEROSHEET_RUN_DB_INTEGRATION === "true"
    ? describe
    : describe.skip;

/** Random, isolated fixtures exercise real joins, ownership, and composite FKs.
 * Cleanup only touches these UUIDs; no application user/workbook is modified. */
databaseTest("workbook browser PostgreSQL", () => {
  it("isolates folder trees and placements while listing owned workbooks", async () => {
    loadEnvFile(fileURLToPath(new URL("../../../../.env", import.meta.url)));
    const pool = new pg.Pool({
      host: process.env.ZEROSHEET_DB_HOST ?? "127.0.0.1",
      port: Number(process.env.ZEROSHEET_DB_PORT ?? "5434"),
      database: process.env.ZEROSHEET_DB_NAME ?? "zerosheet",
      user: process.env.ZEROSHEET_DB_USER ?? "zerosheet_app",
      password: process.env.ZEROSHEET_DB_PASSWORD,
    });
    const user = randomUUID(),
      other = randomUUID(),
      organization = randomUUID(),
      workbook = randomUUID(),
      operation = randomUUID();
    const repository = new PostgresWorkspaceRepository(pool);
    try {
      await repository.assertReady();
      await pool.query(
        "INSERT INTO product_users(id,primary_email,display_name,created_at,updated_at) VALUES($1,'fixture-one@example.invalid','Browser fixture',now(),now()),($2,'fixture-two@example.invalid','Browser fixture',now(),now())",
        [user, other],
      );
      await pool.query(
        "INSERT INTO relationship_outbox(id,writes,deletes,status,next_attempt_at,created_at,applied_at) VALUES($1,'[{}]'::jsonb,'[]'::jsonb,'applied',now(),now(),now())",
        [operation],
      );
      await pool.query(
        "INSERT INTO organizations(id,name,created_by,authorization_state,authorization_operation_id,created_at,updated_at) VALUES($1,'Fixture',$2,'active',$3,now(),now())",
        [organization, user, operation],
      );
      await pool.query(
        "INSERT INTO workbooks(id,organization_id,name,created_by,authorization_state,authorization_operation_id,created_at,updated_at) VALUES($1,$2,'Fixture workbook',$3,'active',$4,now(),now())",
        [workbook, organization, user, operation],
      );
      const parent = await repository.createFolder(user, "Parent", null);
      const child = await repository.createFolder(user, "Child", parent.id);
      expect(await repository.folders(other)).toEqual([]);
      await expect(
        repository.createFolder(other, "Forbidden", parent.id),
      ).rejects.toBeInstanceOf(ProductNotFoundError);
      await expect(
        repository.placeWorkbook(other, workbook, child.id),
      ).rejects.toBeInstanceOf(ProductNotFoundError);
      await repository.placeWorkbook(user, workbook, child.id);
      expect(await repository.candidates(other)).toEqual([]);
      expect(await repository.candidates(user)).toMatchObject([
        { id: workbook, folderId: child.id, ready: false },
      ]);
      expect((await repository.workbook(user, workbook)).folderId).toBe(
        child.id,
      );
      await repository.placeWorkbook(user, workbook, null);
      expect((await repository.workbook(user, workbook)).folderId).toBeNull();
    } finally {
      await pool.query(
        "DELETE FROM workspace_workbook_locations WHERE user_id IN ($1,$2)",
        [user, other],
      );
      await pool.query(
        "DELETE FROM workspace_folders WHERE user_id IN ($1,$2) AND parent_id IS NOT NULL",
        [user, other],
      );
      await pool.query(
        "DELETE FROM workspace_folders WHERE user_id IN ($1,$2)",
        [user, other],
      );
      await pool.query("DELETE FROM workbooks WHERE id = $1", [workbook]);
      await pool.query("DELETE FROM organizations WHERE id = $1", [
        organization,
      ]);
      await pool.query("DELETE FROM relationship_outbox WHERE id = $1", [
        operation,
      ]);
      await pool.query("DELETE FROM product_users WHERE id IN ($1,$2)", [
        user,
        other,
      ]);
      await pool.end();
    }
  });
});
