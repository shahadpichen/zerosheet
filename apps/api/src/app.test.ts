import type { AuthenticatedUser } from "@zerosheet/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { AuthenticationFlowError } from "./auth/auth-service.js";
import type {
  AuthApplicationService,
  IdentityProviderHint,
} from "./auth/types.js";
import { buildApp } from "./app.js";
import type { RuntimeConfig } from "./config.js";
import type {
  AuthorizationApplicationService,
  CheckWorkbookPermissionInput,
} from "./authorization/types.js";

const testUser: AuthenticatedUser = {
  id: "d19b70b8-d531-43ac-a734-12270ca484d3",
  email: "learner@zerosheet.local",
  displayName: "ZeroSheet Learner",
};

/**
 * HTTP tests replace Keycloak and PostgreSQL with this deterministic boundary.
 * The AuthService suite tests state transitions separately; these cases focus
 * on redirects, status codes, cookie flags, and public response bodies.
 */
class FakeAuthService implements AuthApplicationService {
  public user: AuthenticatedUser | null = null;
  public failCallback = false;
  public callbackTransactionToken: string | undefined;
  public loggedOutToken: string | undefined;
  public identityProviderHint: IdentityProviderHint | undefined;

  public beginLogin(identityProviderHint?: IdentityProviderHint) {
    this.identityProviderHint = identityProviderHint;

    return Promise.resolve({
      authorizationUrl: new URL(
        "http://localhost:8080/realms/zerosheet/protocol/openid-connect/auth?state=provider-state",
      ),
      transactionToken: "browser-transaction-token",
    });
  }

  public completeLogin(
    _callbackUrl: URL,
    transactionToken: string | undefined,
  ) {
    this.callbackTransactionToken = transactionToken;

    if (this.failCallback) {
      return Promise.reject(new AuthenticationFlowError());
    }

    return Promise.resolve({
      sessionToken: "opaque-browser-session",
      user: testUser,
    });
  }

  public currentUser(): Promise<AuthenticatedUser | null> {
    return Promise.resolve(this.user);
  }

  public logout(sessionToken: string | undefined): Promise<void> {
    this.loggedOutToken = sessionToken;
    return Promise.resolve();
  }

  public logoutUrl(): URL {
    return new URL(
      "http://localhost:8080/realms/zerosheet/protocol/openid-connect/logout?client_id=zerosheet-bff",
    );
  }
}

class FakeAuthorizationService implements AuthorizationApplicationService {
  public allowed = false;
  public fail = false;
  public input: CheckWorkbookPermissionInput | undefined;

  public canAccessWorkbook(input: CheckWorkbookPermissionInput) {
    this.input = input;

    if (this.fail) {
      return Promise.reject(new Error("decision service unavailable"));
    }

    return Promise.resolve(this.allowed);
  }
}

function testConfig(): RuntimeConfig {
  return {
    host: "127.0.0.1",
    port: 3001,
    logLevel: "silent",
    webUrl: new URL("http://127.0.0.1:5173"),
    database: {
      host: "127.0.0.1",
      port: 5434,
      database: "zerosheet",
      user: "zerosheet_app",
      password: "test-only-password",
      useTls: false,
    },
    oidc: {
      issuerUrl: new URL("http://localhost:8080/realms/zerosheet"),
      allowInsecureHttp: true,
      clientId: "zerosheet-bff",
      clientSecret: "test-only-secret",
      callbackUrl: new URL("http://127.0.0.1:3001/auth/callback"),
      postLogoutRedirectUrl: new URL("http://127.0.0.1:5173/"),
    },
    authorization: {
      apiUrl: new URL("http://127.0.0.1:8082"),
      allowInsecureHttp: true,
      storeId: "01H00000000000000000000000",
      authorizationModelId: "01H00000000000000000000001",
      apiToken: "test-only-openfga-key",
    },
    authLifetimes: {
      loginTransactionSeconds: 600,
      sessionSeconds: 28_800,
    },
    authCookies: {
      secure: false,
      loginTransactionName: "zerosheet_oidc_transaction",
      sessionName: "zerosheet_session",
    },
  };
}

function makeApp(
  service = new FakeAuthService(),
  authorizationService = new FakeAuthorizationService(),
) {
  return {
    app: buildApp({
      authService: service,
      authorizationService,
      config: testConfig(),
      logger: false,
    }),
    service,
    authorizationService,
  };
}

