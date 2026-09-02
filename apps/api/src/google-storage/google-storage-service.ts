import { createHash } from "node:crypto";
import type {
  GoogleStorageAccessTokenResponse,
  GoogleStorageConnectionStatus,
} from "@zerosheet/contracts";
import { createOpaqueToken, hashOpaqueToken } from "../auth/opaque-tokens.js";
import {
  GoogleStorageConnectionRequiredError,
  GoogleStorageDependencyError,
  GoogleStorageNotConfiguredError,
  GoogleStorageOAuthFlowError,
} from "./errors.js";
import type {
  GoogleRefreshTokenProtector,
  GoogleStorageApplicationService,
  GoogleStorageOAuthGateway,
  GoogleStorageRepository,
  StartedGoogleStorageConnection,
} from "./types.js";

const REQUIRED_SCOPES = [
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/drive.appdata",
] as const;
const ACCESS_TOKEN_REFRESH_BUFFER_MS = 60_000;

export interface GoogleStorageServiceOptions {
  readonly repository: GoogleStorageRepository;
  readonly oauth: GoogleStorageOAuthGateway;
  readonly refreshTokens: GoogleRefreshTokenProtector;
  readonly transactionSeconds: number;
  readonly now?: () => Date;
  readonly opaqueToken?: () => string;
}

/**
 * Coordinates a second OAuth relationship after human authentication. Google
 * can authorize a different account than the Keycloak login account; that is
 * an explicit storage choice, not an identity-linking operation.
 */
export class GoogleStorageService implements GoogleStorageApplicationService {
  readonly #repository: GoogleStorageRepository;
  readonly #oauth: GoogleStorageOAuthGateway;
  readonly #refreshTokens: GoogleRefreshTokenProtector;
  readonly #transactionSeconds: number;
  readonly #now: () => Date;
  readonly #opaqueToken: () => string;
  readonly #accessTokens = new Map<string, GoogleStorageAccessTokenResponse>();
  readonly #refreshes = new Map<
    string,
    Promise<GoogleStorageAccessTokenResponse>
  >();

  public constructor(options: GoogleStorageServiceOptions) {
    this.#repository = options.repository;
    this.#oauth = options.oauth;
    this.#refreshTokens = options.refreshTokens;
    this.#transactionSeconds = options.transactionSeconds;
    this.#now = options.now ?? (() => new Date());
    this.#opaqueToken = options.opaqueToken ?? createOpaqueToken;
  }

  public async status(userId: string): Promise<GoogleStorageConnectionStatus> {
    const connection = await this.#repository.findConnection(userId);
    if (!connection || !hasRequiredScopes(connection.grantedScopes)) {
      return {
        configured: true,
        connected: false,
        requiredScopes: [...REQUIRED_SCOPES],
      };
    }
    return {
      configured: true,
      connected: true,
      requiredScopes: [...REQUIRED_SCOPES],
      grantedScopes: [...connection.grantedScopes],
      connectedAt: connection.connectedAt.toISOString(),
    };
  }

  public async beginConnection(
    userId: string,
  ): Promise<StartedGoogleStorageConnection> {
    const now = this.#now();
    const transactionToken = this.#opaqueToken();
    const state = this.#opaqueToken();
    const codeVerifier = this.#opaqueToken();
    const codeChallenge = createHash("sha256")
      .update(codeVerifier, "utf8")
      .digest("base64url");

    await this.#repository.saveOAuthTransaction({
      selectorHash: hashOpaqueToken(transactionToken),
      userId,
      state,
      codeVerifier,
      createdAt: now,
      expiresAt: new Date(now.getTime() + this.#transactionSeconds * 1_000),
    });

