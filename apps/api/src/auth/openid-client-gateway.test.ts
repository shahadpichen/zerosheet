import * as client from "openid-client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createOpenIdClientGateway } from "./openid-client-gateway.js";
import type { OidcConfig } from "../config.js";
import { GOOGLE_STORAGE_SCOPES } from "../google-storage/consent.js";
import { GoogleStorageOnboardingError } from "../google-storage/errors.js";

/**
 * Replace only provider I/O. The real URL builder/PKCE implementation remains
 * active, and assertions prove the code exchange still receives all OIDC
 * checks. No personal account, real token, or network request is used here.
 */
vi.mock("openid-client", async (importOriginal) => ({
  ...(await importOriginal<typeof client>()),
  discovery: vi.fn(),
  authorizationCodeGrant: vi.fn(),
}));

const googleClient = {
  clientId: "shared-client",
  clientSecret: "test-only-secret",
};
const transaction = {
  state: "expected-state",
  nonce: "expected-nonce",
  codeVerifier: "expected-verifier",
};
const callback = new URL(
  "http://localhost:3101/auth/callback?code=test-code&state=expected-state",
);
const claims = {
  iss: "https://accounts.google.com",
  aud: googleClient.clientId,
  sub: "verified-google-subject",
  iat: 1,
  exp: 100,
  email: "learner@example.com",
  email_verified: true,
  name: "Learner",
};

// The library combines a JSON response with helper methods. Construct those
// parts separately too; keep the JSON fixture mutable for partial-consent tests.
interface TestTokenPayload {
  [parameter: string]: string | number | undefined;
  access_token: string;
  token_type: "bearer";
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}

function tokenResponse() {
  const payload: TestTokenPayload = {
    access_token: "test-access-token",
    refresh_token: "test-refresh-token",
    token_type: "bearer",
    expires_in: 3600,
    scope: ["openid", "email", "profile", ...GOOGLE_STORAGE_SCOPES].join(" "),
  };
  return Object.assign(payload, {
    claims: () => claims,
    expiresIn: () => 3600,
  });
}

async function gateway(overrides: Partial<OidcConfig> = {}) {
  return createOpenIdClientGateway(googleClient, {
    issuerUrl: new URL("https://accounts.google.com"),
    callbackUrl: new URL("http://localhost:3101/auth/callback"),
    hostedDomain: undefined,
    connectStorageOnLogin: true,
    ...overrides,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(client.discovery).mockResolvedValue(
    new client.Configuration(
      {
        issuer: "https://accounts.google.com",
        authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
        token_endpoint: "https://oauth2.googleapis.com/token",
      },
      googleClient.clientId,
      googleClient.clientSecret,
    ),
  );
  vi.mocked(client.authorizationCodeGrant).mockResolvedValue(tokenResponse());
});

describe("combined Google OIDC and storage exchange", () => {
  it("returns identity and storage from exactly one verified code exchange", async () => {
    const login = await gateway();
    const result = await login.exchangeAuthorizationCode(callback, transaction);
    expect(client.authorizationCodeGrant).toHaveBeenCalledTimes(1);
    expect(client.authorizationCodeGrant).toHaveBeenCalledWith(
      expect.any(client.Configuration),
      callback,
      {
        expectedState: transaction.state,
        expectedNonce: transaction.nonce,
        pkceCodeVerifier: transaction.codeVerifier,
        idTokenExpected: true,
      },
    );
    expect(result.identity).toMatchObject({
      subject: claims.sub,
      email: claims.email,
    });
    expect(result.storageGrant).toMatchObject({
      refreshToken: "test-refresh-token",
      accessToken: "test-access-token",
      expiresInSeconds: 3600,
    });
    expect(JSON.stringify(result.identity)).not.toContain("token");
  });

  it.each(["partial-consent", "no-refresh-token", "invalid-expiry"])(
    "refuses to finish onboarding with %s",
    async (reason) => {
      const tokens = tokenResponse();
      if (reason === "partial-consent") tokens.scope = "openid email profile";
      if (reason === "no-refresh-token") delete tokens.refresh_token;
      if (reason === "invalid-expiry") tokens.expires_in = 0;
      vi.mocked(client.authorizationCodeGrant).mockResolvedValue(tokens);
      await expect(
        (await gateway()).exchangeAuthorizationCode(callback, transaction),
      ).rejects.toBeInstanceOf(GoogleStorageOnboardingError);
    },
  );

  it("rejects an unverified email or mismatched Workspace domain before returning authority", async () => {
    const tokens = tokenResponse();
    tokens.claims = () => ({ ...claims, email_verified: false });
    vi.mocked(client.authorizationCodeGrant).mockResolvedValue(tokens);
    await expect(
      (await gateway()).exchangeAuthorizationCode(callback, transaction),
    ).rejects.toThrow(/required user claims/u);
    tokens.claims = () => ({ ...claims, hd: "other.example" });
    await expect(
      (
        await gateway({ hostedDomain: "company.example" })
      ).exchangeAuthorizationCode(callback, transaction),
    ).rejects.toThrow(/Workspace domain/u);
  });

  it("honors OAuth's unchanged-scope omission without requiring a second exchange", async () => {
    const tokens = tokenResponse();
    delete tokens.scope;
    vi.mocked(client.authorizationCodeGrant).mockResolvedValue(tokens);
    const result = await (
      await gateway()
    ).exchangeAuthorizationCode(callback, transaction);
    expect(result.storageGrant?.grantedScopes).toEqual([
      "openid",
      "email",
      "profile",
      ...GOOGLE_STORAGE_SCOPES,
    ]);
  });

  it("keeps storage-disabled IAM labs identity-only and discards delegated tokens", async () => {
    const login = await gateway({ connectStorageOnLogin: false });
    const pending = await login.createAuthorizationRequest();
    expect(pending.authorizationUrl.searchParams.get("scope")).toBe(
      "openid email profile",
    );
    expect(pending.authorizationUrl.searchParams.has("access_type")).toBe(
      false,
    );
    expect(pending.authorizationUrl.searchParams.get("prompt")).toBe(
      "select_account",
    );
    const result = await login.exchangeAuthorizationCode(callback, transaction);
    expect(result.storageGrant).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("test-refresh-token");
  });
});
