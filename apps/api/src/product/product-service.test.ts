import type { AuthenticatedUser } from "@zerosheet/contracts";
import { describe, expect, it } from "vitest";
import type {
  AuthorizationApplicationService,
  AuthorizationGateway,
  CheckOrganizationPermissionInput,
  CheckTeamPermissionInput,
  CheckWorkbookPermissionInput,
  RelationshipMutation,
} from "../authorization/types.js";
import { ProductDependencyError, ProductForbiddenError } from "./errors.js";
import { ProductService } from "./product-service.js";
import {
  organizationMembershipMutation,
  teamMembershipMutation,
  workbookShareMutation,
} from "./relationship-tuples.js";
import type {
  CreateOrganizationRecordInput,
  CreateTeamRecordInput,
  CreateWorkbookRecordInput,
  PendingRelationshipOperation,
  ProductRepository,
  SetOrganizationMembershipInput,
  SetTeamMembershipInput,
  SetWorkbookShareInput,
  WorkbookSharePrincipal,
} from "./types.js";

const actor: AuthenticatedUser = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "owner@zerosheet.local",
  displayName: "Owner",
};
const targetUserId = "22222222-2222-4222-8222-222222222222";
const organizationId = "33333333-3333-4333-8333-333333333333";
const teamId = "44444444-4444-4444-8444-444444444444";
const workbookId = "55555555-5555-4555-8555-555555555555";
const operationId = "66666666-6666-4666-8666-666666666666";
const now = new Date("2026-09-02T10:00:00.000Z");

class FakeAuthorizationGateway
  implements AuthorizationGateway, AuthorizationApplicationService
{
  public allowed = true;
  public failDecision = false;
  public failMutation = false;
  public organizationCheck: CheckOrganizationPermissionInput | undefined;
  public teamCheck: CheckTeamPermissionInput | undefined;
  public workbookCheck: CheckWorkbookPermissionInput | undefined;
  public mutations: RelationshipMutation[] = [];

  public canCreateOrganization() {
    return this.decision();
  }

  public canAccessOrganization(input: CheckOrganizationPermissionInput) {
    return this.checkOrganizationPermission(input);
  }

  public canAccessTeam(input: CheckTeamPermissionInput) {
    return this.checkTeamPermission(input);
  }

  public canAccessWorkbook(input: CheckWorkbookPermissionInput) {
    return this.checkWorkbookPermission(input);
  }

  public assertReady(): Promise<void> {
    return Promise.resolve();
  }

  public checkOrganizationPermission(input: CheckOrganizationPermissionInput) {
    this.organizationCheck = input;
    return this.decision();
  }

  public checkTeamPermission(input: CheckTeamPermissionInput) {
    this.teamCheck = input;
    return this.decision();
  }

  public checkWorkbookPermission(input: CheckWorkbookPermissionInput) {
    this.workbookCheck = input;
    return this.decision();
  }

  public applyRelationshipMutation(mutation: RelationshipMutation) {
    this.mutations.push(mutation);
    return this.failMutation
      ? Promise.reject(new Error("OpenFGA unavailable"))
      : Promise.resolve();
  }

  private decision(): Promise<boolean> {
    return this.failDecision
      ? Promise.reject(new Error("OpenFGA unavailable"))
      : Promise.resolve(this.allowed);
  }
}

class FakeProductRepository implements ProductRepository {
  public createTeamCalls = 0;
  public teamMembershipIsNoop = false;
  public pendingOperations: PendingRelationshipOperation[] = [];
  public completedOperations: Array<{ id: string; at: Date }> = [];
  public failedOperations: Array<{
    id: string;
    errorCode: string;
    nextAttemptAt: Date;
  }> = [];

  public assertReady(): Promise<void> {
    return Promise.resolve();
  }

  public createOrganization(input: CreateOrganizationRecordInput) {
    return Promise.resolve({
      value: input.organization,
      operation: input.operation,
    });
  }

  public createTeam(input: CreateTeamRecordInput) {
    this.createTeamCalls += 1;
    return Promise.resolve({ value: input.team, operation: input.operation });
  }

