import type {
  AuthorizationTuple,
  RelationshipMutation,
} from "../authorization/types.js";
import type {
  OrganizationRole,
  TeamRole,
  WorkbookSharePrincipal,
  WorkbookShareRole,
} from "./types.js";

function tuple(
  user: string,
  relation: string,
  object: string,
): AuthorizationTuple {
  return { user, relation, object };
}

function user(userId: string): string {
  return `user:${userId}`;
}

function organization(organizationId: string): string {
  return `organization:${organizationId}`;
}

function team(teamId: string): string {
  return `team:${teamId}`;
}

function workbook(workbookId: string): string {
  return `workbook:${workbookId}`;
}

/**
 * Creation mutations include both containment and initial administration. A
 * workbook's organization tuple locates its tenant but grants no visibility;
 * only the separate owner tuple authorizes its creator to read and share it.
 */
export function provisionOrganizationMutation(
  organizationId: string,
  ownerId: string,
): RelationshipMutation {
  return {
    writes: [tuple(user(ownerId), "owner", organization(organizationId))],
    deletes: [],
  };
}

export function provisionTeamMutation(
  teamId: string,
  organizationId: string,
  managerId: string,
): RelationshipMutation {
  return {
    writes: [
      tuple(organization(organizationId), "organization", team(teamId)),
      tuple(user(managerId), "manager", team(teamId)),
    ],
    deletes: [],
  };
}

export function provisionWorkbookMutation(
  workbookId: string,
  organizationId: string,
  ownerId: string,
): RelationshipMutation {
  return {
    writes: [
      tuple(organization(organizationId), "organization", workbook(workbookId)),
      tuple(user(ownerId), "owner", workbook(workbookId)),
    ],
    deletes: [],
  };
}

function replaceDirectRelationship(
  subject: string,
  object: string,
  previousRole: string | null,
  nextRole: string | null,
): RelationshipMutation {
  return {
    writes: nextRole ? [tuple(subject, nextRole, object)] : [],
    deletes:
      previousRole && previousRole !== nextRole
        ? [tuple(subject, previousRole, object)]
        : [],
  };
}

export function organizationMembershipMutation(
  organizationId: string,
  userId: string,
  previousRole: OrganizationRole | null,
  nextRole: Exclude<OrganizationRole, "owner"> | null,
): RelationshipMutation {
  return replaceDirectRelationship(
    user(userId),
    organization(organizationId),
    previousRole,
    nextRole,
  );
}

export function teamMembershipMutation(
  teamId: string,
  userId: string,
  previousRole: TeamRole | null,
  nextRole: TeamRole | null,
): RelationshipMutation {
  return replaceDirectRelationship(
    user(userId),
    team(teamId),
    previousRole,
    nextRole,
  );
}

function workbookShareSubject(principal: WorkbookSharePrincipal): string {
  return principal.type === "user"
    ? user(principal.id)
    : `${team(principal.id)}#member`;
}

export function workbookShareMutation(
  workbookId: string,
  principal: WorkbookSharePrincipal,
  previousRole: WorkbookShareRole | null,
  nextRole: WorkbookShareRole | null,
): RelationshipMutation {
  return replaceDirectRelationship(
    workbookShareSubject(principal),
    workbook(workbookId),
    previousRole,
    nextRole,
  );
}
