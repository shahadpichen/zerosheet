import { describe, expect, it, vi } from "vitest";
import type { GoogleStorageOAuthConfig } from "../config.js";
import { GoogleWebServerOAuthGateway } from "./google-oauth-gateway.js";

const config: Extract<GoogleStorageOAuthConfig, { enabled: true }> = {
  enabled: true,
  callbackUrl: new URL("http://127.0.0.1:3001/google/storage/callback"),
  transactionSeconds: 600,
  clientId: "google-storage-client.apps.googleusercontent.com",
  clientSecret: "server-only-client-secret",
  tokenEncryptionKey: new Uint8Array(32).fill(17),
};

/**
 * OAuth gateway tests use an injected fetch function so no credential or test
 * request can leave the process. They verify the fixed provider endpoints and
 * exact protocol parameters at the narrowest outbound trust boundary.
 */
describe("GoogleWebServerOAuthGateway", () => {
  it("creates an offline PKCE grant containing only storage scopes", () => {
    const gateway = new GoogleWebServerOAuthGateway(config);
    const state = "s".repeat(43);
    const challenge = "c".repeat(43);

    const url = gateway.createAuthorizationUrl({
      state,
      codeChallenge: challenge,
    });

    expect(url.origin).toBe("https://accounts.google.com");
    expect(url.pathname).toBe("/o/oauth2/v2/auth");
    expect(url.searchParams.get("client_id")).toBe(config.clientId);
    expect(url.searchParams.get("redirect_uri")).toBe(config.callbackUrl.href);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("code_challenge")).toBe(challenge);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("scope")?.split(" ").sort()).toEqual([
      "https://www.googleapis.com/auth/drive.appdata",
      "https://www.googleapis.com/auth/drive.file",
    ]);
    expect(url.searchParams.has("openid")).toBe(false);
  });

  it("exchanges the code only at Google's fixed token endpoint", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: "short-lived-access-token",
          expires_in: 3_600,
          token_type: "Bearer",
          refresh_token: "durable-refresh-token",
          scope:
            "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.appdata",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const gateway = new GoogleWebServerOAuthGateway(config, {
      fetch: fetchMock,
    });

    await expect(
      gateway.exchangeAuthorizationCode({
        code: "provider-code",
        codeVerifier: "v".repeat(43),
      }),
    ).resolves.toEqual({
      accessToken: "short-lived-access-token",
      expiresInSeconds: 3_600,
      refreshToken: "durable-refresh-token",
      grantedScopes: [
        "https://www.googleapis.com/auth/drive.appdata",
        "https://www.googleapis.com/auth/drive.file",
      ],
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [endpoint, request] = fetchMock.mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(endpoint).toBe("https://oauth2.googleapis.com/token");
    expect(request.method).toBe("POST");
    const body = request.body as URLSearchParams;
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code_verifier")).toBe("v".repeat(43));
    expect(body.get("client_secret")).toBe(config.clientSecret);
  });

  it("maps provider errors and malformed token documents to one safe category", async () => {
    const providerErrorFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("provider diagnostics", { status: 400 }));
    const malformedFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('{"access_token":7}', { status: 200 }));

    await expect(
      new GoogleWebServerOAuthGateway(config, {
        fetch: providerErrorFetch,
      }).refreshAccessToken("refresh-token"),
    ).rejects.toMatchObject({ name: "GoogleStorageDependencyError" });
    await expect(
      new GoogleWebServerOAuthGateway(config, {
        fetch: malformedFetch,
      }).refreshAccessToken("refresh-token"),
    ).rejects.toMatchObject({ name: "GoogleStorageDependencyError" });
  });

  it("treats an omitted code-exchange scope as the unchanged requested scope", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        access_token: "short-lived-access-token",
        expires_in: 3_600,
        token_type: "Bearer",
        refresh_token: "durable-refresh-token",
      }),
    );
    const gateway = new GoogleWebServerOAuthGateway(config, {
      fetch: fetchMock,
    });

    await expect(
      gateway.exchangeAuthorizationCode({
        code: "provider-code",
        codeVerifier: "v".repeat(43),
      }),
    ).resolves.toMatchObject({
      grantedScopes: [
        "https://www.googleapis.com/auth/drive.file",
        "https://www.googleapis.com/auth/drive.appdata",
      ],
    });
  });

  it("revokes only at Google's fixed revocation endpoint", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 200 }));
    const gateway = new GoogleWebServerOAuthGateway(config, {
      fetch: fetchMock,
    });

    await gateway.revoke("durable-refresh-token");

    const [endpoint, request] = fetchMock.mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(endpoint).toBe("https://oauth2.googleapis.com/revoke");
    expect((request.body as URLSearchParams).get("token")).toBe(
      "durable-refresh-token",
    );
  });
});
