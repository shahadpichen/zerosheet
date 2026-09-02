import type { Pool, PoolClient } from "pg";
import { isAuthorizationTuple } from "./types.js";
import {
  organizationMembershipMutation,
  teamMembershipMutation,
  workbookShareMutation,
} from "./relationship-tuples.js";
import { ProductConflictError, ProductNotFoundError } from "./errors.js";
import type {
  CreateOrganizationRecordInput,
  CreateTeamRecordInput,
  CreateWorkbookRecordInput,
  Organization,
  OrganizationMembership,
  OrganizationRole,
  PendingRelationshipOperation,
  ProductRepository,
  SetOrganizationMembershipInput,
  SetTeamMembershipInput,
  SetWorkbookShareInput,
  StagedMutation,
  Team,
  TeamMembership,
  TeamRole,
  Workbook,
  WorkbookShare,
  WorkbookSharePrincipal,
  WorkbookShareRole,
} from "./types.js";

interface WorkbookRow {
  id: string;
  organization_id: string;
  name: string;
  created_by: string;
}

interface RoleStateRow {
  role: string;
  authorization_state: "pending" | "active" | "pending_delete";
}

interface PendingOperationRow {
  id: string;
  writes: unknown;
  deletes: unknown;
}

/**
 * This repository is the PostgreSQL half of the product/OpenFGA consistency
 * protocol. Every method that changes a relationship performs two writes in
 * one local transaction: the desired product state and an immutable tuple
 * intent. It never marks that product state active; only the outbox completer
 * may do so after OpenFGA has accepted the intent.
 */
export class PostgresProductRepository implements ProductRepository {
  public constructor(private readonly pool: Pool) {}

  public async assertReady(): Promise<void> {
    const result = await this.pool.query<{ present: boolean }>(
      `
        SELECT EXISTS (
          SELECT 1
          FROM schema_migrations
          WHERE version = '002_product_authorization_lifecycle'
        ) AS present
      `,
    );

    if (result.rows[0]?.present !== true) {
      throw new Error(
        "The product authorization migration is missing; run pnpm infra:db:migrate",
      );
    }
  }

  public async createOrganization(
    input: CreateOrganizationRecordInput,
  ): Promise<StagedMutation<Organization>> {
    return this.transaction(async (client) => {
      await this.insertOperation(client, input.operation, input.now);
      await client.query(
        `
          INSERT INTO organizations (
            id,
            name,
            created_by,
            authorization_state,
            authorization_operation_id,
            created_at,
            updated_at
          )
          VALUES ($1, $2, $3, 'pending', $4, $5, $5)
        `,
        [
          input.organization.id,
          input.organization.name,
          input.ownerId,
          input.operation.id,
          input.now,
        ],
      );
      await client.query(
        `
          INSERT INTO organization_members (
            organization_id,
            user_id,
            role,
            authorization_state,
            authorization_operation_id,
            created_at,
            updated_at
          )
          VALUES ($1, $2, 'owner', 'pending', $3, $4, $4)
        `,
        [input.organization.id, input.ownerId, input.operation.id, input.now],
      );

      return { value: input.organization, operation: input.operation };
    });
  }

  public async createTeam(
    input: CreateTeamRecordInput,
  ): Promise<StagedMutation<Team>> {
    try {
      return await this.transaction(async (client) => {
        await this.requireActiveOrganization(client, input.team.organizationId);
        await this.insertOperation(client, input.operation, input.now);
        await client.query(
          `
            INSERT INTO teams (
              id,
              organization_id,
              name,
              created_by,
              authorization_state,
              authorization_operation_id,
              created_at,
              updated_at
            )
            VALUES ($1, $2, $3, $4, 'pending', $5, $6, $6)
          `,
          [
            input.team.id,
            input.team.organizationId,
            input.team.name,
            input.managerId,
            input.operation.id,
            input.now,
          ],
        );
        await client.query(
          `
            INSERT INTO team_members (
              team_id,
              user_id,
              role,
              authorization_state,
              authorization_operation_id,
              created_at,
              updated_at
            )
            VALUES ($1, $2, 'manager', 'pending', $3, $4, $4)
          `,
          [input.team.id, input.managerId, input.operation.id, input.now],
        );

        return { value: input.team, operation: input.operation };
      });
    } catch (error) {
      this.translateUniqueNameViolation(
        error,
        "team_name_unique_per_organization",
        "A team with this name exists.",
      );
      throw error;
    }
  }

