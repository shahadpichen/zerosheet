import { randomUUID } from "node:crypto";
import type { AuthenticatedUser } from "@zerosheet/contracts";
import type {
  AuthorizationApplicationService,
  AuthorizationGateway,
} from "../authorization/types.js";
import {
  ProductDependencyError,
  ProductForbiddenError,
  ProductNotFoundError,
} from "./errors.js";
import {
  organizationMembershipMutation,
  provisionOrganizationMutation,
  provisionTeamMutation,
  provisionWorkbookMutation,
  teamMembershipMutation,
  workbookShareMutation,
} from "./relationship-tuples.js";
import type {
  CreateNamedResourceInput,
  Organization,
  OrganizationMembership,
  PendingRelationshipOperation,
  ProductApplicationService,
  ProductRepository,
  StagedMutation,
  Team,
  TeamMembership,
  TeamRole,
  Workbook,
  WorkbookShare,
  WorkbookSharePrincipal,
  WorkbookShareRole,
} from "./types.js";

export interface ProductServiceOptions {
  repository: ProductRepository;

  /**
   * Decisions and relationship writes are intentionally different ports. A
   * decision must pass through the OpenFGA + PostgreSQL + OPA composition,
   * while the transactional outbox still needs the narrow OpenFGA write port.
   */
  decisions: AuthorizationApplicationService;
  relationships: AuthorizationGateway;

  // Injecting time and UUID generation makes outbox transitions deterministic
  // in tests without replacing secure production randomness or global clocks.
  now?: () => Date;
  id?: () => string;
}

/**
 * ProductService coordinates product state, composed decisions, and OpenFGA
 * tuple mutations. Routes never call either authorization dependency directly.
 * The ordering is deliberate: authorize the trusted session principal, stage
 * a durable intent, apply it idempotently, then expose the activated resource.
 */
export class ProductService implements ProductApplicationService {
  private readonly repository: ProductRepository;
  private readonly decisions: AuthorizationApplicationService;
  private readonly relationships: AuthorizationGateway;
  private readonly now: () => Date;
  private readonly id: () => string;

  public constructor(options: ProductServiceOptions) {
    this.repository = options.repository;
    this.decisions = options.decisions;
    this.relationships = options.relationships;
    this.now = options.now ?? (() => new Date());
    this.id = options.id ?? randomUUID;
  }

  public async createOrganization(
    actor: AuthenticatedUser,
    input: CreateNamedResourceInput,
  ): Promise<Organization> {
    await this.requireAllowed(
      this.decisions.canCreateOrganization({ userId: actor.id }),
    );

    const organization: Organization = {
      id: this.id(),
      name: input.name,
    };
    const operation = this.operation(
      provisionOrganizationMutation(organization.id, actor.id),
    );
    const staged = await this.repository.createOrganization({
      organization,
      ownerId: actor.id,
      operation,
      now: this.now(),
    });

    return this.applyStaged(staged);
  }

  public async createTeam(
    actor: AuthenticatedUser,
    organizationId: string,
    input: CreateNamedResourceInput,
  ): Promise<Team> {
    await this.requireAllowed(
      this.decisions.canAccessOrganization({
        userId: actor.id,
        organizationId,
        permission: "can_manage_members",
      }),
    );

    const team: Team = {
      id: this.id(),
      organizationId,
      name: input.name,
    };
    const operation = this.operation(
      provisionTeamMutation(team.id, organizationId, actor.id),
    );
    const staged = await this.repository.createTeam({
      team,
      managerId: actor.id,
      operation,
      now: this.now(),
    });

    return this.applyStaged(staged);
  }

  public async createWorkbook(
    actor: AuthenticatedUser,
    organizationId: string,
    input: CreateNamedResourceInput,
  ): Promise<Workbook> {
    await this.requireAllowed(
      this.decisions.canAccessOrganization({
        userId: actor.id,
        organizationId,
        permission: "can_create_workbook",
      }),
    );

    const workbook: Workbook = {
      id: this.id(),
      organizationId,
      name: input.name,
      createdBy: actor.id,
    };
    const operation = this.operation(
      provisionWorkbookMutation(workbook.id, organizationId, actor.id),
    );
    const staged = await this.repository.createWorkbook({
      workbook,
      operation,
      now: this.now(),
    });

    return this.applyStaged(staged);
  }

  public async getWorkbook(
    actor: AuthenticatedUser,
    workbookId: string,
  ): Promise<Workbook> {
    await this.requireAllowed(
      this.decisions.canAccessWorkbook({
        userId: actor.id,
        workbookId,
        permission: "can_view",
      }),
    );
    const workbook = await this.repository.findActiveWorkbook(workbookId);

    if (!workbook) {
      // A stale or orphaned relationship must never make missing/pending
      // product metadata appear. Only active PostgreSQL rows are readable.
      throw new ProductNotFoundError();
    }

    return workbook;
  }

  public async setOrganizationMember(
    actor: AuthenticatedUser,
    organizationId: string,
    userId: string,
    role: "admin" | "member",
  ): Promise<OrganizationMembership> {
    await this.requireAllowed(
      this.decisions.canAccessOrganization({
        userId: actor.id,
        organizationId,
        permission: "can_manage_members",
      }),
    );
    const staged = await this.repository.setOrganizationMembership({
      organizationId,
      userId,
      role,
      operationId: this.id(),
      now: this.now(),
      buildMutation: (previousRole) =>
        organizationMembershipMutation(
          organizationId,
          userId,
          previousRole,
          role,
        ),
    });

    return this.applyStaged(staged);
  }

