import type { AuthenticatedUser } from "@zerosheet/contracts";
import { describe, expect, it } from "vitest";
import type { AuditEventInput, AuditRecorder } from "../audit/types.js";
import type {
  AuthorizationApplicationService,
  CheckOrganizationPermissionInput,
} from "../authorization/types.js";
import {
  LifecycleNotFoundError,
  LifecycleUnauthorizedError,
} from "./errors.js";
import { LifecycleService } from "./lifecycle-service.js";
import type {
  CreateScimConnectionRecordInput,
  CreateScimManagedUserInput,
  LifecycleRepository,
  ManagedMembershipCoordinator,
  ReplaceScimManagedUserInput,
  ScimConnection,
  ScimManagedUser,
  ScimUserFilter,
} from "./types.js";

const actor: AuthenticatedUser = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "owner@zerosheet.local",
  displayName: "Owner",
};
const organizationId = "22222222-2222-4222-8222-222222222222";
const connectionId = "33333333-3333-4333-8333-333333333333";
const scimUserId = "44444444-4444-4444-8444-444444444444";
const productUserId = "55555555-5555-4555-8555-555555555555";
const now = new Date("2026-09-03T10:00:00.000Z");

class FakeAuthorization implements AuthorizationApplicationService {
  public allowed = true;
  public organizationInput: CheckOrganizationPermissionInput | undefined;

  public canCreateOrganization() {
    return Promise.resolve(this.allowed);
  }

  public canAccessOrganization(input: CheckOrganizationPermissionInput) {
    this.organizationInput = input;
    return Promise.resolve(this.allowed);
  }

  public canAccessTeam() {
    return Promise.resolve(this.allowed);
  }

  public canAccessWorkbook() {
    return Promise.resolve(this.allowed);
  }
}

class FakeAudit implements AuditRecorder {
  public events: AuditEventInput[] = [];

  public assertReady(): Promise<void> {
    return Promise.resolve();
  }

  public record(event: AuditEventInput): Promise<void> {
    this.events.push(event);
    return Promise.resolve();
  }
}

class FakeMemberships implements ManagedMembershipCoordinator {
  public provisioned: Array<{ organizationId: string; userId: string }> = [];
  public deprovisioned: Array<{ organizationId: string; userId: string }> = [];

  public provisionManagedOrganizationMember(
    requestedOrganizationId: string,
    userId: string,
  ): Promise<void> {
    this.provisioned.push({ organizationId: requestedOrganizationId, userId });
    return Promise.resolve();
  }

  public deprovisionManagedOrganizationMember(
    requestedOrganizationId: string,
    userId: string,
  ): Promise<void> {
    this.deprovisioned.push({
      organizationId: requestedOrganizationId,
      userId,
    });
    return Promise.resolve();
  }
}

class FakeLifecycleRepository implements LifecycleRepository {
  public connectionInput: CreateScimConnectionRecordInput | undefined;
  public requestedTokenHash: string | undefined;
  public createInput: CreateScimManagedUserInput | undefined;
  public replaceInput: ReplaceScimManagedUserInput | undefined;
  public connection: ScimConnection | null = {
    id: connectionId,
    organizationId,
    displayName: "Corporate directory",
    active: true,
  };
  public user: ScimManagedUser | null = null;

  public assertReady(): Promise<void> {
    return Promise.resolve();
  }

  public createConnection(input: CreateScimConnectionRecordInput) {
    this.connectionInput = input;
    return Promise.resolve(this.connection as ScimConnection);
  }

  public findConnectionByTokenHash(tokenHash: string) {
    this.requestedTokenHash = tokenHash;
    return Promise.resolve(this.connection);
  }

  public createManagedUser(input: CreateScimManagedUserInput) {
    this.createInput = input;
    this.user = this.makeUser(input.active);
    return Promise.resolve(this.user);
  }

  public replaceManagedUser(input: ReplaceScimManagedUserInput) {
    this.replaceInput = input;
    this.user = this.makeUser(input.active, 2);
    return Promise.resolve(this.user);
  }

