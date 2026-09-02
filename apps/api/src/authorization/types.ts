/**
 * The API asks business permissions rather than inspecting OpenFGA roles. A
 * model can later change how `can_view` is derived without changing every
 * protected route.
 */
export type WorkbookPermission = "can_view" | "can_edit" | "can_manage_sharing";

export type OrganizationPermission =
  "can_manage_members" | "can_create_workbook";

export type TeamPermission = "can_manage";

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
  canAccessOrganization(
    input: CheckOrganizationPermissionInput,
  ): Promise<boolean>;
  canAccessTeam(input: CheckTeamPermissionInput): Promise<boolean>;
  canAccessWorkbook(input: CheckWorkbookPermissionInput): Promise<boolean>;
}
