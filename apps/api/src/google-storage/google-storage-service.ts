import { createHash } from "node:crypto";
import type {
  GoogleStorageAccessTokenResponse,
  GoogleStorageConnectionStatus,
} from "@zerosheet/contracts";
import { createOpaqueToken, hashOpaqueToken } from "../auth/opaque-tokens.js";
import {
  GOOGLE_STORAGE_SCOPES,
  hasGoogleStorageScopes,
  requireGoogleStorageGrant,
} from "./consent.js";
import {
  GoogleStorageConnectionRequiredError,
  GoogleStorageDependencyError,
  GoogleStorageNotConfiguredError,
  GoogleStorageOAuthFlowError,
} from "./errors.js";
import type {
  GoogleOAuthTokenResult,
  GoogleRefreshTokenProtector,
  GoogleStorageApplicationService,
  GoogleStorageOAuthGateway,
  GoogleStorageRepository,
  StartedGoogleStorageConnection,
} from "./types.js";

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
 * Saves storage authority from combined login, or repairs it via an explicit
 * reconnect. Reconnect can choose a different storage account; combined login
 * always uses the account whose ID token was verified in that same exchange.
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
    if (!connection || !hasGoogleStorageScopes(connection.grantedScopes)) {
      return {
        configured: true,
        connected: false,
        requiredScopes: [...GOOGLE_STORAGE_SCOPES],
      };
    }
    return {
      configured: true,
      connected: true,
      requiredScopes: [...GOOGLE_STORAGE_SCOPES],
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
      await this.connectFromLogin(input.userId, token);
    } catch (error) {
      if (error instanceof GoogleStorageOAuthFlowError) throw error;
      throw new GoogleStorageOAuthFlowError();
    }
  }

  /**
   * Internal-only handoff from the verified login, or from a validated reconnect
   * transaction above. No HTTP route accepts this token object from the browser.
   * Reuse the same encryption/storage path so onboarding cannot accidentally
   * persist a plaintext refresh token while reconnect remains encrypted.
   */
  public async connectFromLogin(
    userId: string,
    token: GoogleOAuthTokenResult,
  ): Promise<void> {
    requireGoogleStorageGrant(token);
    const now = this.#now();
    await this.#repository.saveConnection({
      userId,
      encryptedRefreshToken: this.#refreshTokens.seal(
        userId,
        token.refreshToken,
      ),
      grantedScopes: canonicalScopes(token.grantedScopes),
      connectedAt: now,
      updatedAt: now,
    });
    this.#accessTokens.set(userId, tokenResponse(token, now));
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
      // Google revokes project-wide grants, including earlier identity consent.
      // This does not end the local ZeroSheet session or delete its identity.
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
    if (!connection || !hasGoogleStorageScopes(connection.grantedScopes)) {
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
    if (!hasGoogleStorageScopes(scopes)) {
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
      requiredScopes: [...GOOGLE_STORAGE_SCOPES],
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