  public async createWorkbook(
    input: CreateWorkbookRecordInput,
  ): Promise<StagedMutation<Workbook>> {
    return this.transaction(async (client) => {
      await this.requireActiveOrganization(
        client,
        input.workbook.organizationId,
      );
      await this.insertOperation(client, input.operation, input.now);
      await client.query(
        `
          INSERT INTO workbooks (
            id,
            organization_id,
            name,
            created_by,
            authorization_state,
            authorization_operation_id,
            created_at,
            updated_at
          )
          VALUES ($1, $2, $3, $4, 'pending', $5, $6, $6)
        `,
        [
          input.workbook.id,
          input.workbook.organizationId,
          input.workbook.name,
          input.workbook.createdBy,
          input.operation.id,
          input.now,
        ],
      );

      return { value: input.workbook, operation: input.operation };
    });
  }

  public async findActiveWorkbook(
    workbookId: string,
  ): Promise<Workbook | null> {
    const result = await this.pool.query<WorkbookRow>(
      `
        SELECT id, organization_id, name, created_by
        FROM workbooks
        WHERE id = $1 AND authorization_state = 'active'
      `,
      [workbookId],
    );
    const row = result.rows[0];

    return row
      ? {
          id: row.id,
          organizationId: row.organization_id,
          name: row.name,
          createdBy: row.created_by,
        }
      : null;
  }

  public async setOrganizationMembership(
    input: SetOrganizationMembershipInput,
  ): Promise<StagedMutation<OrganizationMembership>> {
    return this.transaction(async (client) => {
      await this.requireActiveOrganization(client, input.organizationId);
      await this.requireProductUser(client, input.userId);
      const existing = await this.lockRole(
        client,
        "organization_members",
        "organization_id",
        input.organizationId,
        input.userId,
      );

      this.requireMutableRelationship(existing);
      if (existing?.role === "owner") {
        throw new ProductConflictError(
          "Organization ownership cannot be changed through membership APIs.",
        );
      }

      const value: OrganizationMembership = {
        organizationId: input.organizationId,
        userId: input.userId,
        role: input.role,
      };

      if (existing?.role === input.role) {
        return { value };
      }

      const operation: PendingRelationshipOperation = {
        id: input.operationId,
        ...input.buildMutation(
          (existing?.role as OrganizationRole | undefined) ?? null,
        ),
      };
      await this.insertOperation(client, operation, input.now);
      await client.query(
        `
          INSERT INTO organization_members (
            organization_id,
            user_id,
            role,
            authorization_state,
            authorization_operation_id,
            created_at,
            updated_at
          )
          VALUES ($1, $2, $3, 'pending', $4, $5, $5)
          ON CONFLICT (organization_id, user_id) DO UPDATE
          SET role = EXCLUDED.role,
              authorization_state = 'pending',
              authorization_operation_id = EXCLUDED.authorization_operation_id,
              updated_at = EXCLUDED.updated_at
        `,
        [
          input.organizationId,
          input.userId,
          input.role,
          operation.id,
          input.now,
        ],
      );

      return { value, operation };
    });
  }

