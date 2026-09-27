import type { AuthenticatedUser } from "@zerosheet/contracts";
import { describe, expect, it, vi } from "vitest";
import { AuthService, AuthenticationFlowError } from "./auth-service.js";
import type { AuthServiceOptions } from "./auth-service.js";
import { GoogleStorageOnboardingError } from "../google-storage/errors.js";
import { hashOpaqueToken } from "./opaque-tokens.js";
import type {
  AuthRepository,
  CreateSessionInput,
  OidcGateway,
  SaveLoginTransactionInput,
  StoredLoginTransaction,
  UpsertExternalIdentityInput,
  VerifiedOidcLogin,
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
    const transaction = this.transaction;
    this.transaction = null;
    return Promise.resolve(transaction?.state === state ? transaction : null);
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
  public login: VerifiedOidcLogin = {
    identity: {
      issuer: "https://accounts.google.com",
      subject: "google-subject",
      email: user.email,
      emailVerified: true,
      displayName: user.displayName,
    },
  };

  public createAuthorizationRequest() {
    return Promise.resolve({
      authorizationUrl: new URL("https://accounts.google.com/o/oauth2/v2/auth"),
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
    return Promise.resolve(this.login);
  }
}

function serviceFixture(connectStorage?: AuthServiceOptions["connectStorage"]) {
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
    ...(connectStorage ? { connectStorage } : {}),
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

  it("consumes PKCE state and creates a separately hashed product session", async () => {
    const { service, repository, oidc } = serviceFixture();
    await service.beginLogin();

    const completed = await service.completeLogin(
      new URL("http://localhost:3001/auth/callback?code=code&state=oidc-state"),
      "raw-transaction-token",
    );

    expect(repository.consumedSelectorHash).toBe(
      hashOpaqueToken("raw-transaction-token"),
    );
    expect(repository.consumedState).toBe("oidc-state");
    expect(oidc.exchangedTransaction).toMatchObject({
      state: "oidc-state",
      nonce: "oidc-nonce",
      codeVerifier: "pkce-verifier",
    });
    expect(repository.transaction).toBeNull();
    expect(repository.identity).toMatchObject({
      issuer: "https://accounts.google.com",
      subject: "google-subject",
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
        new URL("http://localhost:3001/auth/callback?code=code"),
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

  it("connects verified storage before issuing a session, without leaking tokens", async () => {
    const connect = vi.fn<NonNullable<AuthServiceOptions["connectStorage"]>>();
    const { service, repository, oidc } = serviceFixture(connect);
    const grant = {
      accessToken: "private-access-token",
      refreshToken: "private-refresh-token",
      expiresInSeconds: 3600,
    };
    oidc.login = { ...oidc.login, storageGrant: grant };
    connect.mockImplementation((actingUserId, receivedGrant) => {
      expect(actingUserId).toBe(user.id);
      expect(receivedGrant).toBe(grant);
      expect(repository.session).toBeUndefined();
      return Promise.resolve();
    });
    await service.beginLogin();
    const callback = new URL(
      "http://localhost:3001/auth/callback?code=code&state=oidc-state",
    );
    const completed = await service.completeLogin(
      callback,
      "raw-transaction-token",
    );
    expect(connect).toHaveBeenCalledTimes(1);
    expect(repository.session?.userId).toBe(user.id);
    expect(JSON.stringify(repository.identity)).not.toContain("token");
    expect(JSON.stringify(completed)).not.toContain("private-");
    await expect(
      service.completeLogin(callback, "raw-transaction-token"),
    ).rejects.toBeInstanceOf(AuthenticationFlowError);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("does not issue a session when the combined grant is missing", async () => {
    const connect = vi.fn<NonNullable<AuthServiceOptions["connectStorage"]>>();
    const { service, repository } = serviceFixture(connect);
    await service.beginLogin();
    await expect(
      service.completeLogin(
        new URL(
          "http://localhost:3001/auth/callback?code=code&state=oidc-state",
        ),
        "raw-transaction-token",
      ),
    ).rejects.toBeInstanceOf(GoogleStorageOnboardingError);
    expect(connect).not.toHaveBeenCalled();
    expect(repository.session).toBeUndefined();
  });

  it("does not issue a session or expose provider details when storage persistence fails", async () => {
    const connect = vi
      .fn<NonNullable<AuthServiceOptions["connectStorage"]>>()
      .mockRejectedValue(new Error("sensitive-token-details"));
    const { service, repository, oidc } = serviceFixture(connect);
    oidc.login = {
      ...oidc.login,
      storageGrant: {
        accessToken: "private-access",
        refreshToken: "private-refresh",
        expiresInSeconds: 3600,
      },
    };
    await service.beginLogin();
    await expect(
      service.completeLogin(
        new URL(
          "http://localhost:3001/auth/callback?code=code&state=oidc-state",
        ),
        "raw-transaction-token",
      ),
    ).rejects.toEqual(new GoogleStorageOnboardingError());
    expect(repository.session).toBeUndefined();
  });

  it("does not connect storage when OIDC identity validation fails", async () => {
    const connect = vi.fn<NonNullable<AuthServiceOptions["connectStorage"]>>();
    const { service, repository, oidc } = serviceFixture(connect);
    vi.spyOn(oidc, "exchangeAuthorizationCode").mockRejectedValue(
      new Error("invalid token"),
    );
    await service.beginLogin();
    await expect(
      service.completeLogin(
        new URL(
          "http://localhost:3001/auth/callback?code=code&state=oidc-state",
        ),
        "raw-transaction-token",
      ),
    ).rejects.toBeInstanceOf(AuthenticationFlowError);
    expect(connect).not.toHaveBeenCalled();
    expect(repository.identity).toBeUndefined();
    expect(repository.session).toBeUndefined();
  });
});
