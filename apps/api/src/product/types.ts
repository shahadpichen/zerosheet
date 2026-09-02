import type { AuthenticatedUser } from "@zerosheet/contracts";
import type {
  AuthorizationTuple,
  RelationshipMutation,
} from "../authorization/types.js";

export type OrganizationRole = "owner" | "admin" | "member";
export type TeamRole = "manager" | "member";
export type WorkbookShareRole = "editor" | "viewer";

export interface Organization {
  id: string;
  name: string;
}

export interface Team {
  id: string;
  organizationId: string;
  name: string;
}

export interface Workbook {
  id: string;
  organizationId: string;
  name: string;
  createdBy: string;
}

export interface OrganizationMembership {
  organizationId: string;
  userId: string;
  role: OrganizationRole;
}

export interface TeamMembership {
  teamId: string;
  userId: string;
  role: TeamRole;
}

export type WorkbookSharePrincipal =
  { type: "user"; id: string } | { type: "team"; id: string };

export interface WorkbookShare {
  workbookId: string;
  principal: WorkbookSharePrincipal;
  role: WorkbookShareRole;
}

/**
 * PostgreSQL serializes this value into the outbox. Keeping the public type
 * identical to the authorization gateway mutation makes a retry replay the
 * exact tuple set originally reviewed by the product service.
 */
export interface PendingRelationshipOperation extends RelationshipMutation {
  id: string;
}

export interface StagedMutation<T> {
  value: T;
  operation?: PendingRelationshipOperation;
}

export interface CreateOrganizationRecordInput {
  organization: Organization;
  ownerId: string;
  operation: PendingRelationshipOperation;
  now: Date;
}

export interface CreateTeamRecordInput {
  team: Team;
  managerId: string;
  operation: PendingRelationshipOperation;
  now: Date;
}

export interface CreateWorkbookRecordInput {
  workbook: Workbook;
  operation: PendingRelationshipOperation;
  now: Date;
}

export interface SetOrganizationMembershipInput {
  organizationId: string;
  userId: string;
  role: Exclude<OrganizationRole, "owner">;
  operationId: string;
  now: Date;
  buildMutation(previousRole: OrganizationRole | null): RelationshipMutation;
}

export interface SetTeamMembershipInput {
  teamId: string;
  userId: string;
  role: TeamRole;
  operationId: string;
  now: Date;
  buildMutation(previousRole: TeamRole | null): RelationshipMutation;
}

export interface SetWorkbookShareInput {
  workbookId: string;
  principal: WorkbookSharePrincipal;
  role: WorkbookShareRole;
  operationId: string;
  now: Date;
  buildMutation(previousRole: WorkbookShareRole | null): RelationshipMutation;
}

export interface RemoveRelationshipInput {
  operationId: string;
  now: Date;
}

/**
 * Repository methods are business transitions rather than generic table CRUD.
 * Each transition locks the current row, validates product-side invariants,
 * and stores the tuple intent in the same PostgreSQL transaction.
 */
export interface ProductRepository {
  assertReady(): Promise<void>;
  createOrganization(
    input: CreateOrganizationRecordInput,
  ): Promise<StagedMutation<Organization>>;
  createTeam(input: CreateTeamRecordInput): Promise<StagedMutation<Team>>;
  createWorkbook(
    input: CreateWorkbookRecordInput,
  ): Promise<StagedMutation<Workbook>>;
  findActiveWorkbook(workbookId: string): Promise<Workbook | null>;
  setOrganizationMembership(
    input: SetOrganizationMembershipInput,
  ): Promise<StagedMutation<OrganizationMembership>>;
  removeOrganizationMembership(
    organizationId: string,
    userId: string,
    input: RemoveRelationshipInput,
  ): Promise<StagedMutation<OrganizationMembership>>;
  setTeamMembership(
    input: SetTeamMembershipInput,
  ): Promise<StagedMutation<TeamMembership>>;
  removeTeamMembership(
    teamId: string,
    userId: string,
    input: RemoveRelationshipInput,
  ): Promise<StagedMutation<TeamMembership>>;
  setWorkbookShare(
    input: SetWorkbookShareInput,
  ): Promise<StagedMutation<WorkbookShare>>;
  removeWorkbookShare(
    workbookId: string,
    principal: WorkbookSharePrincipal,
    input: RemoveRelationshipInput,
  ): Promise<StagedMutation<WorkbookShare>>;
  listPendingRelationshipOperations(
    now: Date,
    limit: number,
  ): Promise<PendingRelationshipOperation[]>;
  completeRelationshipOperation(operationId: string, now: Date): Promise<void>;
  recordRelationshipOperationFailure(
    operationId: string,
    errorCode: string,
    nextAttemptAt: Date,
  ): Promise<void>;
}