  public async removeOrganizationMembership(
    organizationId: string,
    userId: string,
    input: { operationId: string; now: Date },
  ): Promise<StagedMutation<OrganizationMembership>> {
    return this.transaction(async (client) => {
      await this.requireActiveOrganization(client, organizationId);
      const existing = await this.lockRequiredRole(
        client,
        "organization_members",
        "organization_id",
        organizationId,
        userId,
      );
      this.requireMutableRelationship(existing);

      if (existing.role === "owner") {
        throw new ProductConflictError(
          "The organization owner cannot be removed through membership APIs.",
        );
      }

      const role = existing.role as Exclude<OrganizationRole, "owner">;
      const inheritedMemberships = await client.query<{
        team_id: string;
        role: TeamRole;
        authorization_state: RoleStateRow["authorization_state"];
      }>(
        `
          SELECT team_members.team_id,
                 team_members.role,
                 team_members.authorization_state
          FROM team_members
          INNER JOIN teams ON teams.id = team_members.team_id
          WHERE teams.organization_id = $1
            AND team_members.user_id = $2
          FOR UPDATE OF team_members
        `,
        [organizationId, userId],
      );

      if (
        inheritedMemberships.rows.some(
          (membership) => membership.authorization_state !== "active",
        )
      ) {
        throw new ProductConflictError();
      }

      const operation: PendingRelationshipOperation = {
        id: input.operationId,
        writes: [],
        deletes: [
          ...organizationMembershipMutation(organizationId, userId, role, null)
            .deletes,
          ...inheritedMemberships.rows.flatMap(
            (membership) =>
              teamMembershipMutation(
                membership.team_id,
                userId,
                membership.role,
                null,
              ).deletes,
          ),
        ],
      };
      await this.insertOperation(client, operation, input.now);
      await this.markPendingDelete(
        client,
        "organization_members",
        "organization_id",
        organizationId,
        userId,
        operation.id,
        input.now,
      );

      /**
       * Team usersets can grant access to many workbooks. Removing only the
       * organization tuple would leave those team paths valid in OpenFGA, so
       * the same atomic mutation deletes every team membership in this tenant.
       * Direct workbook shares intentionally remain: the model supports an
       * explicitly shared external user even without organization membership.
       */
      for (const membership of inheritedMemberships.rows) {
        await this.markPendingDelete(
          client,
          "team_members",
          "team_id",
          membership.team_id,
          userId,
          operation.id,
          input.now,
        );
      }

      return {
        value: { organizationId, userId, role },
        operation,
      };
    });
  }

  public async setTeamMembership(
    input: SetTeamMembershipInput,
  ): Promise<StagedMutation<TeamMembership>> {
    return this.transaction(async (client) => {
      const organizationId = await this.requireActiveTeam(client, input.teamId);
      await this.requireActiveOrganizationMember(
        client,
        organizationId,
        input.userId,
      );
      const existing = await this.lockRole(
        client,
        "team_members",
        "team_id",
        input.teamId,
        input.userId,
      );

      this.requireMutableRelationship(existing);
      const value: TeamMembership = {
        teamId: input.teamId,
        userId: input.userId,
        role: input.role,
      };

      if (existing?.role === input.role) {
        return { value };
      }

      const operation: PendingRelationshipOperation = {
        id: input.operationId,
        ...input.buildMutation(
          (existing?.role as TeamRole | undefined) ?? null,
        ),
      };
      await this.insertOperation(client, operation, input.now);
      await client.query(
        `
          INSERT INTO team_members (
            team_id,
            user_id,
            role,
            authorization_state,
            authorization_operation_id,
            created_at,
            updated_at
          )
          VALUES ($1, $2, $3, 'pending', $4, $5, $5)
          ON CONFLICT (team_id, user_id) DO UPDATE
          SET role = EXCLUDED.role,
              authorization_state = 'pending',
              authorization_operation_id = EXCLUDED.authorization_operation_id,
              updated_at = EXCLUDED.updated_at
        `,
        [input.teamId, input.userId, input.role, operation.id, input.now],
      );

      return { value, operation };
    });
  }

  public async removeTeamMembership(
    teamId: string,
    userId: string,
    input: { operationId: string; now: Date },
  ): Promise<StagedMutation<TeamMembership>> {
    return this.transaction(async (client) => {
      await this.requireActiveTeam(client, teamId);
      const existing = await this.lockRequiredRole(
        client,
        "team_members",
        "team_id",
        teamId,
        userId,
      );
      this.requireMutableRelationship(existing);
      const role = existing.role as TeamRole;
      const operation: PendingRelationshipOperation = {
        id: input.operationId,
        ...teamMembershipMutation(teamId, userId, role, null),
      };
      await this.insertOperation(client, operation, input.now);
      await this.markPendingDelete(
        client,
        "team_members",
        "team_id",
        teamId,
        userId,
        operation.id,
        input.now,
      );

      return { value: { teamId, userId, role }, operation };
    });
  }

