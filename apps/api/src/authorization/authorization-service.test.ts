import { describe, expect, it } from "vitest";
import { AuthorizationService } from "./authorization-service.js";
import type {
  AuthorizationGateway,
  ContextualPolicyGateway,
  ContextualPolicyInput,
  OrganizationPolicyContext,
  PlatformPolicyContext,
  PolicyContextRepository,
} from "./types.js";

const userId = "11111111-1111-4111-8111-111111111111";
const organizationId = "22222222-2222-4222-8222-222222222222";
const workbookId = "33333333-3333-4333-8333-333333333333";

class FakeRelationshipGateway implements AuthorizationGateway {
  public allowed = true;
  public checks = 0;

  public assertReady(): Promise<void> {
    return Promise.resolve();
  }

  public checkOrganizationPermission(): Promise<boolean> {
    return this.decision();
  }

  public checkTeamPermission(): Promise<boolean> {
    return this.decision();
  }

  public checkWorkbookPermission(): Promise<boolean> {
    return this.decision();
  }

  public applyRelationshipMutation(): Promise<void> {
    return Promise.resolve();
  }

  private decision(): Promise<boolean> {
    this.checks += 1;
    return Promise.resolve(this.allowed);
  }
}

class FakeContextRepository implements PolicyContextRepository {
  public platformCalls = 0;
  public resourceCalls = 0;
  public platform: PlatformPolicyContext | null = {
    subject: { id: userId, status: "active" },
  };
  public resource: OrganizationPolicyContext | null = {
    subject: { id: userId, status: "active" },
    organization: { id: organizationId, status: "active" },
  };

  public assertReady(): Promise<void> {
    return Promise.resolve();
  }

  public findPlatformContext(): Promise<PlatformPolicyContext | null> {
    this.platformCalls += 1;
    return Promise.resolve(this.platform);
  }

  public findOrganizationContext(): Promise<OrganizationPolicyContext | null> {
    return this.findResource();
  }

  public findTeamContext(): Promise<OrganizationPolicyContext | null> {
    return this.findResource();
  }

  public findWorkbookContext(): Promise<OrganizationPolicyContext | null> {
    return this.findResource();
  }

  private findResource(): Promise<OrganizationPolicyContext | null> {
    this.resourceCalls += 1;
    return Promise.resolve(this.resource);
  }
}

class FakeContextualPolicy implements ContextualPolicyGateway {
  public allowed = true;
  public inputs: ContextualPolicyInput[] = [];

  public assertReady(): Promise<void> {
    return Promise.resolve();
  }

  public evaluate(input: ContextualPolicyInput): Promise<boolean> {
    this.inputs.push(input);
    return Promise.resolve(this.allowed);
  }
}

function makeService() {
  const relationships = new FakeRelationshipGateway();
  const context = new FakeContextRepository();
  const policy = new FakeContextualPolicy();
  const service = new AuthorizationService({ relationships, context, policy });
  return { service, relationships, context, policy };
}

describe("AuthorizationService decision composition", () => {
  it("allows organization creation only through the platform policy", async () => {
    const { service, relationships, context, policy } = makeService();

    await expect(service.canCreateOrganization({ userId })).resolves.toBe(true);

    expect(relationships.checks).toBe(0);
    expect(context.platformCalls).toBe(1);
    expect(policy.inputs).toEqual([
      {
        subject: { id: userId, status: "active" },
        resource: { type: "platform", id: "zerosheet" },
        action: "create_organization",
        relationship: { required: false, allowed: false },
      },
    ]);
  });

  it("stops immediately when OpenFGA denies a resource action", async () => {
    const { service, relationships, context, policy } = makeService();
    relationships.allowed = false;

    await expect(
      service.canAccessWorkbook({
        userId,
        workbookId,
        permission: "can_view",
      }),
    ).resolves.toBe(false);

    expect(context.resourceCalls).toBe(0);
    expect(policy.inputs).toHaveLength(0);
  });

  it("denies when PostgreSQL cannot provide active resource context", async () => {
    const { service, context, policy } = makeService();
    context.resource = null;

    await expect(
      service.canAccessWorkbook({
        userId,
        workbookId,
        permission: "can_view",
      }),
    ).resolves.toBe(false);
    expect(policy.inputs).toHaveLength(0);
  });

  it("sends only reviewed workbook facts to OPA after OpenFGA allows", async () => {
    const { service, policy } = makeService();

    await expect(
      service.canAccessWorkbook({
        userId,
        workbookId,
        permission: "can_manage_sharing",
      }),
    ).resolves.toBe(true);

    expect(policy.inputs[0]).toEqual({
      subject: { id: userId, status: "active" },
      organization: { id: organizationId, status: "active" },
      resource: { type: "workbook", id: workbookId },
      action: "can_manage_sharing",
      relationship: { required: true, allowed: true },
    });
  });

  it("lets an OPA denial override an OpenFGA allow", async () => {
    const { service, relationships, policy } = makeService();
    policy.allowed = false;

    await expect(
      service.canAccessOrganization({
        userId,
        organizationId,
        permission: "can_manage_members",
      }),
    ).resolves.toBe(false);
    expect(relationships.allowed).toBe(true);
    expect(policy.inputs).toHaveLength(1);
  });
});
