import {
  ClientWriteRequestOnDuplicateWrites,
  ClientWriteRequestOnMissingDeletes,
  ClientWriteStatus,
  ConsistencyPreference,
  CredentialsMethod,
  OpenFgaClient,
} from "@openfga/sdk";
import type { AuthorizationConfig } from "../config.js";
import type {
  AuthorizationGateway,
  AuthorizationTuple,
  CheckOrganizationPermissionInput,
  CheckTeamPermissionInput,
  CheckWorkbookPermissionInput,
  RelationshipMutation,
} from "./types.js";

interface OpenFgaClientPort {
  readAuthorizationModel(): Promise<{
    authorization_model?: { id: string };
  }>;
  check(
    body: { user: string; relation: string; object: string },
    options: { consistency: ConsistencyPreference },
  ): Promise<{ allowed?: boolean }>;
  write(
    body: { writes?: AuthorizationTuple[]; deletes?: AuthorizationTuple[] },
    options: {
      conflict: {
        onDuplicateWrites: ClientWriteRequestOnDuplicateWrites;
        onMissingDeletes: ClientWriteRequestOnMissingDeletes;
      };
      transaction?: {
        disable: boolean;
        maxPerChunk: number;
        maxParallelRequests: number;
      };
    },
  ): Promise<{
    writes: Array<{ status: ClientWriteStatus }>;
    deletes: Array<{ status: ClientWriteStatus }>;
  }>;
}

/**
 * The concrete adapter owns OpenFGA object syntax, authentication and
 * consistency. A caller can provide a small port in tests; production receives
 * the official SDK instance created below.
 */
export class OpenFgaAuthorizationGateway implements AuthorizationGateway {
  public constructor(
    private readonly client: OpenFgaClientPort,
    private readonly authorizationModelId: string,
  ) {}

  public async assertReady(): Promise<void> {
    const response = await this.client.readAuthorizationModel();

    if (response.authorization_model?.id !== this.authorizationModelId) {
      throw new Error(
        "OpenFGA did not return the configured authorization model.",
      );
    }
  }

  public async checkWorkbookPermission(
    input: CheckWorkbookPermissionInput,
  ): Promise<boolean> {
    return this.checkPermission({
      userId: input.userId,
      relation: input.permission,
      object: `workbook:${input.workbookId}`,
    });
  }

  public checkOrganizationPermission(
    input: CheckOrganizationPermissionInput,
  ): Promise<boolean> {
    return this.checkPermission({
      userId: input.userId,
      relation: input.permission,
      object: `organization:${input.organizationId}`,
    });
  }

  public checkTeamPermission(
    input: CheckTeamPermissionInput,
  ): Promise<boolean> {
    return this.checkPermission({
      userId: input.userId,
      relation: input.permission,
      object: `team:${input.teamId}`,
    });
  }

  public async applyRelationshipMutation(
    mutation: RelationshipMutation,
  ): Promise<void> {
    /**
     * OpenFGA applies the writes and deletes in one service-local transaction.
     * `Ignore` is essential for the PostgreSQL outbox retry contract: a timeout
     * may mean OpenFGA committed even though the API never received the reply.
     * Replaying that exact intent must converge instead of failing forever.
     */
    const tupleCount = mutation.writes.length + mutation.deletes.length;
    const response = await this.client.write(
      {
        ...(mutation.writes.length > 0 ? { writes: mutation.writes } : {}),
        ...(mutation.deletes.length > 0 ? { deletes: mutation.deletes } : {}),
      },
      {
        conflict: {
          onDuplicateWrites: ClientWriteRequestOnDuplicateWrites.Ignore,
          onMissingDeletes: ClientWriteRequestOnMissingDeletes.Ignore,
        },
        ...(tupleCount > 100
          ? {
              /**
               * OpenFGA transactions accept a bounded tuple count. Large
               * leaver operations are chunked serially; partial progress is
               * safe because the outbox remains pending and replay converges.
               * A response is not considered successful until every chunk is.
               */
              transaction: {
                disable: true,
                maxPerChunk: 100,
                maxParallelRequests: 1,
              },
            }
          : {}),
      },
    );

    if (
      [...response.writes, ...response.deletes].some(
        (item) => item.status !== ClientWriteStatus.SUCCESS,
      )
    ) {
      throw new Error("OpenFGA did not apply every relationship tuple.");
    }
  }

  private async checkPermission(input: {
    userId: string;
    relation: string;
    object: string;
  }): Promise<boolean> {
    const response = await this.client.check(
      {
        user: `user:${input.userId}`,
        relation: input.relation,
        object: input.object,
      },
      {
        /**
         * Revocation must affect the next protected operation. Higher
         * consistency deliberately prefers safer decisions over stale cache
         * latency for organization, team, and workbook permissions alike.
         */
        consistency: ConsistencyPreference.HigherConsistency,
      },
    );

    // Only an explicit `true` allows access. Missing or malformed decision data
    // fails closed rather than being treated as a permissive truthy value.
    return response.allowed === true;
  }
}

export function createOpenFgaAuthorizationGateway(
  config: AuthorizationConfig,
): OpenFgaAuthorizationGateway {
  const client = new OpenFgaClient({
    apiUrl: config.apiUrl.href.replace(/\/$/u, ""),
    storeId: config.storeId,
    authorizationModelId: config.authorizationModelId,
    credentials: {
      method: CredentialsMethod.ApiToken,
      config: { token: config.apiToken },
    },
  });

  return new OpenFgaAuthorizationGateway(client, config.authorizationModelId);
}