  public async setWorkbookShare(
    input: SetWorkbookShareInput,
  ): Promise<StagedMutation<WorkbookShare>> {
    return this.transaction(async (client) => {
      const workbook = await this.requireActiveWorkbook(
        client,
        input.workbookId,
      );

      if (input.principal.type === "user") {
        await this.requireProductUser(client, input.principal.id);

        if (workbook.created_by === input.principal.id) {
          throw new ProductConflictError(
            "The workbook owner already has full access and cannot be shared a lower role.",
          );
        }
      } else {
        const teamOrganizationId = await this.requireActiveTeam(
          client,
          input.principal.id,
        );

        if (teamOrganizationId !== workbook.organization_id) {
          throw new ProductConflictError(
            "A team share must use a team from the workbook organization.",
          );
        }

        const encryptedWorkbook = await client.query(
          "SELECT 1 FROM workbook_encryption WHERE workbook_id = $1",
          [input.workbookId],
        );
        if (encryptedWorkbook.rowCount !== 0) {
          // One OpenFGA team userset can expand to many changing users, while
          // HPKE requires one explicit envelope and Google permission per human.
          // Until a membership fan-out reconciler exists, accepting this share
          // would authorize users who cannot decrypt and cannot open the file.
          throw new ProductConflictError(
            "Encrypted team sharing requires per-member envelope synchronization and is not available yet.",
          );
        }
      }

      const table = this.shareTable(input.principal);
      const keyColumn = this.shareKeyColumn(input.principal);
      const existing = await this.lockRole(
        client,
        table,
        "workbook_id",
        input.workbookId,
        input.principal.id,
        keyColumn,
      );

      this.requireMutableRelationship(existing);
      const value: WorkbookShare = {
        workbookId: input.workbookId,
        principal: input.principal,
        role: input.role,
      };

      if (existing?.role === input.role) {
        return { value };
      }

      const operation: PendingRelationshipOperation = {
        id: input.operationId,
        ...input.buildMutation(
          (existing?.role as WorkbookShareRole | undefined) ?? null,
        ),
      };
      await this.insertOperation(client, operation, input.now);
      await client.query(
        `
          INSERT INTO ${table} (
            workbook_id,
            ${keyColumn},
            role,
            authorization_state,
            authorization_operation_id,
            created_at,
            updated_at
          )
          VALUES ($1, $2, $3, 'pending', $4, $5, $5)
          ON CONFLICT (workbook_id, ${keyColumn}) DO UPDATE
          SET role = EXCLUDED.role,
              authorization_state = 'pending',
              authorization_operation_id = EXCLUDED.authorization_operation_id,
              updated_at = EXCLUDED.updated_at
        `,
        [
          input.workbookId,
          input.principal.id,
          input.role,
          operation.id,
          input.now,
        ],
      );

      return { value, operation };
    });
  }

  public async removeWorkbookShare(
    workbookId: string,
    principal: WorkbookSharePrincipal,
    input: { operationId: string; now: Date },
  ): Promise<StagedMutation<WorkbookShare>> {
    return this.transaction(async (client) => {
      await this.requireActiveWorkbook(client, workbookId);
      const table = this.shareTable(principal);
      const keyColumn = this.shareKeyColumn(principal);
      const existing = await this.lockRequiredRole(
        client,
        table,
        "workbook_id",
        workbookId,
        principal.id,
        keyColumn,
      );
      this.requireMutableRelationship(existing);
      const role = existing.role as WorkbookShareRole;
      const operation: PendingRelationshipOperation = {
        id: input.operationId,
        ...workbookShareMutation(workbookId, principal, role, null),
      };
      await this.insertOperation(client, operation, input.now);
      await this.markPendingDelete(
        client,
        table,
        "workbook_id",
        workbookId,
        principal.id,
        operation.id,
        input.now,
        keyColumn,
      );

      return { value: { workbookId, principal, role }, operation };
    });
  }

