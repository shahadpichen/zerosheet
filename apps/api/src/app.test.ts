import type { AuthenticatedUser } from "@zerosheet/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { AuthenticationFlowError } from "./auth/auth-service.js";
import type { AuthApplicationService } from "./auth/types.js";
import { buildApp } from "./app.js";
import type { RuntimeConfig } from "./config.js";

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

  public beginLogin() {
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

function makeApp(service = new FakeAuthService()) {
  return {
    app: buildApp({
      authService: service,
      config: testConfig(),
      logger: false,
    }),
    service,
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
    const { app } = makeApp();
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
});
