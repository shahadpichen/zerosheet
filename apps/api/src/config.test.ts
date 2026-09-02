import { describe, expect, it } from "vitest";
import { loadRuntimeConfig } from "./config.js";

/**
 * Tests use a complete, non-secret environment object so a developer can see
 * the minimum contract without depending on the machine running the suite.
 */
function validEnvironment(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "development",
    ZEROSHEET_API_URL: "http://127.0.0.1:3001",
    ZEROSHEET_WEB_URL: "http://127.0.0.1:5173",
    ZEROSHEET_OIDC_ISSUER_URL: "http://localhost:8080/realms/zerosheet",
    ZEROSHEET_DB_NAME: "zerosheet",
    ZEROSHEET_DB_USER: "zerosheet_app",
    ZEROSHEET_DB_PASSWORD: "test-only-password",
    KEYCLOAK_BFF_CLIENT_ID: "zerosheet-bff",
    KEYCLOAK_BFF_CLIENT_SECRET: "test-only-client-secret",
    OPENFGA_API_URL: "http://127.0.0.1:8082",
    OPENFGA_STORE_ID: "01H00000000000000000000000",
    OPENFGA_AUTHORIZATION_MODEL_ID: "01H00000000000000000000001",
    OPENFGA_PRESHARED_KEY: "test-only-openfga-key",
  };
}

describe("loadRuntimeConfig", () => {
  it("builds exact callback URLs and development cookie names", () => {
    const config = loadRuntimeConfig(validEnvironment());

    expect(config.oidc.callbackUrl.href).toBe(
      "http://127.0.0.1:3001/auth/callback",
    );
    expect(config.oidc.allowInsecureHttp).toBe(true);
    expect(config.authCookies).toEqual({
      secure: false,
      loginTransactionName: "zerosheet_oidc_transaction",
      sessionName: "zerosheet_session",
    });
    expect(config.authorization).toMatchObject({
      apiUrl: new URL("http://127.0.0.1:8082"),
      allowInsecureHttp: true,
      storeId: "01H00000000000000000000000",
      authorizationModelId: "01H00000000000000000000001",
    });
  });

  it("refuses insecure cookies in production", () => {
    expect(() =>
      loadRuntimeConfig({
        ...validEnvironment(),
        NODE_ENV: "production",
        ZEROSHEET_COOKIE_SECURE: "false",
      }),
    ).toThrow(/ZEROSHEET_COOKIE_SECURE/u);
  });

  it("refuses a non-loopback HTTP issuer even during development", () => {
    expect(() =>
      loadRuntimeConfig({
        ...validEnvironment(),
        ZEROSHEET_OIDC_ISSUER_URL: "http://identity.internal/realms/zerosheet",
      }),
    ).toThrow(/must use HTTPS/u);
  });

  it("refuses HTTP product URLs in production", () => {
    expect(() =>
      loadRuntimeConfig({
        ...validEnvironment(),
        NODE_ENV: "production",
        ZEROSHEET_COOKIE_SECURE: "true",
        ZEROSHEET_OIDC_ISSUER_URL:
          "https://identity.zerosheet.example/realms/zerosheet",
      }),
    ).toThrow(/must use HTTPS/u);
  });

  it("fails fast when the confidential client secret is missing", () => {
    const environment = validEnvironment();
    delete environment.KEYCLOAK_BFF_CLIENT_SECRET;

    expect(() => loadRuntimeConfig(environment)).toThrow(
      /KEYCLOAK_BFF_CLIENT_SECRET/u,
    );
  });

  it("refuses a non-loopback insecure authorization decision service", () => {
    expect(() =>
      loadRuntimeConfig({
        ...validEnvironment(),
        OPENFGA_API_URL: "http://authorization.internal:8080",
      }),
    ).toThrow(/OPENFGA_API_URL must use HTTPS/u);
  });

  it("requires a provisioned immutable authorization model ID", () => {
    expect(() =>
      loadRuntimeConfig({
        ...validEnvironment(),
        OPENFGA_AUTHORIZATION_MODEL_ID: "replace-me",
      }),
    ).toThrow(/infra:authorization:provision/u);
  });
});
