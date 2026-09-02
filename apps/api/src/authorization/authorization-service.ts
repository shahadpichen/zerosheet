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
import type { AuditRecorder } from "../audit/types.js";

export interface AuthorizationServiceOptions {
  relationships: AuthorizationGateway;
  context: PolicyContextRepository;
  policy: ContextualPolicyGateway;
  audit: AuditRecorder;
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
      await this.recordDecision(
        input.userId,
        undefined,
        "create_organization",
        { type: "platform", id: "zerosheet" },
        false,
        "policy_context_missing",
      );
      return false;
    }

    const allowed = await this.options.policy.evaluate({
      ...context,
      resource: { type: "platform", id: "zerosheet" },
      action: "create_organization",
      relationship: { required: false, allowed: false },
    });
    await this.recordDecision(
      input.userId,
      undefined,
      "create_organization",
      { type: "platform", id: "zerosheet" },
      allowed,
      allowed ? "context_policy_allowed" : "context_policy_denied",
    );
    return allowed;
  }

  public async canAccessOrganization(
    input: CheckOrganizationPermissionInput,
  ): Promise<boolean> {
    const relationshipAllowed =
      await this.options.relationships.checkOrganizationPermission(input);

    if (!relationshipAllowed) {
      // A relationship denial is final. Avoiding the later queries also keeps
      // nonexistent-resource details from becoming an observable side channel.
      await this.recordDecision(
        input.userId,
        input.organizationId,
        input.permission,
        { type: "organization", id: input.organizationId },
        false,
        "relationship_denied",
      );
      return false;
    }

    const context = await this.options.context.findOrganizationContext(
      input.userId,
      input.organizationId,
    );

    return this.evaluateResource(
      context,
      input.userId,
      input.organizationId,
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
      await this.recordDecision(
        input.userId,
        undefined,
        input.permission,
        { type: "team", id: input.teamId },
        false,
        "relationship_denied",
      );
      return false;
    }

    const context = await this.options.context.findTeamContext(
      input.userId,
      input.teamId,
    );

    return this.evaluateResource(
      context,
      input.userId,
      context?.organization.id,
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
      await this.recordDecision(
        input.userId,
        undefined,
        input.permission,
        { type: "workbook", id: input.workbookId },
        false,
        "relationship_denied",
      );
      return false;
    }

    const context = await this.options.context.findWorkbookContext(
      input.userId,
      input.workbookId,
    );

    return this.evaluateResource(
      context,
      input.userId,
      context?.organization.id,
      { type: "workbook", id: input.workbookId },
      input.permission,
    );
  }

  private async evaluateResource(
    context: OrganizationPolicyContext | null,
    userId: string,
    organizationId: string | undefined,
    resource: { type: "organization" | "team" | "workbook"; id: string },
    action:
      | CheckOrganizationPermissionInput["permission"]
      | CheckTeamPermissionInput["permission"]
      | CheckWorkbookPermissionInput["permission"],
  ): Promise<boolean> {
    if (!context) {
      await this.recordDecision(
        userId,
        organizationId,
        action,
        resource,
        false,
        "policy_context_missing",
      );
      return false;
    }

    const allowed = await this.options.policy.evaluate({
      ...context,
      resource,
      action,
      relationship: { required: true, allowed: true },
    });
    await this.recordDecision(
      userId,
      context.organization.id,
      action,
      resource,
      allowed,
      allowed ? "composed_policy_allowed" : "context_policy_denied",
    );
    return allowed;
  }

  private recordDecision(
    userId: string,
    organizationId: string | undefined,
    action: string,
    resource: { type: string; id: string },
    allowed: boolean,
    reasonCode: string,
  ): Promise<void> {
    return this.options.audit.record({
      actor: { type: "user", id: userId },
      ...(organizationId ? { organizationId } : {}),
      action,
      resource,
      outcome: allowed ? "allowed" : "denied",
      reasonCode,
    });
  }
}