  public findManagedUser() {
    return Promise.resolve(this.user);
  }

  public listManagedUsers(_connectionId: string, filter?: ScimUserFilter) {
    return Promise.resolve(filter && this.user ? [this.user] : []);
  }

  private makeUser(active: boolean, version = 1): ScimManagedUser {
    return {
      id: scimUserId,
      connectionId,
      organizationId,
      productUserId,
      externalId: "employee-42",
      userName: "employee@zerosheet.local",
      displayName: "Employee",
      active,
      version,
      createdAt: now,
      updatedAt: now,
    };
  }
}

function makeService() {
  const repository = new FakeLifecycleRepository();
  const authorization = new FakeAuthorization();
  const memberships = new FakeMemberships();
  const audit = new FakeAudit();
  const ids = [connectionId, scimUserId, productUserId];
  const service = new LifecycleService({
    repository,
    authorization,
    memberships,
    audit,
    now: () => now,
    id: () => ids.shift() ?? productUserId,
    token: () => "directory-secret",
  });
  return { service, repository, authorization, memberships, audit };
}

describe("LifecycleService", () => {
  it("creates a tenant-bound connection and persists only a token digest", async () => {
    const { service, repository, authorization, audit } = makeService();

    const connection = await service.createConnection(
      actor,
      organizationId,
      "Corporate directory",
    );

    expect(connection.bearerToken).toBe(
      `zs_scim_${connectionId}.directory-secret`,
    );
    expect(repository.connectionInput?.tokenHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(repository.connectionInput?.tokenHash).not.toContain(
      "directory-secret",
    );
    expect(authorization.organizationInput).toEqual({
      userId: actor.id,
      organizationId,
      permission: "can_manage_members",
    });
    expect(audit.events[0]?.action).toBe("scim.connection.create");
  });

  it("rejects malformed bearer credentials before querying PostgreSQL", async () => {
    const { service, repository } = makeService();

    await expect(
      service.authenticateConnection("not-scim"),
    ).rejects.toBeInstanceOf(LifecycleUnauthorizedError);
    expect(repository.requestedTokenHash).toBeUndefined();
  });

  it("creates an active managed user and provisions the member relationship", async () => {
    const { service, repository, memberships, audit } = makeService();
    const connection = repository.connection as ScimConnection;

    const user = await service.createUser(connection, {
      externalId: "employee-42",
      userName: "employee@zerosheet.local",
      displayName: "Employee",
      active: true,
    });

    expect(user.productUserId).toBe(productUserId);
    expect(memberships.provisioned).toEqual([
      { organizationId, userId: productUserId },
    ]);
    expect(audit.events.at(-1)?.reasonCode).toBe("user_active");
  });

  it("deactivates a managed user through tenant status and relationship cleanup", async () => {
    const { service, repository, memberships, audit } = makeService();
    repository.user = {
      id: scimUserId,
      connectionId,
      organizationId,
      productUserId,
      externalId: "employee-42",
      userName: "employee@zerosheet.local",
      displayName: "Employee",
      active: true,
      version: 1,
      createdAt: now,
      updatedAt: now,
    };

    await service.deactivateUser(
      repository.connection as ScimConnection,
      scimUserId,
    );

    expect(repository.replaceInput?.active).toBe(false);
    expect(memberships.deprovisioned).toEqual([
      { organizationId, userId: productUserId },
    ]);
    expect(audit.events.map((event) => event.action)).toContain(
      "scim.user.delete",
    );
    expect(audit.events.map((event) => event.action)).not.toContain(
      "scim.user.replace",
    );
  });

  it("does not reveal a user owned by another connection", async () => {
    const { service, repository } = makeService();
    repository.user = null;

    await expect(
      service.findUser(repository.connection as ScimConnection, scimUserId),
    ).rejects.toBeInstanceOf(LifecycleNotFoundError);
  });
});