export interface CreateNamedResourceInput {
  name: string;
}

export interface ProductApplicationService {
  createOrganization(
    actor: AuthenticatedUser,
    input: CreateNamedResourceInput,
  ): Promise<Organization>;
  createTeam(
    actor: AuthenticatedUser,
    organizationId: string,
    input: CreateNamedResourceInput,
  ): Promise<Team>;
  createWorkbook(
    actor: AuthenticatedUser,
    organizationId: string,
    input: CreateNamedResourceInput,
  ): Promise<Workbook>;
  getWorkbook(actor: AuthenticatedUser, workbookId: string): Promise<Workbook>;
  setOrganizationMember(
    actor: AuthenticatedUser,
    organizationId: string,
    userId: string,
    role: Exclude<OrganizationRole, "owner">,
  ): Promise<OrganizationMembership>;
  removeOrganizationMember(
    actor: AuthenticatedUser,
    organizationId: string,
    userId: string,
  ): Promise<void>;
  setTeamMember(
    actor: AuthenticatedUser,
    teamId: string,
    userId: string,
    role: TeamRole,
  ): Promise<TeamMembership>;
  removeTeamMember(
    actor: AuthenticatedUser,
    teamId: string,
    userId: string,
  ): Promise<void>;
  setWorkbookShare(
    actor: AuthenticatedUser,
    workbookId: string,
    principal: WorkbookSharePrincipal,
    role: WorkbookShareRole,
  ): Promise<WorkbookShare>;
  removeWorkbookShare(
    actor: AuthenticatedUser,
    workbookId: string,
    principal: WorkbookSharePrincipal,
  ): Promise<void>;
  reconcilePendingOperations(limit?: number): Promise<number>;
}

/**
 * The JSONB parser accepts only the tuple shape ZeroSheet writes. A database
 * operator can inspect or replay the queue, but malformed state fails closed
 * before any arbitrary relationship string reaches OpenFGA.
 */
export function isAuthorizationTuple(
  value: unknown,
): value is AuthorizationTuple {
  if (!value || typeof value !== "object") {
    return false;
  }

  const tuple = value as Record<string, unknown>;
  if (
    typeof tuple.user !== "string" ||
    typeof tuple.relation !== "string" ||
    typeof tuple.object !== "string"
  ) {
    return false;
  }

  const uuid =
    "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
  const directUser = new RegExp(`^user:${uuid}$`, "iu");
  const organization = new RegExp(`^organization:${uuid}$`, "iu");
  const teamUserset = new RegExp(`^team:${uuid}#member$`, "iu");
  const object = new RegExp(
    `^(organization|team|workbook):${uuid}$`,
    "iu",
  ).exec(tuple.object);

  if (!object) {
    return false;
  }

  const objectType = object[1];

  if (objectType === "organization") {
    return (
      directUser.test(tuple.user) &&
      ["owner", "admin", "member"].includes(tuple.relation)
    );
  }

  if (objectType === "team") {
    return (
      (directUser.test(tuple.user) &&
        ["manager", "member"].includes(tuple.relation)) ||
      (organization.test(tuple.user) && tuple.relation === "organization")
    );
  }

  return (
    (directUser.test(tuple.user) &&
      ["owner", "editor", "viewer"].includes(tuple.relation)) ||
    (organization.test(tuple.user) && tuple.relation === "organization") ||
    (teamUserset.test(tuple.user) &&
      ["editor", "viewer"].includes(tuple.relation))
  );
}
