/**
 * The API asks business permissions rather than inspecting OpenFGA roles. A
 * model can later change how `can_view` is derived without changing every
 * protected route.
 */
export type WorkbookPermission = "can_view" | "can_edit" | "can_manage_sharing";

export type OrganizationPermission =
  "can_manage_members" | "can_create_workbook";

export type TeamPermission = "can_manage";

/**
 * `create_organization` has no existing OpenFGA object yet. Keeping it beside
 * the resource permissions gives OPA one closed list of actions; arbitrary
 * strings from an HTTP request can never become policy input.
 */
export type ContextualAction =
  | "create_organization"
  | OrganizationPermission
  | TeamPermission
  | WorkbookPermission;

export type PolicyStatus = "active" | "suspended";
export type PolicyResourceType =
  "platform" | "organization" | "team" | "workbook";

export interface CheckWorkbookPermissionInput {
  userId: string;
  workbookId: string;
  permission: WorkbookPermission;
}

export interface CheckOrganizationPermissionInput {
  userId: string;
  organizationId: string;
  permission: OrganizationPermission;
}

export interface CheckTeamPermissionInput {
  userId: string;
  teamId: string;
  permission: TeamPermission;
}

export interface CheckCreateOrganizationInput {
  userId: string;
}

/**
 * PostgreSQL is the Policy Information Point (PIP). These deliberately small
 * projections contain only facts needed by the current policy. OPA does not
 * receive emails, names, sessions, relationship tuples, or workbook content.
 */
export interface PlatformPolicyContext {
  subject: {
    id: string;
    status: PolicyStatus;
  };
}

export interface OrganizationPolicyContext extends PlatformPolicyContext {
  organization: {
    id: string;
    status: PolicyStatus;
  };
}

/**
 * A dedicated interface stops decision code from issuing ad-hoc SQL. Returning
 * null means a subject/resource is absent or not active, which the application
 * service always treats as denial.
 */
export interface PolicyContextRepository {
  assertReady(): Promise<void>;
  findPlatformContext(userId: string): Promise<PlatformPolicyContext | null>;
  findOrganizationContext(
    userId: string,
    organizationId: string,
  ): Promise<OrganizationPolicyContext | null>;
  findTeamContext(
    userId: string,
    teamId: string,
  ): Promise<OrganizationPolicyContext | null>;
  findWorkbookContext(
    userId: string,
    workbookId: string,
  ): Promise<OrganizationPolicyContext | null>;
}

/**
 * OPA receives OpenFGA's result as one fact and combines it with PostgreSQL
 * lifecycle state. `required` distinguishes platform actions, where no object
 * exists yet, from resource actions that must have an OpenFGA allow.
 */
export interface ContextualPolicyInput {
  subject: PlatformPolicyContext["subject"];
  organization?: OrganizationPolicyContext["organization"];
  resource: {
    type: PolicyResourceType;
    id: string;
  };
  action: ContextualAction;
  relationship: {
    required: boolean;
    allowed: boolean;
  };
}

export interface ContextualPolicyGateway {
  assertReady(): Promise<void>;
  evaluate(input: ContextualPolicyInput): Promise<boolean>;
}

/**
 * Tuple strings are deliberately kept behind the authorization gateway. The
 * product service receives these values only from reviewed tuple-builder
 * functions; an HTTP body can never provide a raw OpenFGA user, relation, or
 * object expression.
 */
export interface AuthorizationTuple {
  user: string;
  relation: string;
  object: string;
}

export interface RelationshipMutation {
  writes: AuthorizationTuple[];
  deletes: AuthorizationTuple[];
}

/**
 * This gateway is the anti-corruption layer around the OpenFGA SDK. Product
 * services never construct raw `user:<id>` or `workbook:<id>` tuple strings and
 * remain testable without a running network decision service.
 */
export interface AuthorizationGateway {
  assertReady(): Promise<void>;
  checkOrganizationPermission(
    input: CheckOrganizationPermissionInput,
  ): Promise<boolean>;
  checkTeamPermission(input: CheckTeamPermissionInput): Promise<boolean>;
  checkWorkbookPermission(
    input: CheckWorkbookPermissionInput,
  ): Promise<boolean>;
  applyRelationshipMutation(mutation: RelationshipMutation): Promise<void>;
}

export interface AuthorizationApplicationService {
  canCreateOrganization(input: CheckCreateOrganizationInput): Promise<boolean>;
  canAccessOrganization(
    input: CheckOrganizationPermissionInput,
  ): Promise<boolean>;
  canAccessTeam(input: CheckTeamPermissionInput): Promise<boolean>;
  canAccessWorkbook(input: CheckWorkbookPermissionInput): Promise<boolean>;
}
