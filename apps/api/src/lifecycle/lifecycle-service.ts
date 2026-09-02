import { randomUUID } from "node:crypto";
import type { AuthenticatedUser } from "@zerosheet/contracts";
import { createOpaqueToken, hashOpaqueToken } from "../auth/opaque-tokens.js";
import type { AuditRecorder } from "../audit/types.js";
import type { AuthorizationApplicationService } from "../authorization/types.js";
import {
  LifecycleForbiddenError,
  LifecycleNotFoundError,
  LifecycleUnauthorizedError,
} from "./errors.js";
import type {
  CreatedScimConnection,
  LifecycleApplicationService,
  LifecycleRepository,
  ManagedMembershipCoordinator,
  ScimConnection,
  ScimManagedUser,
  ScimUserFilter,
} from "./types.js";

export interface LifecycleServiceOptions {
  repository: LifecycleRepository;
  authorization: AuthorizationApplicationService;
  memberships: ManagedMembershipCoordinator;
  audit: AuditRecorder;
  now?: () => Date;
  id?: () => string;
  token?: () => string;
}

/**
 * LifecycleService joins the directory control plane to the actual ZeroSheet
 * entitlement stores. Creating an active SCIM user provisions an organization
 * relationship. Deactivation first writes a tenant-scoped deny fact and
 * revokes sessions, then removes organization/team tuples through the same
 * transactional outbox used by human administrators.
 */
export class LifecycleService implements LifecycleApplicationService {
  private readonly now: () => Date;
  private readonly id: () => string;
  private readonly token: () => string;

  public constructor(private readonly options: LifecycleServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.id = options.id ?? randomUUID;
    this.token = options.token ?? createOpaqueToken;
  }

  public async createConnection(
    actor: AuthenticatedUser,
    organizationId: string,
    displayName: string,
  ): Promise<CreatedScimConnection> {
    const allowed = await this.options.authorization.canAccessOrganization({
      userId: actor.id,
      organizationId,
      permission: "can_manage_members",
    });

    if (!allowed) {
      throw new LifecycleForbiddenError();
    }

    const connectionId = this.id();
    const bearerToken = `zs_scim_${connectionId}.${this.token()}`;
    const tokenHint = bearerToken.slice(-8);
    const connection = await this.options.repository.createConnection({
      id: connectionId,
      organizationId,
      displayName,
      tokenHash: hashOpaqueToken(bearerToken),
      tokenHint,
      createdBy: actor.id,
      now: this.now(),
    });

    await this.options.audit.record({
      actor: { type: "user", id: actor.id },
      organizationId,
      action: "scim.connection.create",
      resource: { type: "scim_connection", id: connection.id },
      outcome: "succeeded",
      reasonCode: "connection_created",
      details: { tokenHint },
    });

    return { ...connection, bearerToken, tokenHint };
  }

  public async authenticateConnection(
    token: string | undefined,
  ): Promise<ScimConnection> {
    if (!token || !token.startsWith("zs_scim_") || token.length > 512) {
      throw new LifecycleUnauthorizedError();
    }

    const connection = await this.options.repository.findConnectionByTokenHash(
      hashOpaqueToken(token),
    );
    if (!connection) {
      throw new LifecycleUnauthorizedError();
    }

    return connection;
  }

  public async createUser(
    connection: ScimConnection,
    input: {
      externalId: string;
      userName: string;
      displayName: string;
      active: boolean;
    },
  ): Promise<ScimManagedUser> {
    /**
     * Provisioning clients retry ambiguous HTTP failures. Treating an exact
     * externalId retry as replacement lets a PostgreSQL-committed/OpenFGA-
     * timed-out create converge instead of becoming a permanent 409.
     */
    const existing = (
      await this.options.repository.listManagedUsers(connection.id, {
        attribute: "externalId",
        value: input.externalId,
      })
    )[0];
    if (existing) {
      return this.replaceUser(connection, existing.id, input);
    }

    const user = await this.options.repository.createManagedUser({
      id: this.id(),
      productUserId: this.id(),
      connection,
      ...input,
      now: this.now(),
    });

    await this.reconcileMembership(connection, user);
    await this.recordUserEvent(connection, user, "scim.user.create");
    return user;
  }

  public async replaceUser(
    connection: ScimConnection,
    id: string,
    input: {
      externalId: string;
      userName: string;
      displayName: string;
      active: boolean;
    },
  ): Promise<ScimManagedUser> {
    const user = await this.options.repository.replaceManagedUser({
      connection,
      id,
      ...input,
      now: this.now(),
    });
    if (!user) throw new LifecycleNotFoundError();

    await this.reconcileMembership(connection, user);
    await this.recordUserEvent(connection, user, "scim.user.replace");
    return user;
  }

  public async findUser(
    connection: ScimConnection,
    id: string,
  ): Promise<ScimManagedUser> {
    const user = await this.options.repository.findManagedUser(
      connection.id,
      id,
    );
    if (!user) throw new LifecycleNotFoundError();
    return user;
  }

  public listUsers(
    connection: ScimConnection,
    filter?: ScimUserFilter,
  ): Promise<ScimManagedUser[]> {
    return this.options.repository.listManagedUsers(connection.id, filter);
  }

  public async deactivateUser(
    connection: ScimConnection,
    id: string,
  ): Promise<void> {
    const existing = await this.findUser(connection, id);
    /**
     * DELETE is represented as a soft deactivation so retries remain safe and
     * the SCIM resource keeps its stable identifier. We call the repository
     * transition directly instead of replaceUser because one HTTP operation
     * should create one successful lifecycle audit event, not both a replace
     * event and a delete event.
     */
    const user = await this.options.repository.replaceManagedUser({
      connection,
      id,
      externalId: existing.externalId,
      userName: existing.userName,
      displayName: existing.displayName,
      active: false,
      now: this.now(),
    });
    if (!user) throw new LifecycleNotFoundError();

    await this.reconcileMembership(connection, user);
    await this.recordUserEvent(connection, user, "scim.user.delete");
  }

  private async reconcileMembership(
    connection: ScimConnection,
    user: ScimManagedUser,
  ): Promise<void> {
    try {
      if (user.active) {
        await this.options.memberships.provisionManagedOrganizationMember(
          connection.organizationId,
          user.productUserId,
        );
      } else {
        await this.options.memberships.deprovisionManagedOrganizationMember(
          connection.organizationId,
          user.productUserId,
        );
      }
    } catch (error) {
      await this.options.audit.record({
        actor: { type: "scim_client", id: connection.id },
        organizationId: connection.organizationId,
        action: user.active
          ? "scim.user.provision_membership"
          : "scim.user.deprovision_membership",
        resource: { type: "user", id: user.productUserId },
        outcome: "failed",
        reasonCode: "relationship_synchronization_failed",
      });
      throw error;
    }
  }

  private recordUserEvent(
    connection: ScimConnection,
    user: ScimManagedUser,
    action: string,
  ): Promise<void> {
    return this.options.audit.record({
      actor: { type: "scim_client", id: connection.id },
      organizationId: connection.organizationId,
      action,
      resource: { type: "user", id: user.productUserId },
      outcome: "succeeded",
      reasonCode: user.active ? "user_active" : "user_suspended",
      details: {
        scimResourceId: user.id,
        version: user.version,
      },
    });
  }
}
