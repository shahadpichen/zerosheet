import type { AuthenticatedUser } from "@zerosheet/contracts";
import type { GoogleOAuthTokenResult } from "../google-storage/types.js";

/**
 * The OIDC gateway returns only claims the product needs. Keeping this narrow
 * stops Google-specific token objects from spreading into product code and
 * keeps a future identity-provider migration inside the adapter rather than
 * turning it into an application rewrite.
 */
export interface ExternalIdentityProfile {
  issuer: string;
  subject: string;
  email: string;
  emailVerified: boolean;
  displayName: string;
}

/**
 * Only the server-side coordinator sees the delegated grant. Separating it
 * from identity prevents a token from being spread into a user database row
 * or a browser session response. It exists only after OIDC validation passes.
 */
export interface VerifiedOidcLogin {
  readonly identity: ExternalIdentityProfile;
  readonly storageGrant?: GoogleOAuthTokenResult;
}

export interface PendingOidcAuthorization {
  authorizationUrl: URL;
  state: string;
  nonce: string;
  codeVerifier: string;
}

export interface StoredLoginTransaction {
  state: string;
  nonce: string;
  codeVerifier: string;
}

export interface SaveLoginTransactionInput extends StoredLoginTransaction {
  selectorHash: string;
  createdAt: Date;
  expiresAt: Date;
}

export interface UpsertExternalIdentityInput extends ExternalIdentityProfile {
  candidateUserId: string;
  now: Date;
}

export interface CreateSessionInput {
  selectorHash: string;
  userId: string;
  createdAt: Date;
  expiresAt: Date;
}

/**
 * Repository methods describe the state transitions authentication requires,
 * not arbitrary CRUD. In particular, consuming a login transaction must be an
 * atomic delete so the same browser callback cannot be replayed concurrently.
 */
export interface AuthRepository {
  assertReady(): Promise<void>;
  saveLoginTransaction(input: SaveLoginTransactionInput): Promise<void>;
  consumeLoginTransaction(
    selectorHash: string,
    state: string,
    now: Date,
  ): Promise<StoredLoginTransaction | null>;
  upsertExternalIdentity(
    input: UpsertExternalIdentityInput,
  ): Promise<AuthenticatedUser>;
  createSession(input: CreateSessionInput): Promise<void>;
  findSessionUser(
    selectorHash: string,
    now: Date,
  ): Promise<AuthenticatedUser | null>;
  deleteSession(selectorHash: string): Promise<void>;
}

/**
 * This interface is the Anti-Corruption Layer around `openid-client`.
 * AuthService can be tested without a network and never parses or verifies a
 * JWT itself; the standards library remains responsible for cryptography and
 * protocol validation.
 */
export interface OidcGateway {
  createAuthorizationRequest(): Promise<PendingOidcAuthorization>;
  exchangeAuthorizationCode(
    callbackUrl: URL,
    transaction: StoredLoginTransaction,
  ): Promise<VerifiedOidcLogin>;
}

export interface StartedLogin {
  authorizationUrl: URL;
  transactionToken: string;
}

export interface CompletedLogin {
  sessionToken: string;
  user: AuthenticatedUser;
}

/**
 * Routes depend on this application-facing interface. It keeps cookies and HTTP
 * status codes in the transport layer while all identity state transitions stay
 * in one service that can be exercised independently.
 */
export interface AuthApplicationService {
  beginLogin(): Promise<StartedLogin>;
  completeLogin(
    callbackUrl: URL,
    transactionToken: string | undefined,
  ): Promise<CompletedLogin>;
  currentUser(
    sessionToken: string | undefined,
  ): Promise<AuthenticatedUser | null>;
  logout(sessionToken: string | undefined): Promise<void>;
}