  public async listPendingRelationshipOperations(
    now: Date,
    limit: number,
  ): Promise<PendingRelationshipOperation[]> {
    const result = await this.pool.query<PendingOperationRow>(
      `
        SELECT id, writes, deletes
        FROM relationship_outbox
        WHERE status = 'pending' AND next_attempt_at <= $1
        ORDER BY created_at
        LIMIT $2
      `,
      [now, limit],
    );

    return result.rows.map((row) => ({
      id: row.id,
      writes: this.parseTupleArray(row.writes),
      deletes: this.parseTupleArray(row.deletes),
    }));
  }

  public async completeRelationshipOperation(
    operationId: string,
    now: Date,
  ): Promise<void> {
    await this.transaction(async (client) => {
      const operation = await client.query<{ status: string }>(
        `
          SELECT status
          FROM relationship_outbox
          WHERE id = $1
          FOR UPDATE
        `,
        [operationId],
      );

      if (operation.rows[0]?.status === "applied") {
        return;
      }

      if (!operation.rows[0]) {
        throw new Error(
          "Relationship operation disappeared before completion.",
        );
      }

      /**
       * One operation may activate an entity and its initial relationship row.
       * Updates use the operation UUID rather than resource IDs, ensuring a
       * stale completer cannot activate a newer mutation on the same record.
       */
      for (const table of ["organizations", "teams", "workbooks"] as const) {
        await client.query(
          `
            UPDATE ${table}
            SET authorization_state = 'active', updated_at = $2
            WHERE authorization_operation_id = $1
              AND authorization_state = 'pending'
          `,
          [operationId, now],
        );
      }

      for (const table of [
        "organization_members",
        "team_members",
        "workbook_user_shares",
        "workbook_team_shares",
      ] as const) {
        await client.query(
          `
            DELETE FROM ${table}
            WHERE authorization_operation_id = $1
              AND authorization_state = 'pending_delete'
          `,
          [operationId],
        );
        await client.query(
          `
            UPDATE ${table}
            SET authorization_state = 'active', updated_at = $2
            WHERE authorization_operation_id = $1
              AND authorization_state = 'pending'
          `,
          [operationId, now],
        );
      }

      await client.query(
        `
          UPDATE relationship_outbox
          SET status = 'applied',
              attempt_count = attempt_count + 1,
              last_error_code = NULL,
              applied_at = $2
          WHERE id = $1
        `,
        [operationId, now],
      );
    });
  }

  public async recordRelationshipOperationFailure(
    operationId: string,
    errorCode: string,
    nextAttemptAt: Date,
  ): Promise<void> {
    await this.pool.query(
      `
        UPDATE relationship_outbox
        SET attempt_count = attempt_count + 1,
            last_error_code = $2,
            next_attempt_at = $3
        WHERE id = $1 AND status = 'pending'
      `,
      [operationId, errorCode, nextAttemptAt],
    );
  }

  private async insertOperation(
    client: PoolClient,
    operation: PendingRelationshipOperation,
    now: Date,
  ): Promise<void> {
    if (operation.writes.length + operation.deletes.length === 0) {
      throw new Error(
        "A relationship operation must contain a tuple mutation.",
      );
    }

    await client.query(
      `
        INSERT INTO relationship_outbox (
          id,
          writes,
          deletes,
          status,
          next_attempt_at,
          created_at
        )
        VALUES ($1, $2::jsonb, $3::jsonb, 'pending', $4, $4)
      `,
      [
        operation.id,
        JSON.stringify(operation.writes),
        JSON.stringify(operation.deletes),
        now,
      ],
    );
  }

  private async requireActiveOrganization(
    client: PoolClient,
    organizationId: string,
  ): Promise<void> {
    const result = await client.query(
      `
        SELECT 1
        FROM organizations
        WHERE id = $1 AND authorization_state = 'active'
      `,
      [organizationId],
    );

    if (result.rowCount !== 1) {
      throw new ProductNotFoundError();
    }
  }

  private async requireActiveTeam(
    client: PoolClient,
    teamId: string,
  ): Promise<string> {
    const result = await client.query<{ organization_id: string }>(
      `
        SELECT organization_id
        FROM teams
        WHERE id = $1 AND authorization_state = 'active'
      `,
      [teamId],
    );
    const row = result.rows[0];

    if (!row) {
      throw new ProductNotFoundError();
    }

    return row.organization_id;
  }

