import { randomUUID } from "node:crypto";
import type { AuthenticatedUser } from "@zerosheet/contracts";
import type { AuthLifetimeConfig } from "../config.js";
import { createOpaqueToken, hashOpaqueToken } from "./opaque-tokens.js";
import type {
  AuthApplicationService,
  AuthRepository,
  CompletedLogin,
  IdentityProviderHint,
  OidcGateway,
  StartedLogin,
} from "./types.js";

export class AuthenticationFlowError extends Error {
  public constructor() {
    // A single public message prevents the HTTP layer from revealing which
    // security check rejected the callback.
    super("The login could not be completed. Please start again.");
    this.name = "AuthenticationFlowError";
  }
}

export interface AuthServiceOptions {
  repository: AuthRepository;
  oidc: OidcGateway;
  lifetimes: AuthLifetimeConfig;

  // Deterministic clocks and token factories make time and entropy behavior
  // testable without replacing Node.js globals in the production process.
  now?: () => Date;
  opaqueToken?: () => string;
  userId?: () => string;
}

export class AuthService implements AuthApplicationService {
  private readonly repository: AuthRepository;
  private readonly oidc: OidcGateway;
  private readonly lifetimes: AuthLifetimeConfig;
  private readonly now: () => Date;
  private readonly opaqueToken: () => string;
  private readonly userId: () => string;

  public constructor(options: AuthServiceOptions) {
    this.repository = options.repository;
    this.oidc = options.oidc;
    this.lifetimes = options.lifetimes;
    this.now = options.now ?? (() => new Date());
    this.opaqueToken = options.opaqueToken ?? createOpaqueToken;
    this.userId = options.userId ?? randomUUID;
  }

  public async beginLogin(
    identityProviderHint?: IdentityProviderHint,
  ): Promise<StartedLogin> {
    const now = this.now();
    const transactionToken = this.opaqueToken();

    // The hint changes only Keycloak's first screen. PKCE, state, nonce, the
    // callback, and the ZeroSheet session lifecycle remain exactly the same.
    const request =
      await this.oidc.createAuthorizationRequest(identityProviderHint);

    await this.repository.saveLoginTransaction({
      selectorHash: hashOpaqueToken(transactionToken),
      state: request.state,
      nonce: request.nonce,
      codeVerifier: request.codeVerifier,
      createdAt: now,
      expiresAt: new Date(
        now.getTime() + this.lifetimes.loginTransactionSeconds * 1_000,
      ),
    });

    return {
      authorizationUrl: request.authorizationUrl,
      transactionToken,
    };
  }

  public async completeLogin(
    callbackUrl: URL,
    transactionToken: string | undefined,
  ): Promise<CompletedLogin> {
    const state = callbackUrl.searchParams.get("state");

    if (!transactionToken || !state) {
      throw new AuthenticationFlowError();
    }

    /**
     * The delete happens before talking to the token endpoint. This makes the
     * transaction one-use even if two callbacks race or the provider rejects
     * the authorization code. A failed flow starts over with fresh PKCE data.
     */
    const transaction = await this.repository.consumeLoginTransaction(
      hashOpaqueToken(transactionToken),
      state,
      this.now(),
    );

    if (!transaction) {
      throw new AuthenticationFlowError();
    }

    let identity;

    try {
      identity = await this.oidc.exchangeAuthorizationCode(
        callbackUrl,
        transaction,
      );
    } catch {
      // Protocol libraries may expose low-level parsing or token errors. Those
      // details remain server-side rather than becoming an oracle for clients.
      throw new AuthenticationFlowError();
    }

    const now = this.now();
    const user = await this.repository.upsertExternalIdentity({
      ...identity,
      candidateUserId: this.userId(),
      now,
    });
    const sessionToken = this.opaqueToken();

    await this.repository.createSession({
      selectorHash: hashOpaqueToken(sessionToken),
      userId: user.id,
      createdAt: now,
      expiresAt: new Date(
        now.getTime() + this.lifetimes.sessionSeconds * 1_000,
      ),
    });

    return { sessionToken, user };
  }

  public async currentUser(
    sessionToken: string | undefined,
  ): Promise<AuthenticatedUser | null> {
    if (!sessionToken) {
      return null;
    }

    return this.repository.findSessionUser(
      hashOpaqueToken(sessionToken),
      this.now(),
    );
  }

  public async logout(sessionToken: string | undefined): Promise<void> {
    if (sessionToken) {
      await this.repository.deleteSession(hashOpaqueToken(sessionToken));
    }
  }

  public logoutUrl(): URL {
    return this.oidc.createLogoutUrl();
  }
}
