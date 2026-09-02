import type {
  GoogleStorageAccessTokenResponse,
  GoogleStorageConnectionStatus,
} from "@zerosheet/contracts";

export interface SaveGoogleOAuthTransactionInput {
  readonly selectorHash: string;
  readonly userId: string;
  readonly state: string;
  readonly codeVerifier: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

export interface StoredGoogleOAuthTransaction {
  readonly codeVerifier: string;
}

export interface GoogleStorageConnection {
  readonly userId: string;
  readonly encryptedRefreshToken: string;
  readonly grantedScopes: readonly string[];
  readonly connectedAt: Date;
}

export interface SaveGoogleStorageConnectionInput extends GoogleStorageConnection {
  readonly updatedAt: Date;
}

/**
 * The repository stores an encrypted credential and protocol transaction
 * state. It has no method that accepts a plaintext refresh token, making an
 * accidental database write from application code harder.
 */
export interface GoogleStorageRepository {
  assertReady(): Promise<void>;
  saveOAuthTransaction(input: SaveGoogleOAuthTransactionInput): Promise<void>;
  consumeOAuthTransaction(
    selectorHash: string,
    state: string,
    userId: string,
    now: Date,
  ): Promise<StoredGoogleOAuthTransaction | null>;
  saveConnection(input: SaveGoogleStorageConnectionInput): Promise<void>;
  findConnection(userId: string): Promise<GoogleStorageConnection | null>;
  deleteConnection(userId: string): Promise<void>;
}

export interface GoogleOAuthTokenResult {
  readonly accessToken: string;
  readonly expiresInSeconds: number;
  readonly refreshToken?: string;
  readonly grantedScopes?: readonly string[];
}

/** Fixed-endpoint gateway around Google's OAuth authorization server. */
export interface GoogleStorageOAuthGateway {
  createAuthorizationUrl(input: {
    readonly state: string;
    readonly codeChallenge: string;
  }): URL;
  exchangeAuthorizationCode(input: {
    readonly code: string;
    readonly codeVerifier: string;
  }): Promise<GoogleOAuthTokenResult>;
  refreshAccessToken(refreshToken: string): Promise<GoogleOAuthTokenResult>;
  revoke(refreshToken: string): Promise<void>;
}

export interface GoogleRefreshTokenProtector {
  seal(userId: string, refreshToken: string): string;
  open(userId: string, envelope: string): string;
}

export interface StartedGoogleStorageConnection {
  readonly authorizationUrl: URL;
  readonly transactionToken: string;
}

export interface GoogleStorageApplicationService {
  status(userId: string): Promise<GoogleStorageConnectionStatus>;
  beginConnection(userId: string): Promise<StartedGoogleStorageConnection>;
  completeConnection(input: {
    readonly userId: string;
    readonly callbackUrl: URL;
    readonly transactionToken: string | undefined;
  }): Promise<void>;
  accessToken(
    userId: string,
    forceRefresh: boolean,
  ): Promise<GoogleStorageAccessTokenResponse>;
  disconnect(userId: string): Promise<void>;
}
