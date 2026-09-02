import {
  ConsistencyPreference,
  CredentialsMethod,
  OpenFgaClient,
} from "@openfga/sdk";
import type { AuthorizationConfig } from "../config.js";
import type {
  AuthorizationGateway,
  CheckWorkbookPermissionInput,
} from "./types.js";

interface OpenFgaClientPort {
  readAuthorizationModel(): Promise<{
    authorization_model?: { id: string };
  }>;
  check(
    body: { user: string; relation: string; object: string },
    options: { consistency: ConsistencyPreference },
  ): Promise<{ allowed?: boolean }>;
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
    const response = await this.client.check(
      {
        user: `user:${input.userId}`,
        relation: input.permission,
        object: `workbook:${input.workbookId}`,
      },
      {
        /**
         * Sharing removal must take effect on the next protected request. The
         * higher-consistency preference trades some latency for safer
         * revocation behavior instead of accepting a potentially stale allow.
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