  public async removeOrganizationMember(
    actor: AuthenticatedUser,
    organizationId: string,
    userId: string,
  ): Promise<void> {
    await this.requireAllowed(
      this.decisions.canAccessOrganization({
        userId: actor.id,
        organizationId,
        permission: "can_manage_members",
      }),
    );
    const staged = await this.repository.removeOrganizationMembership(
      organizationId,
      userId,
      { operationId: this.id(), now: this.now() },
    );
    await this.applyStaged(staged);
  }

  public async setTeamMember(
    actor: AuthenticatedUser,
    teamId: string,
    userId: string,
    role: TeamRole,
  ): Promise<TeamMembership> {
    await this.requireAllowed(
      this.decisions.canAccessTeam({
        userId: actor.id,
        teamId,
        permission: "can_manage",
      }),
    );
    const staged = await this.repository.setTeamMembership({
      teamId,
      userId,
      role,
      operationId: this.id(),
      now: this.now(),
      buildMutation: (previousRole) =>
        teamMembershipMutation(teamId, userId, previousRole, role),
    });

    return this.applyStaged(staged);
  }

  public async removeTeamMember(
    actor: AuthenticatedUser,
    teamId: string,
    userId: string,
  ): Promise<void> {
    await this.requireAllowed(
      this.decisions.canAccessTeam({
        userId: actor.id,
        teamId,
        permission: "can_manage",
      }),
    );
    const staged = await this.repository.removeTeamMembership(teamId, userId, {
      operationId: this.id(),
      now: this.now(),
    });
    await this.applyStaged(staged);
  }

  public async setWorkbookShare(
    actor: AuthenticatedUser,
    workbookId: string,
    principal: WorkbookSharePrincipal,
    role: WorkbookShareRole,
  ): Promise<WorkbookShare> {
    await this.requireWorkbookSharing(actor, workbookId);
    const staged = await this.repository.setWorkbookShare({
      workbookId,
      principal,
      role,
      operationId: this.id(),
      now: this.now(),
      buildMutation: (previousRole) =>
        workbookShareMutation(workbookId, principal, previousRole, role),
    });

    return this.applyStaged(staged);
  }

  public async removeWorkbookShare(
    actor: AuthenticatedUser,
    workbookId: string,
    principal: WorkbookSharePrincipal,
  ): Promise<void> {
    await this.requireWorkbookSharing(actor, workbookId);
    const staged = await this.repository.removeWorkbookShare(
      workbookId,
      principal,
      { operationId: this.id(), now: this.now() },
    );
    await this.applyStaged(staged);
  }

  public async reconcilePendingOperations(limit = 50): Promise<number> {
    const operations = await this.repository.listPendingRelationshipOperations(
      this.now(),
      limit,
    );
    let completed = 0;

    for (const operation of operations) {
      try {
        await this.relationships.applyRelationshipMutation(operation);
        await this.repository.completeRelationshipOperation(
          operation.id,
          this.now(),
        );
        completed += 1;
      } catch {
        await this.recordRetry(operation.id);
      }
    }

    return completed;
  }

  private operation(mutation: {
    writes: PendingRelationshipOperation["writes"];
    deletes: PendingRelationshipOperation["deletes"];
  }): PendingRelationshipOperation {
    return { id: this.id(), ...mutation };
  }

  private async applyStaged<T>(staged: StagedMutation<T>): Promise<T> {
    if (!staged.operation) {
      // Repeating a PUT with the already-active role is a genuine idempotent
      // success and needs neither a new outbox row nor an OpenFGA request.
      return staged.value;
    }

    try {
      await this.relationships.applyRelationshipMutation(staged.operation);
    } catch {
      await this.recordRetry(staged.operation.id);
      throw new ProductDependencyError();
    }

    try {
      await this.repository.completeRelationshipOperation(
        staged.operation.id,
        this.now(),
      );
    } catch {
      /**
       * OpenFGA may already contain the tuple. Leaving the durable operation
       * pending is intentional; reconciliation replays it idempotently and
       * then activates PostgreSQL rather than attempting a dangerous guess at
       * compensation after an ambiguous commit.
       */
      throw new ProductDependencyError();
    }

    return staged.value;
  }

  private async requireAllowed(decision: Promise<boolean>): Promise<void> {
    try {
      if (!(await decision)) {
        throw new ProductForbiddenError();
      }
    } catch (error) {
      if (error instanceof ProductForbiddenError) {
        throw error;
      }

      // A broken PDP is availability loss, never permission. Product routes
      // return a retryable dependency error without exposing OpenFGA details.
      throw new ProductDependencyError();
    }
  }

  private requireWorkbookSharing(
    actor: AuthenticatedUser,
    workbookId: string,
  ): Promise<void> {
    return this.requireAllowed(
      this.decisions.canAccessWorkbook({
        userId: actor.id,
        workbookId,
        permission: "can_manage_sharing",
      }),
    );
  }

  private async recordRetry(operationId: string): Promise<void> {
    try {
      await this.repository.recordRelationshipOperationFailure(
        operationId,
        "openfga_write_failed",
        new Date(this.now().getTime() + 30_000),
      );
    } catch {
      // The original synchronization failure remains the public result. The
      // pending row's existing next_attempt_at still makes it discoverable if
      // PostgreSQL came back after this best-effort bookkeeping attempt.
    }
  }
}