    return {
      authorizationUrl: this.#oauth.createAuthorizationUrl({
        state,
        codeChallenge,
      }),
      transactionToken,
    };
  }

  public async completeConnection(input: {
    readonly userId: string;
    readonly callbackUrl: URL;
    readonly transactionToken: string | undefined;
  }): Promise<void> {
    const state = input.callbackUrl.searchParams.get("state");
    const code = input.callbackUrl.searchParams.get("code");
    if (!input.transactionToken || !state) {
      throw new GoogleStorageOAuthFlowError();
    }

    const transaction = await this.#repository.consumeOAuthTransaction(
      hashOpaqueToken(input.transactionToken),
      state,
      input.userId,
      this.#now(),
    );
    if (!transaction || !code || input.callbackUrl.searchParams.has("error")) {
      throw new GoogleStorageOAuthFlowError();
    }

    try {
      const token = await this.#oauth.exchangeAuthorizationCode({
        code,
        codeVerifier: transaction.codeVerifier,
      });
      if (
        !token.refreshToken ||
        !token.grantedScopes ||
        !hasRequiredScopes(token.grantedScopes)
      ) {
        throw new GoogleStorageOAuthFlowError();
      }

      const now = this.#now();
      await this.#repository.saveConnection({
        userId: input.userId,
        encryptedRefreshToken: this.#refreshTokens.seal(
          input.userId,
          token.refreshToken,
        ),
        grantedScopes: canonicalScopes(token.grantedScopes),
        connectedAt: now,
        updatedAt: now,
      });
      this.#accessTokens.set(input.userId, tokenResponse(token, now));
    } catch (error) {
      if (error instanceof GoogleStorageOAuthFlowError) throw error;
      throw new GoogleStorageOAuthFlowError();
    }
  }

  public async accessToken(
    userId: string,
    forceRefresh: boolean,
  ): Promise<GoogleStorageAccessTokenResponse> {
    const cached = this.#accessTokens.get(userId);
    if (!forceRefresh && cached && this.isUsable(cached)) return cached;

    const existingRefresh = this.#refreshes.get(userId);
    if (existingRefresh) {
      const result = await existingRefresh;
      if (!forceRefresh) return result;
    }

    if (forceRefresh) this.#accessTokens.delete(userId);
    const refresh = this.refreshAccessToken(userId);
    this.#refreshes.set(userId, refresh);
    try {
      return await refresh;
    } finally {
      if (this.#refreshes.get(userId) === refresh) {
        this.#refreshes.delete(userId);
      }
    }
  }

  public async disconnect(userId: string): Promise<void> {
    const connection = await this.#repository.findConnection(userId);

    // Delete local authority first. Even if Google is unreachable, ZeroSheet
    // immediately loses its durable way to obtain another access token.
    await this.#repository.deleteConnection(userId);
    this.#accessTokens.delete(userId);
    this.#refreshes.delete(userId);

    if (!connection) return;
    try {
      const refreshToken = this.#refreshTokens.open(
        userId,
        connection.encryptedRefreshToken,
      );
      await this.#oauth.revoke(refreshToken);
    } catch {
      // Revocation is best effort after local deletion. The user can also
      // remove ZeroSheet from Google Account permissions if Google was down.
    }
  }

  private async refreshAccessToken(
    userId: string,
  ): Promise<GoogleStorageAccessTokenResponse> {
    const connection = await this.#repository.findConnection(userId);
    if (!connection || !hasRequiredScopes(connection.grantedScopes)) {
      throw new GoogleStorageConnectionRequiredError();
    }

    let token;
    try {
      const refreshToken = this.#refreshTokens.open(
        userId,
        connection.encryptedRefreshToken,
      );
      token = await this.#oauth.refreshAccessToken(refreshToken);
    } catch (error) {
      if (error instanceof GoogleStorageConnectionRequiredError) throw error;
      throw new GoogleStorageDependencyError();
    }

    const scopes = token.grantedScopes ?? connection.grantedScopes;
    if (!hasRequiredScopes(scopes)) {
      throw new GoogleStorageConnectionRequiredError();
    }
    const now = this.#now();

    // Google normally omits refresh_token on refresh. If it rotates one, save
    // the new encrypted value before returning the access token.
    if (token.refreshToken) {
      await this.#repository.saveConnection({
        userId,
        encryptedRefreshToken: this.#refreshTokens.seal(
          userId,
          token.refreshToken,
        ),
        grantedScopes: canonicalScopes(scopes),
        connectedAt: connection.connectedAt,
        updatedAt: now,
      });
    }

    const response = tokenResponse(token, now);
    this.#accessTokens.set(userId, response);
    return response;
  }

  private isUsable(token: GoogleStorageAccessTokenResponse): boolean {
    return (
      new Date(token.expiresAt).getTime() - this.#now().getTime() >
      ACCESS_TOKEN_REFRESH_BUFFER_MS
    );
  }
}

/** Disabled deployments still expose honest status and fail every mutation. */
export class DisabledGoogleStorageService implements GoogleStorageApplicationService {
  public status(): Promise<GoogleStorageConnectionStatus> {
    return Promise.resolve({
      configured: false,
      connected: false,
      requiredScopes: [...REQUIRED_SCOPES],
    });
  }

  public beginConnection(): Promise<StartedGoogleStorageConnection> {
    return Promise.reject(new GoogleStorageNotConfiguredError());
  }

  public completeConnection(): Promise<void> {
    return Promise.reject(new GoogleStorageNotConfiguredError());
  }

  public accessToken(): Promise<GoogleStorageAccessTokenResponse> {
    return Promise.reject(new GoogleStorageNotConfiguredError());
  }

  public disconnect(): Promise<void> {
    return Promise.reject(new GoogleStorageNotConfiguredError());
  }
}

function tokenResponse(
  token: { readonly accessToken: string; readonly expiresInSeconds: number },
  now: Date,
): GoogleStorageAccessTokenResponse {
  return {
    accessToken: token.accessToken,
    expiresAt: new Date(
      now.getTime() + token.expiresInSeconds * 1_000,
    ).toISOString(),
  };
}

function canonicalScopes(scopes: readonly string[]): string[] {
  return [...new Set(scopes)].sort();
}

function hasRequiredScopes(scopes: readonly string[]): boolean {
  const granted = new Set(scopes);
  return REQUIRED_SCOPES.every((scope) => granted.has(scope));
}