const apps: ReturnType<typeof buildApp>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("ZeroSheet HTTP authentication boundary", () => {
  it("keeps the process health endpoint unauthenticated", async () => {
    const { app } = makeApp();
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      service: "zerosheet-api",
      status: "ok",
    });
  });

  it("starts login with a protected, short-lived transaction cookie", async () => {
    const { app, service } = makeApp();
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/auth/login" });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toContain(
      "/protocol/openid-connect/auth",
    );
    expect(response.headers["set-cookie"]).toContain(
      "zerosheet_oidc_transaction=browser-transaction-token",
    );
    expect(response.headers["set-cookie"]).toContain("HttpOnly");
    expect(response.headers["set-cookie"]).toContain("SameSite=Lax");
    expect(response.headers["set-cookie"]).toContain("Max-Age=600");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(service.identityProviderHint).toBeUndefined();
  });

  it("starts the same protected flow with the fixed Google broker hint", async () => {
    const { app, service } = makeApp();
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/auth/login/google",
    });

    expect(response.statusCode).toBe(302);
    expect(service.identityProviderHint).toBe("google");
    expect(response.headers["set-cookie"]).toContain(
      "zerosheet_oidc_transaction=browser-transaction-token",
    );
  });

  it("replaces a consumed login transaction with an opaque session", async () => {
    const { app, service } = makeApp();
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/auth/callback?code=temporary-code&state=provider-state",
      cookies: {
        zerosheet_oidc_transaction: "browser-transaction-token",
      },
    });

    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe("http://127.0.0.1:5173/");
    expect(response.headers["set-cookie"]).toEqual(
      expect.arrayContaining([
        expect.stringContaining("zerosheet_oidc_transaction=;"),
        expect.stringContaining("zerosheet_session=opaque-browser-session"),
      ]),
    );
    expect(service.callbackTransactionToken).toBe("browser-transaction-token");
  });

  it("returns one generic error when callback validation fails", async () => {
    const service = new FakeAuthService();
    service.failCallback = true;
    const { app } = makeApp(service);
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/auth/callback?code=bad-code&state=bad-state",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: "authentication_failed",
      message: "The login could not be completed. Please start again.",
    });
  });

  it("returns 401 without a valid product session", async () => {
    const { app } = makeApp();
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/auth/me" });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ authenticated: false });
  });

  it("returns the narrow product user for a valid session", async () => {
    const service = new FakeAuthService();
    service.user = testUser;
    const { app } = makeApp(service);
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/auth/me",
      cookies: { zerosheet_session: "opaque-browser-session" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ authenticated: true, user: testUser });
  });

  it("deletes the local session before redirecting through Keycloak logout", async () => {
    const { app, service } = makeApp();
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/auth/logout",
      cookies: { zerosheet_session: "opaque-browser-session" },
    });

    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toContain("/openid-connect/logout");
    expect(response.headers["set-cookie"]).toContain("zerosheet_session=;");
    expect(service.loggedOutToken).toBe("opaque-browser-session");
  });

  it("requires authentication before asking for a workbook decision", async () => {
    const authorizationService = new FakeAuthorizationService();
    const { app } = makeApp(new FakeAuthService(), authorizationService);
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/workbooks/3d9a575e-aed9-4634-b9ea-3f00334df680/access",
    });

    expect(response.statusCode).toBe(401);
    expect(authorizationService.input).toBeUndefined();
  });

  it("returns workbook access only after an explicit relationship allow", async () => {
    const service = new FakeAuthService();
    service.user = testUser;
    const authorizationService = new FakeAuthorizationService();
    authorizationService.allowed = true;
    const { app } = makeApp(service, authorizationService);
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/workbooks/3d9a575e-aed9-4634-b9ea-3f00334df680/access",
      cookies: { zerosheet_session: "opaque-browser-session" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      workbookId: "3d9a575e-aed9-4634-b9ea-3f00334df680",
      permission: "can_view",
      allowed: true,
    });
    expect(authorizationService.input).toEqual({
      userId: testUser.id,
      workbookId: "3d9a575e-aed9-4634-b9ea-3f00334df680",
      permission: "can_view",
    });
  });

  it("returns 403 without disclosing the missing relationship", async () => {
    const service = new FakeAuthService();
    service.user = testUser;
    const { app } = makeApp(service, new FakeAuthorizationService());
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/workbooks/3d9a575e-aed9-4634-b9ea-3f00334df680/access",
      cookies: { zerosheet_session: "opaque-browser-session" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      error: "forbidden",
      message: "You do not have permission to access this workbook.",
    });
  });

  it("fails closed when the authorization decision service is unavailable", async () => {
    const service = new FakeAuthService();
    service.user = testUser;
    const authorizationService = new FakeAuthorizationService();
    authorizationService.fail = true;
    const { app } = makeApp(service, authorizationService);
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/workbooks/3d9a575e-aed9-4634-b9ea-3f00334df680/access",
      cookies: { zerosheet_session: "opaque-browser-session" },
    });

    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain('"allowed":true');
  });
});
