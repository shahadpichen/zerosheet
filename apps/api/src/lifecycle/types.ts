import type { AuthenticatedUser } from "@zerosheet/contracts";

export interface ScimConnection {
  id: string;
  organizationId: string;
  displayName: string;
  active: boolean;
}

export interface CreatedScimConnection extends ScimConnection {
  /**
   * The plaintext credential exists only in the creation response. PostgreSQL
   * stores its SHA-256 digest, so this value can never be reconstructed later.
   */
  bearerToken: string;
  tokenHint: string;
}

export interface ScimManagedUser {
  id: string;
  connectionId: string;
  organizationId: string;
  productUserId: string;
  externalId: string;
  userName: string;
  displayName: string;
  active: boolean;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateScimConnectionRecordInput {
  id: string;
  organizationId: string;
  displayName: string;
  tokenHash: string;
  tokenHint: string;
  createdBy: string;
  now: Date;
}

export interface CreateScimManagedUserInput {
  id: string;
  productUserId: string;
  connection: ScimConnection;
  externalId: string;
  userName: string;
  displayName: string;
  active: boolean;
  now: Date;
}

export interface ReplaceScimManagedUserInput {
  connection: ScimConnection;
  id: string;
  externalId: string;
  userName: string;
  displayName: string;
  active: boolean;
  now: Date;
}

export type ScimUserFilter =
  | { attribute: "externalId"; value: string }
  | { attribute: "userName"; value: string };

/**
 * Repository methods are SCIM resource transitions, not generic user CRUD.
 * They keep the external resource, product account, tenant status, and session
 * revocation updates in one PostgreSQL transaction.
 */
export interface LifecycleRepository {
  assertReady(): Promise<void>;
  createConnection(
    input: CreateScimConnectionRecordInput,
  ): Promise<ScimConnection>;
  findConnectionByTokenHash(tokenHash: string): Promise<ScimConnection | null>;
  createManagedUser(
    input: CreateScimManagedUserInput,
  ): Promise<ScimManagedUser>;
  replaceManagedUser(
    input: ReplaceScimManagedUserInput,
  ): Promise<ScimManagedUser | null>;
  findManagedUser(
    connectionId: string,
    id: string,
  ): Promise<ScimManagedUser | null>;
  listManagedUsers(
    connectionId: string,
    filter?: ScimUserFilter,
  ): Promise<ScimManagedUser[]>;
}

/**
 * The SCIM service may change relationships only through this narrow internal
 * port. It never constructs raw OpenFGA tuples and never impersonates a human
 * administrator merely to reuse a browser-facing route.
 */
export interface ManagedMembershipCoordinator {
  provisionManagedOrganizationMember(
    organizationId: string,
    userId: string,
  ): Promise<void>;
  deprovisionManagedOrganizationMember(
    organizationId: string,
    userId: string,
  ): Promise<void>;
}

export interface LifecycleApplicationService {
  createConnection(
    actor: AuthenticatedUser,
    organizationId: string,
    displayName: string,
  ): Promise<CreatedScimConnection>;
  authenticateConnection(token: string | undefined): Promise<ScimConnection>;
  createUser(
    connection: ScimConnection,
    input: {
      externalId: string;
      userName: string;
      displayName: string;
      active: boolean;
    },
  ): Promise<ScimManagedUser>;
  replaceUser(
    connection: ScimConnection,
    id: string,
    input: {
      externalId: string;
      userName: string;
      displayName: string;
      active: boolean;
    },
  ): Promise<ScimManagedUser>;
  findUser(connection: ScimConnection, id: string): Promise<ScimManagedUser>;
  listUsers(
    connection: ScimConnection,
    filter?: ScimUserFilter,
  ): Promise<ScimManagedUser[]>;
  deactivateUser(connection: ScimConnection, id: string): Promise<void>;
}
