import { describe, expect, it } from "vitest";
import {
  DisabledGoogleStorageService,
  GoogleStorageService,
} from "./google-storage-service.js";
import { AesGcmGoogleRefreshTokenProtector } from "./refresh-token-protector.js";
import type {
  GoogleOAuthTokenResult,
  GoogleStorageConnection,
  GoogleStorageApplicationService,
  GoogleStorageOAuthGateway,
  GoogleStorageRepository,
  SaveGoogleOAuthTransactionInput,
  SaveGoogleStorageConnectionInput,
} from "./types.js";

const userId = "d19b70b8-d531-43ac-a734-12270ca484d3";
const requiredScopes = [
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/drive.appdata",
] as const;

class FakeGoogleStorageRepository implements GoogleStorageRepository {
  public transaction: SaveGoogleOAuthTransactionInput | undefined;
  public connection: GoogleStorageConnection | null = null;
  public deleted = false;

  public assertReady(): Promise<void> {
    return Promise.resolve();
  }

  public saveOAuthTransaction(input: SaveGoogleOAuthTransactionInput) {
    this.transaction = input;
    return Promise.resolve();
  }

  public consumeOAuthTransaction(
    selectorHash: string,
    state: string,
    requestedUserId: string,
    now: Date,
  ) {
    const transaction = this.transaction;
    this.transaction = undefined;
    if (
      !transaction ||
      transaction.selectorHash !== selectorHash ||
      transaction.state !== state ||
      transaction.userId !== requestedUserId ||
      transaction.expiresAt <= now
    ) {
      return Promise.resolve(null);
    }
    return Promise.resolve({ codeVerifier: transaction.codeVerifier });
  }

  public saveConnection(input: SaveGoogleStorageConnectionInput) {
    this.connection = {
      userId: input.userId,
      encryptedRefreshToken: input.encryptedRefreshToken,
      grantedScopes: input.grantedScopes,
      connectedAt: input.connectedAt,
    };
    return Promise.resolve();
  }

  public findConnection(requestedUserId: string) {
    return Promise.resolve(
      this.connection?.userId === requestedUserId ? this.connection : null,
    );
  }

  public deleteConnection(): Promise<void> {
    this.deleted = true;
    this.connection = null;
    return Promise.resolve();
  }
}

class FakeGoogleOAuthGateway implements GoogleStorageOAuthGateway {
  public exchange: GoogleOAuthTokenResult = {
    accessToken: "initial-access-token",
    refreshToken: "initial-refresh-token",
    expiresInSeconds: 3_600,
    grantedScopes: requiredScopes,
  };
  public refreshed: GoogleOAuthTokenResult = {
    accessToken: "refreshed-access-token",
    expiresInSeconds: 3_600,
  };
  public exchangedCode: string | undefined;
  public exchangedVerifier: string | undefined;
  public refreshCalls = 0;
  public revokedToken: string | undefined;

  public createAuthorizationUrl(input: {
    state: string;
    codeChallenge: string;
  }): URL {
    const url = new URL("https://accounts.google.test/authorize");
    url.searchParams.set("state", input.state);
    url.searchParams.set("code_challenge", input.codeChallenge);
    return url;
  }

  public exchangeAuthorizationCode(input: {
    code: string;
    codeVerifier: string;
  }): Promise<GoogleOAuthTokenResult> {
    this.exchangedCode = input.code;
    this.exchangedVerifier = input.codeVerifier;
    return Promise.resolve(this.exchange);
  }

  public refreshAccessToken(): Promise<GoogleOAuthTokenResult> {
    this.refreshCalls += 1;
    return Promise.resolve(this.refreshed);
  }

  public revoke(refreshToken: string): Promise<void> {
    this.revokedToken = refreshToken;
    return Promise.resolve();
  }
}

function createService() {
  const repository = new FakeGoogleStorageRepository();
  const oauth = new FakeGoogleOAuthGateway();
  const protector = new AesGcmGoogleRefreshTokenProtector(
    new Uint8Array(32).fill(11),
  );
  let tokenIndex = 0;
  const tokens = [
    "transaction-token-00000000000000000000000001",
    "state-token-000000000000000000000000000001",
    "verifier-token-0000000000000000000000000001",
  ];
  const service = new GoogleStorageService({
    repository,
    oauth,
    refreshTokens: protector,
    transactionSeconds: 600,
    now: () => new Date("2026-09-03T01:00:00.000Z"),
    opaqueToken: () => tokens[tokenIndex++] as string,
  });
  return { service, repository, oauth, protector };
}