  public createWorkbook(input: CreateWorkbookRecordInput) {
    return Promise.resolve({
      value: input.workbook,
      operation: input.operation,
    });
  }

  public findActiveWorkbook() {
    return Promise.resolve({
      id: workbookId,
      organizationId,
      name: "Budget",
      createdBy: actor.id,
    });
  }

  public setOrganizationMembership(input: SetOrganizationMembershipInput) {
    return Promise.resolve({
      value: {
        organizationId: input.organizationId,
        userId: input.userId,
        role: input.role,
      },
      operation: {
        id: input.operationId,
        ...input.buildMutation("member"),
      },
    });
  }

  public removeOrganizationMembership(
    requestedOrganizationId: string,
    userId: string,
    input: { operationId: string; now: Date },
  ) {
    return Promise.resolve({
      value: {
        organizationId: requestedOrganizationId,
        userId,
        role: "member" as const,
      },
      operation: {
        id: input.operationId,
        ...organizationMembershipMutation(
          requestedOrganizationId,
          userId,
          "member",
          null,
        ),
      },
    });
  }

  public setTeamMembership(input: SetTeamMembershipInput) {
    const value = {
      teamId: input.teamId,
      userId: input.userId,
      role: input.role,
    };

    if (this.teamMembershipIsNoop) {
      return Promise.resolve({ value });
    }

    return Promise.resolve({
      value,
      operation: {
        id: input.operationId,
        ...input.buildMutation(null),
      },
    });
  }

  public removeTeamMembership(
    requestedTeamId: string,
    userId: string,
    input: { operationId: string; now: Date },
  ) {
    return Promise.resolve({
      value: { teamId: requestedTeamId, userId, role: "member" as const },
      operation: {
        id: input.operationId,
        ...teamMembershipMutation(requestedTeamId, userId, "member", null),
      },
    });
  }

  public setWorkbookShare(input: SetWorkbookShareInput) {
    return Promise.resolve({
      value: {
        workbookId: input.workbookId,
        principal: input.principal,
        role: input.role,
      },
      operation: {
        id: input.operationId,
        ...input.buildMutation(null),
      },
    });
  }

  public removeWorkbookShare(
    requestedWorkbookId: string,
    principal: WorkbookSharePrincipal,
    input: { operationId: string; now: Date },
  ) {
    return Promise.resolve({
      value: {
        workbookId: requestedWorkbookId,
        principal,
        role: "viewer" as const,
      },
      operation: {
        id: input.operationId,
        ...workbookShareMutation(
          requestedWorkbookId,
          principal,
          "viewer",
          null,
        ),
      },
    });
  }

  public listPendingRelationshipOperations() {
    return Promise.resolve(this.pendingOperations);
  }

  public completeRelationshipOperation(id: string, at: Date) {
    this.completedOperations.push({ id, at });
    return Promise.resolve();
  }

  public recordRelationshipOperationFailure(
    id: string,
    errorCode: string,
    nextAttemptAt: Date,
  ) {
    this.failedOperations.push({ id, errorCode, nextAttemptAt });
    return Promise.resolve();
  }
}

function serviceWith(
  repository = new FakeProductRepository(),
  authorization = new FakeAuthorizationGateway(),
) {
  const ids = [organizationId, operationId];
  const service = new ProductService({
    repository,
    decisions: authorization,
    relationships: authorization,
    now: () => now,
    id: () => ids.shift() ?? operationId,
  });
  return { service, repository, authorization };
}