  private async requireActiveWorkbook(
    client: PoolClient,
    workbookId: string,
  ): Promise<{ organization_id: string; created_by: string }> {
    const result = await client.query<{
      organization_id: string;
      created_by: string;
    }>(
      `
        SELECT organization_id, created_by
        FROM workbooks
        WHERE id = $1 AND authorization_state = 'active'
      `,
      [workbookId],
    );
    const row = result.rows[0];

    if (!row) {
      throw new ProductNotFoundError();
    }

    return row;
  }

  private async requireProductUser(
    client: PoolClient,
    userId: string,
  ): Promise<void> {
    const result = await client.query(
      "SELECT 1 FROM product_users WHERE id = $1",
      [userId],
    );

    if (result.rowCount !== 1) {
      throw new ProductNotFoundError();
    }
  }

  private async requireActiveOrganizationMember(
    client: PoolClient,
    organizationId: string,
    userId: string,
  ): Promise<void> {
    const result = await client.query(
      `
        SELECT 1
        FROM organization_members
        WHERE organization_id = $1
          AND user_id = $2
          AND authorization_state = 'active'
      `,
      [organizationId, userId],
    );

    if (result.rowCount !== 1) {
      throw new ProductConflictError(
        "A team member must first be an active organization member.",
      );
    }
  }

  private async lockRole(
    client: PoolClient,
    table: string,
    resourceColumn: string,
    resourceId: string,
    userId: string,
    userColumn = "user_id",
  ): Promise<RoleStateRow | null> {
    /**
     * Table and column names come only from closed constants in this class;
     * identifiers cannot be parameterized by PostgreSQL. All request-derived
     * values remain ordinary `$n` parameters below.
     */
    const result = await client.query<RoleStateRow>(
      `
        SELECT role, authorization_state
        FROM ${table}
        WHERE ${resourceColumn} = $1 AND ${userColumn} = $2
        FOR UPDATE
      `,
      [resourceId, userId],
    );

    return result.rows[0] ?? null;
  }

  private async lockRequiredRole(
    client: PoolClient,
    table: string,
    resourceColumn: string,
    resourceId: string,
    userId: string,
    userColumn = "user_id",
  ): Promise<RoleStateRow> {
    const row = await this.lockRole(
      client,
      table,
      resourceColumn,
      resourceId,
      userId,
      userColumn,
    );

    if (!row) {
      throw new ProductNotFoundError();
    }

    return row;
  }

  private requireMutableRelationship(row: RoleStateRow | null): void {
    if (row && row.authorization_state !== "active") {
      throw new ProductConflictError();
    }
  }

  private async markPendingDelete(
    client: PoolClient,
    table: string,
    resourceColumn: string,
    resourceId: string,
    relatedId: string,
    operationId: string,
    now: Date,
    relatedColumn = "user_id",
  ): Promise<void> {
    await client.query(
      `
        UPDATE ${table}
        SET authorization_state = 'pending_delete',
            authorization_operation_id = $3,
            updated_at = $4
        WHERE ${resourceColumn} = $1 AND ${relatedColumn} = $2
      `,
      [resourceId, relatedId, operationId, now],
    );
  }

  private shareTable(principal: WorkbookSharePrincipal): string {
    return principal.type === "user"
      ? "workbook_user_shares"
      : "workbook_team_shares";
  }

  private shareKeyColumn(principal: WorkbookSharePrincipal): string {
    return principal.type === "user" ? "user_id" : "team_id";
  }

  private parseTupleArray(value: unknown) {
    if (!Array.isArray(value) || !value.every(isAuthorizationTuple)) {
      throw new Error("A relationship outbox tuple payload is malformed.");
    }

    return value;
  }

  private translateUniqueNameViolation(
    error: unknown,
    constraint: string,
    message: string,
  ): void {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "23505" &&
      "constraint" in error &&
      error.constraint === constraint
    ) {
      throw new ProductConflictError(message);
    }
  }

  private async transaction<T>(
    operation: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // The original domain/database error is more useful than a secondary
        // rollback failure from an already-broken connection.
      }
      throw error;
    } finally {
      client.release();
    }
  }
}