async function completeConnection(
  setup: ReturnType<typeof createService>,
): Promise<void> {
  const started = await setup.service.beginConnection(userId);
  const state = started.authorizationUrl.searchParams.get("state") as string;
  await setup.service.completeConnection({
    userId,
    transactionToken: started.transactionToken,
    callbackUrl: new URL(
      `http://127.0.0.1:3001/google/storage/callback?code=google-code&state=${encodeURIComponent(state)}`,
    ),
  });
}

describe("GoogleStorageService", () => {
  it("binds a one-use PKCE transaction to the signed-in product user", async () => {
    const setup = createService();
    const started = await setup.service.beginConnection(userId);

    expect(started.authorizationUrl.protocol).toBe("https:");
    expect(setup.repository.transaction?.userId).toBe(userId);
    expect(setup.repository.transaction?.selectorHash).not.toContain(
      started.transactionToken,
    );
    expect(
      started.authorizationUrl.searchParams.get("code_challenge"),
    ).not.toBe(setup.repository.transaction?.codeVerifier);
  });

  it("stores only an encrypted refresh token after exact scope consent", async () => {
    const setup = createService();
    await completeConnection(setup);

    expect(setup.oauth.exchangedCode).toBe("google-code");
    expect(setup.repository.connection?.encryptedRefreshToken).not.toContain(
      "initial-refresh-token",
    );
    expect(
      setup.protector.open(
        userId,
        setup.repository.connection?.encryptedRefreshToken as string,
      ),
    ).toBe("initial-refresh-token");
    await expect(setup.service.status(userId)).resolves.toMatchObject({
      configured: true,
      connected: true,
    });
  });

  it("rejects incomplete consent instead of storing a partial grant", async () => {
    const setup = createService();
    setup.oauth.exchange = {
      ...setup.oauth.exchange,
      grantedScopes: [requiredScopes[0]],
    };
    const started = await setup.service.beginConnection(userId);
    const state = started.authorizationUrl.searchParams.get("state") as string;

    await expect(
      setup.service.completeConnection({
        userId,
        transactionToken: started.transactionToken,
        callbackUrl: new URL(
          `http://127.0.0.1:3001/google/storage/callback?code=google-code&state=${state}`,
        ),
      }),
    ).rejects.toMatchObject({ name: "GoogleStorageOAuthFlowError" });
    expect(setup.repository.connection).toBeNull();
  });

  it("caches access tokens and performs an explicit forced refresh after 401", async () => {
    const setup = createService();
    await completeConnection(setup);

    await expect(
      setup.service.accessToken(userId, false),
    ).resolves.toMatchObject({ accessToken: "initial-access-token" });
    expect(setup.oauth.refreshCalls).toBe(0);

    await expect(
      setup.service.accessToken(userId, true),
    ).resolves.toMatchObject({ accessToken: "refreshed-access-token" });
    expect(setup.oauth.refreshCalls).toBe(1);
  });

  it("deletes local refresh authority before best-effort Google revocation", async () => {
    const setup = createService();
    await completeConnection(setup);
    await setup.service.disconnect(userId);

    expect(setup.repository.deleted).toBe(true);
    expect(setup.oauth.revokedToken).toBe("initial-refresh-token");
    await expect(setup.service.status(userId)).resolves.toMatchObject({
      connected: false,
    });
  });

  it("reports disabled deployments honestly and denies connection attempts", async () => {
    // Widening to the application interface verifies that the disabled adapter
    // remains substitutable for the configured service at the composition root.
    const service: GoogleStorageApplicationService =
      new DisabledGoogleStorageService();

    await expect(service.status(userId)).resolves.toMatchObject({
      configured: false,
      connected: false,
    });
    await expect(service.beginConnection(userId)).rejects.toMatchObject({
      name: "GoogleStorageNotConfiguredError",
    });
  });
});
