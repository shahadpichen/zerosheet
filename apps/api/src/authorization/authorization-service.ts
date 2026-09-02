import type {
  AuthorizationApplicationService,
  ContextualPolicyGateway,
  AuthorizationGateway,
  CheckCreateOrganizationInput,
  CheckOrganizationPermissionInput,
  CheckTeamPermissionInput,
  CheckWorkbookPermissionInput,
  OrganizationPolicyContext,
  PolicyContextRepository,
} from "./types.js";

export interface AuthorizationServiceOptions {
  relationships: AuthorizationGateway;
  context: PolicyContextRepository;
  policy: ContextualPolicyGateway;
}

/**
 * AuthorizationService is the application's composite Policy Decision Point.
 * OpenFGA answers durable relationship questions, PostgreSQL supplies current
 * lifecycle facts, and OPA evaluates the final rule. A protected action is
 * allowed only when every required component explicitly allows it.
 */
export class AuthorizationService implements AuthorizationApplicationService {
  public constructor(private readonly options: AuthorizationServiceOptions) {}

  public async canCreateOrganization(
    input: CheckCreateOrganizationInput,
  ): Promise<boolean> {
    const context = await this.options.context.findPlatformContext(
      input.userId,
    );

    if (!context) {
      return false;
    }

    return this.options.policy.evaluate({
      ...context,
      resource: { type: "platform", id: "zerosheet" },
      action: "create_organization",
      relationship: { required: false, allowed: false },
    });
  }

  public async canAccessOrganization(
    input: CheckOrganizationPermissionInput,
  ): Promise<boolean> {
    const relationshipAllowed =
      await this.options.relationships.checkOrganizationPermission(input);

    if (!relationshipAllowed) {
      // A relationship denial is final. Avoiding the later queries also keeps
      // nonexistent-resource details from becoming an observable side channel.
      return false;
    }

    const context = await this.options.context.findOrganizationContext(
      input.userId,
      input.organizationId,
    );

    return this.evaluateResource(
      context,
      { type: "organization", id: input.organizationId },
      input.permission,
    );
  }

  public async canAccessTeam(
    input: CheckTeamPermissionInput,
  ): Promise<boolean> {
    const relationshipAllowed =
      await this.options.relationships.checkTeamPermission(input);

    if (!relationshipAllowed) {
      return false;
    }

    const context = await this.options.context.findTeamContext(
      input.userId,
      input.teamId,
    );

    return this.evaluateResource(
      context,
      { type: "team", id: input.teamId },
      input.permission,
    );
  }

  public async canAccessWorkbook(
    input: CheckWorkbookPermissionInput,
  ): Promise<boolean> {
    const relationshipAllowed =
      await this.options.relationships.checkWorkbookPermission(input);

    if (!relationshipAllowed) {
      return false;
    }

    const context = await this.options.context.findWorkbookContext(
      input.userId,
      input.workbookId,
    );

    return this.evaluateResource(
      context,
      { type: "workbook", id: input.workbookId },
      input.permission,
    );
  }

  private evaluateResource(
    context: OrganizationPolicyContext | null,
    resource: { type: "organization" | "team" | "workbook"; id: string },
    action:
      | CheckOrganizationPermissionInput["permission"]
      | CheckTeamPermissionInput["permission"]
      | CheckWorkbookPermissionInput["permission"],
  ): Promise<boolean> {
    if (!context) {
      return Promise.resolve(false);
    }

    return this.options.policy.evaluate({
      ...context,
      resource,
      action,
      relationship: { required: true, allowed: true },
    });
  }
}
