import * as oidc from "openid-client";
import { describe, expect, it, vi } from "vitest";
import { createOpenIdClientGateway } from "./auth/openid-client-gateway.js";
import { loadRuntimeConfig } from "./config.js";
import { GoogleWebServerOAuthGateway } from "./google-storage/google-oauth-gateway.js";

/**
 * Only discovery is replaced: the real library still builds the login URL and
 * calculates PKCE. Nothing calls Google or uses personal credentials. Testing
 * both adapters together proves that one registration serves two purposes
 * with combined login/Drive consent and a separate reconnect route.
 */
vi.mock("openid-client", async (importOriginal) => ({
  ...(await importOriginal<typeof oidc>()),
  discovery: vi.fn(),
}));

describe("shared Google OAuth client", () => {
  it.each(["http://localhost:3101", "https://sheets.example.com/api"])(
    "uses one client with distinct callbacks and scope requests at %s",
    async (apiUrl) => {
      const config = loadRuntimeConfig({
        ZEROSHEET_API_URL: apiUrl,
        ZEROSHEET_WEB_URL: new URL(apiUrl).origin,
        ZEROSHEET_DB_NAME: "zerosheet",
        ZEROSHEET_DB_USER: "zerosheet_app",
        ZEROSHEET_DB_PASSWORD: "test-only-password",
        GOOGLE_OAUTH_CLIENT_ID: "shared-client.apps.googleusercontent.com",
        GOOGLE_OAUTH_CLIENT_SECRET: "test-only-client-secret",
        GOOGLE_STORAGE_OAUTH_ENABLED: "true",
        GOOGLE_STORAGE_TOKEN_ENCRYPTION_KEY:
          "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        OPENFGA_API_URL: "http://127.0.0.1:8082",
        OPENFGA_STORE_ID: "01H00000000000000000000000",
        OPENFGA_AUTHORIZATION_MODEL_ID: "01H00000000000000000000001",
        OPENFGA_PRESHARED_KEY: "test-only-openfga-key",
        OPA_API_URL: "http://127.0.0.1:8181",
      });
      const provider = new oidc.Configuration(
        {
          issuer: "https://accounts.google.com",
          authorization_endpoint:
            "https://accounts.google.com/o/oauth2/v2/auth",
          token_endpoint: "https://oauth2.googleapis.com/token",
        },
        config.googleOAuthClient.clientId,
        config.googleOAuthClient.clientSecret,
      );
      vi.mocked(oidc.discovery).mockResolvedValue(provider);

      const login = await createOpenIdClientGateway(
        config.googleOAuthClient,
        config.oidc,
      );
      const storage = new GoogleWebServerOAuthGateway(
        config.googleOAuthClient,
        {
          callbackUrl: config.googleStorage.callbackUrl,
        },
      );
      const pending = await login.createAuthorizationRequest();
      const loginUrl = pending.authorizationUrl;
      const storageUrl = storage.createAuthorizationUrl({
        state: "s".repeat(43),
        codeChallenge: "c".repeat(43),
      });

      expect(oidc.discovery).toHaveBeenLastCalledWith(
        config.oidc.issuerUrl,
        config.googleOAuthClient.clientId,
        config.googleOAuthClient.clientSecret,
      );
      for (const url of [loginUrl, storageUrl]) {
        expect(url.searchParams.get("client_id")).toBe(
          config.googleOAuthClient.clientId,
        );
        expect(url.searchParams.has("client_secret")).toBe(false);
        expect(url.searchParams.get("code_challenge_method")).toBe("S256");
      }
      expect(loginUrl.searchParams.get("redirect_uri")).toBe(
        `${apiUrl}/auth/callback`,
      );
      expect(storageUrl.searchParams.get("redirect_uri")).toBe(
        `${apiUrl}/google/storage/callback`,
      );
      expect(loginUrl.searchParams.get("scope")?.split(" ")).toEqual([
        "openid",
        "email",
        "profile",
        "https://www.googleapis.com/auth/drive.file",
        "https://www.googleapis.com/auth/drive.appdata",
      ]);
      expect(loginUrl.searchParams.get("access_type")).toBe("offline");
      expect(loginUrl.searchParams.get("include_granted_scopes")).toBe("true");
      expect(loginUrl.searchParams.get("prompt")).toBe(
        "select_account consent",
      );
      expect(loginUrl.searchParams.get("nonce")).toBe(pending.nonce);
      expect(loginUrl.searchParams.get("code_challenge")).toBe(
        await oidc.calculatePKCECodeChallenge(pending.codeVerifier),
      );
      expect(storageUrl.searchParams.get("scope")?.split(" ")).toEqual([
        "https://www.googleapis.com/auth/drive.file",
        "https://www.googleapis.com/auth/drive.appdata",
      ]);
      expect(storageUrl.searchParams.get("access_type")).toBe("offline");
      expect(storageUrl.searchParams.get("include_granted_scopes")).toBe(
        "true",
      );
      expect(loginUrl.searchParams.get("state")).not.toBe(
        storageUrl.searchParams.get("state"),
      );
    },
  );
});
