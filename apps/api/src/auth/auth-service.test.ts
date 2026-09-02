import type { AuthenticatedUser } from "@zerosheet/contracts";
import { describe, expect, it } from "vitest";
import { AuthService, AuthenticationFlowError } from "./auth-service.js";
import { hashOpaqueToken } from "./opaque-tokens.js";
import type {
  AuthRepository,
  CreateSessionInput,
  IdentityProviderHint,
  OidcGateway,
  SaveLoginTransactionInput,
  StoredLoginTransaction,
  UpsertExternalIdentityInput,
} from "./types.js";

const now = new Date("2026-09-02T10:00:00.000Z");
const user: AuthenticatedUser = {
  id: "c16e7ff0-2dad-46f3-957b-7733a4f21c69",
  email: "learner@zerosheet.local",
  displayName: "ZeroSheet Learner",
};

/**
 * This in-memory repository records exact values crossing the persistence
 * boundary. It is intentionally not a fake database: PostgreSQL-specific SQL is
 * verified by the infrastructure script, while this suite proves AuthService
 * never asks storage to retain a raw browser credential.
 */
class RecordingRepository implements AuthRepository {
  public savedTransaction: SaveLoginTransactionInput | undefined;
  public consumedSelectorHash: string | undefined;
  public consumedState: string | undefined;
  public transaction: StoredLoginTransaction | null = {
    state: "oidc-state",
    nonce: "oidc-nonce",
    codeVerifier: "pkce-verifier",
  };
  public identity: UpsertExternalIdentityInput | undefined;
  public session: CreateSessionInput | undefined;
  public sessionUser: AuthenticatedUser | null = user;
  public deletedSessionHash: string | undefined;

  public assertReady(): Promise<void> {
    return Promise.resolve();
  }

  public saveLoginTransaction(input: SaveLoginTransactionInput): Promise<void> {
    this.savedTransaction = input;
    return Promise.resolve();
  }

  public consumeLoginTransaction(
    selectorHash: string,
    state: string,
  ): Promise<StoredLoginTransaction | null> {
    this.consumedSelectorHash = selectorHash;
    this.consumedState = state;
    return Promise.resolve(this.transaction);
  }

  public upsertExternalIdentity(
    input: UpsertExternalIdentityInput,
  ): Promise<AuthenticatedUser> {
    this.identity = input;
    return Promise.resolve(user);
  }

  public createSession(input: CreateSessionInput): Promise<void> {
    this.session = input;
    return Promise.resolve();
  }

  public findSessionUser(): Promise<AuthenticatedUser | null> {
    return Promise.resolve(this.sessionUser);
  }

  public deleteSession(selectorHash: string): Promise<void> {
    this.deletedSessionHash = selectorHash;
    return Promise.resolve();
  }
}

class RecordingOidcGateway implements OidcGateway {
  public exchangedTransaction: StoredLoginTransaction | undefined;
  public identityProviderHint: IdentityProviderHint | undefined;

  public createAuthorizationRequest(
    identityProviderHint?: IdentityProviderHint,
  ) {
    this.identityProviderHint = identityProviderHint;

    return Promise.resolve({
      authorizationUrl: new URL("http://keycloak.local/authorize"),
      state: "oidc-state",
      nonce: "oidc-nonce",
      codeVerifier: "pkce-verifier",
    });
  }

  public exchangeAuthorizationCode(
    _callbackUrl: URL,
    transaction: StoredLoginTransaction,
  ) {
    this.exchangedTransaction = transaction;
    return Promise.resolve({
      issuer: "http://keycloak.local/realms/zerosheet",
      subject: "keycloak-subject",
      email: user.email,
      emailVerified: true,
      displayName: user.displayName,
    });
  }

  public createLogoutUrl(): URL {
    return new URL("http://keycloak.local/logout");
  }
}

function serviceFixture() {
  const repository = new RecordingRepository();
  const oidc = new RecordingOidcGateway();
  const tokens = ["raw-transaction-token", "raw-session-token"];
  const service = new AuthService({
    repository,
    oidc,
    lifetimes: { loginTransactionSeconds: 600, sessionSeconds: 28_800 },
    now: () => now,
    opaqueToken: () => tokens.shift() ?? "unexpected-extra-token",
    userId: () => user.id,
  });

  return { service, repository, oidc };
}

describe("AuthService", () => {
  it("stores only a digest of the browser login transaction token", async () => {
    const { service, repository } = serviceFixture();

    const started = await service.beginLogin();

    expect(started.transactionToken).toBe("raw-transaction-token");
    expect(repository.savedTransaction).toMatchObject({
      selectorHash: hashOpaqueToken("raw-transaction-token"),
      state: "oidc-state",
      nonce: "oidc-nonce",
      codeVerifier: "pkce-verifier",
      createdAt: now,
      expiresAt: new Date("2026-09-02T10:10:00.000Z"),
    });
    expect(JSON.stringify(repository.savedTransaction)).not.toContain(
      "raw-transaction-token",
    );
  });

  it("forwards the reviewed Google alias without changing the login transaction", async () => {
    const { service, repository, oidc } = serviceFixture();

    await service.beginLogin("google");

    expect(oidc.identityProviderHint).toBe("google");
    expect(repository.savedTransaction).toMatchObject({
      state: "oidc-state",
      nonce: "oidc-nonce",
      codeVerifier: "pkce-verifier",
    });
  });

  it("consumes PKCE state and creates a separately hashed product session", async () => {
    const { service, repository, oidc } = serviceFixture();
    await service.beginLogin();

    const completed = await service.completeLogin(
      new URL("http://127.0.0.1:3001/auth/callback?code=code&state=oidc-state"),
      "raw-transaction-token",
    );

    expect(repository.consumedSelectorHash).toBe(
      hashOpaqueToken("raw-transaction-token"),
    );
    expect(repository.consumedState).toBe("oidc-state");
    expect(oidc.exchangedTransaction).toEqual(repository.transaction);
    expect(repository.identity).toMatchObject({
      issuer: "http://keycloak.local/realms/zerosheet",
      subject: "keycloak-subject",
      candidateUserId: user.id,
    });
    expect(repository.session).toMatchObject({
      selectorHash: hashOpaqueToken("raw-session-token"),
      userId: user.id,
      expiresAt: new Date("2026-09-02T18:00:00.000Z"),
    });
    expect(completed).toEqual({
      sessionToken: "raw-session-token",
      user,
    });
  });

  it("rejects callbacks without both browser transaction and state", async () => {
    const { service } = serviceFixture();

    await expect(
      service.completeLogin(
        new URL("http://127.0.0.1:3001/auth/callback?code=code"),
        undefined,
      ),
    ).rejects.toBeInstanceOf(AuthenticationFlowError);
  });

  it("hashes session cookies before lookup and deletion", async () => {
    const { service, repository } = serviceFixture();

    await expect(service.currentUser("raw-session-token")).resolves.toEqual(
      user,
    );
    await service.logout("raw-session-token");

    expect(repository.deletedSessionHash).toBe(
      hashOpaqueToken("raw-session-token"),
    );
  });
});
