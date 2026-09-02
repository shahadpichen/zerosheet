import type { AuthenticatedUser } from "@zerosheet/contracts";

/**
 * The OIDC gateway returns only claims the product needs. Keeping this narrow
 * stops Keycloak-specific token objects from spreading into product code and
 * makes a later Keycloak upgrade an adapter concern rather than an application
 * rewrite.
 */
export interface ExternalIdentityProfile {
  issuer: string;
  subject: string;
  email: string;
  emailVerified: boolean;
  displayName: string;
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

/**
 * These values are Keycloak broker aliases, not arbitrary user input. Keeping
 * the set closed prevents a query string from becoming an unchecked upstream
 * identity-provider selector. Add another value only when its Keycloak
 * provider is intentionally configured and reviewed.
 */
export type IdentityProviderHint = "google";

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
  createAuthorizationRequest(
    identityProviderHint?: IdentityProviderHint,
  ): Promise<PendingOidcAuthorization>;
  exchangeAuthorizationCode(
    callbackUrl: URL,
    transaction: StoredLoginTransaction,
  ): Promise<ExternalIdentityProfile>;
  createLogoutUrl(): URL;
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
  beginLogin(
    identityProviderHint?: IdentityProviderHint,
  ): Promise<StartedLogin>;
  completeLogin(
    callbackUrl: URL,
    transactionToken: string | undefined,
  ): Promise<CompletedLogin>;
  currentUser(
    sessionToken: string | undefined,
  ): Promise<AuthenticatedUser | null>;
  logout(sessionToken: string | undefined): Promise<void>;
  logoutUrl(): URL;
}
