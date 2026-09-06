import { describe, expect, it } from "vitest";
import { loadRuntimeConfig } from "./config.js";

/**
 * Tests use a complete, non-secret environment object so a developer can see
 * the minimum contract without depending on the machine running the suite.
 */
function validEnvironment(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "development",
    ZEROSHEET_API_URL: "http://localhost:3001",
    ZEROSHEET_WEB_URL: "http://localhost:5173",
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
    OPA_API_URL: "http://127.0.0.1:8181",
  };
}

describe("loadRuntimeConfig", () => {
  it("builds exact callback URLs and development cookie names", () => {
    const config = loadRuntimeConfig(validEnvironment());

    expect(config.oidc.callbackUrl.href).toBe(
      "http://localhost:3001/auth/callback",
    );
    expect(config.oidc.allowInsecureHttp).toBe(true);
    expect(config.authCookies).toEqual({
      secure: false,
      loginTransactionName: "zerosheet_oidc_transaction",
      sessionName: "zerosheet_session",
      googleStorageTransactionName: "zerosheet_google_storage_transaction",
    });
    expect(config.googleStorage).toEqual({
      enabled: false,
      callbackUrl: new URL("http://localhost:3001/google/storage/callback"),
      transactionSeconds: 600,
    });
    expect(config.authorization).toMatchObject({
      apiUrl: new URL("http://127.0.0.1:8082"),
      allowInsecureHttp: true,
      storeId: "01H00000000000000000000000",
      authorizationModelId: "01H00000000000000000000001",
    });
    expect(config.contextualAuthorization).toEqual({
      apiUrl: new URL("http://127.0.0.1:8181"),
      allowInsecureHttp: true,
      requestTimeoutMs: 5_000,
    });
  });

  it("preserves an API reverse-proxy prefix in OAuth callback URLs", () => {
    const environment = {
      ...validEnvironment(),
      NODE_ENV: "production",
      ZEROSHEET_API_URL: "https://zerosheet.example/api",
      ZEROSHEET_WEB_URL: "https://zerosheet.example",
      ZEROSHEET_OIDC_ISSUER_URL:
        "https://identity.zerosheet.example/realms/zerosheet",
      OPENFGA_API_URL: "https://authorization.zerosheet.example",
      OPA_API_URL: "https://policy.zerosheet.example",
    };

    const config = loadRuntimeConfig(environment);
    expect(config.oidc.callbackUrl.href).toBe(
      "https://zerosheet.example/api/auth/callback",
    );
    expect(config.googleStorage.callbackUrl.href).toBe(
      "https://zerosheet.example/api/google/storage/callback",
    );
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

  it("loads sensitive values from absolute mounted files", () => {
    const environment = validEnvironment();
    delete environment.ZEROSHEET_DB_PASSWORD;
    delete environment.KEYCLOAK_BFF_CLIENT_SECRET;
    delete environment.OPENFGA_PRESHARED_KEY;
    environment.ZEROSHEET_DB_PASSWORD_FILE = "/run/secrets/database_password";
    environment.KEYCLOAK_BFF_CLIENT_SECRET_FILE =
      "/run/secrets/bff_client_secret";
    environment.OPENFGA_PRESHARED_KEY_FILE = "/run/secrets/openfga_key";

    const values = new Map([
      ["/run/secrets/database_password", "database-value\n"],
      ["/run/secrets/bff_client_secret", "client-value\n"],
      ["/run/secrets/openfga_key", "authorization-value\n"],
    ]);
    const config = loadRuntimeConfig(environment, (path) => {
      const value = values.get(path);
      if (value === undefined) throw new Error("missing test fixture");
      return value;
    });

    expect(config.database.password).toBe("database-value");
    expect(config.oidc.clientSecret).toBe("client-value");
    expect(config.authorization.apiToken).toBe("authorization-value");
  });

  it("rejects ambiguous, relative, and multiline secret sources", () => {
    expect(() =>
      loadRuntimeConfig({
        ...validEnvironment(),
        KEYCLOAK_BFF_CLIENT_SECRET_FILE: "/run/secrets/bff_client_secret",
      }),
    ).toThrow(/cannot both be set/u);

    const relative = validEnvironment();
    delete relative.KEYCLOAK_BFF_CLIENT_SECRET;
    relative.KEYCLOAK_BFF_CLIENT_SECRET_FILE = "secrets/bff_client_secret";
    expect(() => loadRuntimeConfig(relative, () => "value\n")).toThrow(
      /absolute path/u,
    );

    const multiline = validEnvironment();
    delete multiline.KEYCLOAK_BFF_CLIENT_SECRET;
    multiline.KEYCLOAK_BFF_CLIENT_SECRET_FILE =
      "/run/secrets/bff_client_secret";
    expect(() => loadRuntimeConfig(multiline, () => "first\nsecond\n")).toThrow(
      /one non-empty secret value/u,
    );
  });

  it("requires the browser and API to share a production origin", () => {
    expect(() =>
      loadRuntimeConfig({
        ...validEnvironment(),
        NODE_ENV: "production",
        ZEROSHEET_API_URL: "https://api.zerosheet.example",
        ZEROSHEET_WEB_URL: "https://zerosheet.example",
        ZEROSHEET_OIDC_ISSUER_URL:
          "https://identity.zerosheet.example/realms/zerosheet",
        OPENFGA_API_URL: "https://authorization.zerosheet.example",
        OPA_API_URL: "https://policy.zerosheet.example",
      }),
    ).toThrow(/same origin/u);
  });

  it("allows only loopback HTTP for co-located production policy engines", () => {
    const config = loadRuntimeConfig({
      ...validEnvironment(),
      NODE_ENV: "production",
      ZEROSHEET_API_URL: "https://zerosheet.example/api",
      ZEROSHEET_WEB_URL: "https://zerosheet.example",
      ZEROSHEET_OIDC_ISSUER_URL:
        "https://identity.zerosheet.example/realms/zerosheet",
      OPENFGA_API_URL: "http://127.0.0.1:8080",
      OPA_API_URL: "http://127.0.0.1:8181",
    });

    expect(config.authorization.allowInsecureHttp).toBe(true);
    expect(config.contextualAuthorization.allowInsecureHttp).toBe(true);
  });

  it("refuses a non-loopback insecure authorization decision service", () => {
    expect(() =>
      loadRuntimeConfig({
        ...validEnvironment(),
        OPENFGA_API_URL: "http://authorization.internal:8080",
      }),
    ).toThrow(/OPENFGA_API_URL must use HTTPS/u);
  });

  it("refuses a non-loopback insecure contextual policy service", () => {
    expect(() =>
      loadRuntimeConfig({
        ...validEnvironment(),
        OPA_API_URL: "http://policy.internal:8181",
      }),
    ).toThrow(/OPA_API_URL must use HTTPS/u);
  });

  it("requires a provisioned immutable authorization model ID", () => {
    expect(() =>
      loadRuntimeConfig({
        ...validEnvironment(),
        OPENFGA_AUTHORIZATION_MODEL_ID: "replace-me",
      }),
    ).toThrow(/infra:authorization:provision/u);
  });

  it("requires independent storage OAuth secrets only when enabled", () => {
    expect(() =>
      loadRuntimeConfig({
        ...validEnvironment(),
        GOOGLE_STORAGE_OAUTH_ENABLED: "true",
      }),
    ).toThrow(/GOOGLE_STORAGE_OAUTH_CLIENT_ID/u);

    const config = loadRuntimeConfig({
      ...validEnvironment(),
      GOOGLE_STORAGE_OAUTH_ENABLED: "true",
      GOOGLE_STORAGE_OAUTH_CLIENT_ID:
        "storage-client.apps.googleusercontent.com",
      GOOGLE_STORAGE_OAUTH_CLIENT_SECRET: "test-only-google-secret",
      GOOGLE_STORAGE_TOKEN_ENCRYPTION_KEY:
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    });
    expect(config.googleStorage).toMatchObject({
      enabled: true,
      clientId: "storage-client.apps.googleusercontent.com",
    });
    expect(
      config.googleStorage.enabled
        ? config.googleStorage.tokenEncryptionKey.byteLength
        : 0,
    ).toBe(32);
  });

  it("loads the Google OAuth secrets and token key from mounted files", () => {
    const environment = {
      ...validEnvironment(),
      GOOGLE_STORAGE_OAUTH_ENABLED: "true",
      GOOGLE_STORAGE_OAUTH_CLIENT_ID:
        "storage-client.apps.googleusercontent.com",
      GOOGLE_STORAGE_OAUTH_CLIENT_SECRET_FILE:
        "/run/secrets/google_storage_client_secret",
      GOOGLE_STORAGE_TOKEN_ENCRYPTION_KEY_FILE:
        "/run/secrets/google_storage_token_key",
    };
    const config = loadRuntimeConfig(environment, (path) =>
      path.endsWith("client_secret")
        ? "google-secret\n"
        : "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n",
    );

    expect(config.googleStorage).toMatchObject({
      enabled: true,
      clientSecret: "google-secret",
    });
  });

  it("rejects a malformed Google refresh-token encryption key", () => {
    expect(() =>
      loadRuntimeConfig({
        ...validEnvironment(),
        GOOGLE_STORAGE_OAUTH_ENABLED: "true",
        GOOGLE_STORAGE_OAUTH_CLIENT_ID:
          "storage-client.apps.googleusercontent.com",
        GOOGLE_STORAGE_OAUTH_CLIENT_SECRET: "test-only-google-secret",
        GOOGLE_STORAGE_TOKEN_ENCRYPTION_KEY: "too-short",
      }),
    ).toThrow(/exactly 32 bytes/u);
  });
});