describe("ProductService relationship lifecycle", () => {
  it("creates an organization and owner tuple before returning it", async () => {
    const { service, repository, authorization } = serviceWith();

    await expect(
      service.createOrganization(actor, { name: "Acme" }),
    ).resolves.toEqual({ id: organizationId, name: "Acme" });
    expect(authorization.mutations).toEqual([
      {
        id: operationId,
        writes: [
          {
            user: `user:${actor.id}`,
            relation: "owner",
            object: `organization:${organizationId}`,
          },
        ],
        deletes: [],
      },
    ]);
    expect(repository.completedOperations).toEqual([
      { id: operationId, at: now },
    ]);
  });

  it("checks organization administration before creating a team", async () => {
    const { service, repository, authorization } = serviceWith();
    authorization.allowed = false;

    await expect(
      service.createTeam(actor, organizationId, { name: "Finance" }),
    ).rejects.toBeInstanceOf(ProductForbiddenError);
    expect(authorization.organizationCheck).toEqual({
      userId: actor.id,
      organizationId,
      permission: "can_manage_members",
    });
    expect(repository.createTeamCalls).toBe(0);
  });

  it("replaces an organization member role in one tuple mutation", async () => {
    const { service, authorization } = serviceWith();

    await service.setOrganizationMember(
      actor,
      organizationId,
      targetUserId,
      "admin",
    );

    expect(authorization.mutations[0]).toMatchObject({
      writes: [
        {
          user: `user:${targetUserId}`,
          relation: "admin",
          object: `organization:${organizationId}`,
        },
      ],
      deletes: [
        {
          user: `user:${targetUserId}`,
          relation: "member",
          object: `organization:${organizationId}`,
        },
      ],
    });
  });

  it("checks sharing administration before creating a team userset share", async () => {
    const { service, authorization } = serviceWith();

    await service.setWorkbookShare(
      actor,
      workbookId,
      { type: "team", id: teamId },
      "editor",
    );

    expect(authorization.workbookCheck).toEqual({
      userId: actor.id,
      workbookId,
      permission: "can_manage_sharing",
    });
    expect(authorization.mutations[0]).toMatchObject({
      writes: [
        {
          user: `team:${teamId}#member`,
          relation: "editor",
          object: `workbook:${workbookId}`,
        },
      ],
    });
  });

  it("returns metadata only after a can_view decision", async () => {
    const { service, authorization } = serviceWith();

    await expect(service.getWorkbook(actor, workbookId)).resolves.toMatchObject(
      {
        id: workbookId,
        name: "Budget",
      },
    );
    expect(authorization.workbookCheck).toEqual({
      userId: actor.id,
      workbookId,
      permission: "can_view",
    });
  });

  it("leaves a retryable pending intent when OpenFGA is unavailable", async () => {
    const { service, repository, authorization } = serviceWith();
    authorization.failMutation = true;

    await expect(
      service.createOrganization(actor, { name: "Acme" }),
    ).rejects.toBeInstanceOf(ProductDependencyError);
    expect(repository.failedOperations).toEqual([
      {
        id: operationId,
        errorCode: "openfga_write_failed",
        nextAttemptAt: new Date("2026-09-02T10:00:30.000Z"),
      },
    ]);
    expect(repository.completedOperations).toHaveLength(0);
  });

  it("fails closed with a dependency error when a permission decision fails", async () => {
    const { service, repository, authorization } = serviceWith();
    authorization.failDecision = true;

    await expect(
      service.createWorkbook(actor, organizationId, { name: "Budget" }),
    ).rejects.toBeInstanceOf(ProductDependencyError);
    expect(repository.completedOperations).toHaveLength(0);
  });

  it("does not rewrite OpenFGA for an already-active idempotent PUT", async () => {
    const repository = new FakeProductRepository();
    repository.teamMembershipIsNoop = true;
    const { service, authorization } = serviceWith(repository);

    await service.setTeamMember(actor, teamId, targetUserId, "member");

    expect(authorization.mutations).toHaveLength(0);
  });

  it("replays pending outbox operations and marks successful ones complete", async () => {
    const repository = new FakeProductRepository();
    const pending: PendingRelationshipOperation = {
      id: operationId,
      writes: [
        {
          user: `user:${actor.id}`,
          relation: "owner",
          object: `organization:${organizationId}`,
        },
      ],
      deletes: [],
    };
    repository.pendingOperations = [pending];
    const { service } = serviceWith(repository);

    await expect(service.reconcilePendingOperations()).resolves.toBe(1);
    expect(repository.completedOperations).toEqual([
      { id: operationId, at: now },
    ]);
  });
});
