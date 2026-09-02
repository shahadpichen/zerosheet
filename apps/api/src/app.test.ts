import type { AuthenticatedUser } from "@zerosheet/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { AuthenticationFlowError } from "./auth/auth-service.js";
import type {
  AuthApplicationService,
  IdentityProviderHint,
} from "./auth/types.js";
import { buildApp } from "./app.js";
import type { RuntimeConfig } from "./config.js";
import type { AuditApplicationService } from "./audit/types.js";
import type {
  AuthorizationApplicationService,
  CheckWorkbookPermissionInput,
} from "./authorization/types.js";
import type {
  LifecycleApplicationService,
  ScimConnection,
  ScimManagedUser,
} from "./lifecycle/types.js";
import { LifecycleUnauthorizedError } from "./lifecycle/errors.js";
import type {
  Organization,
  OrganizationMembership,
  ProductApplicationService,
  Team,
  TeamMembership,
  TeamRole,
  Workbook,
  WorkbookShare,
  WorkbookSharePrincipal,
  WorkbookShareRole,
} from "./product/types.js";
import {
  ProductDependencyError,
  ProductForbiddenError,
} from "./product/errors.js";

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

  public canCreateOrganization() {
    return Promise.resolve(this.allowed);
  }

  public canAccessWorkbook(input: CheckWorkbookPermissionInput) {
    this.input = input;

    if (this.fail) {
      return Promise.reject(new Error("decision service unavailable"));
    }

    return Promise.resolve(this.allowed);
  }

  public canAccessOrganization() {
    return Promise.resolve(this.allowed);
  }

  public canAccessTeam() {
    return Promise.resolve(this.allowed);
  }
}

class FakeProductService implements ProductApplicationService {
  public error: Error | undefined;
  public createdOrganizationName: string | undefined;
  public sharePrincipal: WorkbookSharePrincipal | undefined;
  public organization: Organization = {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    name: "Acme",
  };
  public team: Team = {
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    organizationId: this.organization.id,
    name: "Finance",
  };
  public workbook: Workbook = {
    id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    organizationId: this.organization.id,
    name: "Budget",
    createdBy: testUser.id,
  };

  public createOrganization(
    _actor: AuthenticatedUser,
    input: { name: string },
  ): Promise<Organization> {
    this.createdOrganizationName = input.name;
    if (this.error) return Promise.reject(this.error);
    return Promise.resolve(this.organization);
  }

  public createTeam(): Promise<Team> {
    return Promise.resolve(this.team);
  }

  public createWorkbook(): Promise<Workbook> {
    return Promise.resolve(this.workbook);
  }

  public getWorkbook(): Promise<Workbook> {
    return Promise.resolve(this.workbook);
  }

  public setOrganizationMember(
    _actor: AuthenticatedUser,
    organizationId: string,
    userId: string,
    role: "admin" | "member",
  ): Promise<OrganizationMembership> {
    return Promise.resolve({ organizationId, userId, role });
  }

  public removeOrganizationMember(): Promise<void> {
    return Promise.resolve();
  }

  public setTeamMember(
    _actor: AuthenticatedUser,
    teamId: string,
    userId: string,
    role: TeamRole,
  ): Promise<TeamMembership> {
    return Promise.resolve({ teamId, userId, role });
  }

  public removeTeamMember(): Promise<void> {
    return Promise.resolve();
  }

  public setWorkbookShare(
    _actor: AuthenticatedUser,
    workbookId: string,
    principal: WorkbookSharePrincipal,
    role: WorkbookShareRole,
  ): Promise<WorkbookShare> {
    this.sharePrincipal = principal;
    return Promise.resolve({ workbookId, principal, role });
  }

  public removeWorkbookShare(): Promise<void> {
    return Promise.resolve();
  }

  public reconcilePendingOperations(): Promise<number> {
    return Promise.resolve(0);
  }
}

class FakeLifecycleService implements LifecycleApplicationService {
  public authenticated = true;
  public createInput:
    | {
        externalId: string;
        userName: string;
        displayName: string;
        active: boolean;
      }
    | undefined;
  public replaceInput:
    | {
        externalId: string;
        userName: string;
        displayName: string;
        active: boolean;
      }
    | undefined;
  private readonly connection: ScimConnection = {
    id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    organizationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    displayName: "Test directory",
    active: true,
  };
  private readonly user: ScimManagedUser = {
    id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    connectionId: this.connection.id,
    organizationId: this.connection.organizationId,
    productUserId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
    externalId: "directory-user-1",
    userName: "directory@zerosheet.local",
    displayName: "Directory User",
    active: true,
    version: 1,
    createdAt: new Date("2026-09-03T00:00:00.000Z"),
    updatedAt: new Date("2026-09-03T00:00:00.000Z"),
  };

  public createConnection() {
    return Promise.resolve({
      ...this.connection,
      bearerToken: "zs_scim_test.token",
      tokenHint: "st.token",
    });
  }

  public authenticateConnection() {
    return this.authenticated
      ? Promise.resolve(this.connection)
      : Promise.reject(new LifecycleUnauthorizedError());
  }

  public createUser(
    _connection: ScimConnection,
    input: {
      externalId: string;
      userName: string;
      displayName: string;
      active: boolean;
    },
  ) {
    this.createInput = input;
    return Promise.resolve(this.user);
  }

  public replaceUser(
    _connection: ScimConnection,
    _id: string,
    input: {
      externalId: string;
      userName: string;
      displayName: string;
      active: boolean;
    },
  ) {
    this.replaceInput = input;
    return Promise.resolve(this.user);
  }

  public findUser() {
    return Promise.resolve(this.user);
  }

  public listUsers() {
    return Promise.resolve([this.user]);
  }

  public deactivateUser(): Promise<void> {
    return Promise.resolve();
  }
}

class FakeAuditService implements AuditApplicationService {
  public listOrganizationEvents() {
    return Promise.resolve([]);
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
    contextualAuthorization: {
      apiUrl: new URL("http://127.0.0.1:8181"),
      allowInsecureHttp: true,
      requestTimeoutMs: 5_000,
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
  productService = new FakeProductService(),
  lifecycleService = new FakeLifecycleService(),
  auditService = new FakeAuditService(),
) {
  return {
    app: buildApp({
      authService: service,
      authorizationService,
      productService,
      lifecycleService,
      auditService,
      config: testConfig(),
      logger: false,
    }),
    service,
    authorizationService,
    productService,
    lifecycleService,
    auditService,
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

  it("requires a product session before creating an organization", async () => {
    const { app, productService } = makeApp();
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/organizations",
      payload: { name: "Acme" },
    });

    expect(response.statusCode).toBe(401);
    expect(productService.createdOrganizationName).toBeUndefined();
  });

  it("validates and normalizes product input before creating state", async () => {
    const auth = new FakeAuthService();
    auth.user = testUser;
    const { app, productService } = makeApp(auth);
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/organizations",
      cookies: { zerosheet_session: "opaque-browser-session" },
      payload: { name: "  Acme  " },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual(productService.organization);
    expect(productService.createdOrganizationName).toBe("Acme");
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("rejects browser-supplied owner roles and tuple-like extra fields", async () => {
    const auth = new FakeAuthService();
    auth.user = testUser;
    const { app, productService } = makeApp(auth);
    apps.push(app);

    const response = await app.inject({
      method: "PUT",
      url: `/organizations/${productService.organization.id}/members/${testUser.id}`,
      cookies: { zerosheet_session: "opaque-browser-session" },
      payload: { role: "owner", relation: "owner" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "invalid_request" });
  });

  it("maps a product authorization denial to a generic 403", async () => {
    const auth = new FakeAuthService();
    auth.user = testUser;
    const product = new FakeProductService();
    product.error = new ProductForbiddenError();
    const { app } = makeApp(auth, new FakeAuthorizationService(), product);
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/organizations",
      cookies: { zerosheet_session: "opaque-browser-session" },
      payload: { name: "Acme" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      error: "forbidden",
      message: "You do not have permission to perform this action.",
    });
  });

  it("returns retryable 503 when relationship synchronization is unavailable", async () => {
    const auth = new FakeAuthService();
    auth.user = testUser;
    const product = new FakeProductService();
    product.error = new ProductDependencyError();
    const { app } = makeApp(auth, new FakeAuthorizationService(), product);
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/organizations",
      cookies: { zerosheet_session: "opaque-browser-session" },
      payload: { name: "Acme" },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      error: "authorization_unavailable",
    });
  });

  it("maps the fixed team-share route to a team principal", async () => {
    const auth = new FakeAuthService();
    auth.user = testUser;
    const { app, productService } = makeApp(auth);
    apps.push(app);

    const response = await app.inject({
      method: "PUT",
      url: `/workbooks/${productService.workbook.id}/shares/teams/${productService.team.id}`,
      cookies: { zerosheet_session: "opaque-browser-session" },
      payload: { role: "editor" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      principal: { type: "team", id: productService.team.id },
      role: "editor",
    });
    expect(productService.sharePrincipal).toEqual({
      type: "team",
      id: productService.team.id,
    });
  });
});

describe("ZeroSheet SCIM lifecycle boundary", () => {
  it("publishes honest discovery metadata without claiming Group support", async () => {
    const { app } = makeApp();
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/scim/v2/ResourceTypes",
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/scim+json");
    const resourceTypes = response.json<{
      Resources: Array<{ endpoint: string }>;
    }>();
    expect(resourceTypes.Resources).toHaveLength(1);
    expect(resourceTypes.Resources[0]?.endpoint).toBe("/Users");

    /**
     * ResourceTypes points clients at the schema URN, so the matching schema
     * discovery endpoint must describe only attributes the service accepts.
     */
    const schemas = await app.inject({
      method: "GET",
      url: "/scim/v2/Schemas",
    });
    expect(schemas.statusCode).toBe(200);
    const schemaList = schemas.json<{ Resources: Array<{ id: string }> }>();
    expect(schemaList.Resources).toHaveLength(1);
    expect(schemaList.Resources[0]?.id).toBe(
      "urn:ietf:params:scim:schemas:core:2.0:User",
    );
  });

  it("requires a tenant provisioning bearer credential for SCIM Users", async () => {
    const lifecycle = new FakeLifecycleService();
    lifecycle.authenticated = false;
    const { app } = makeApp(
      new FakeAuthService(),
      new FakeAuthorizationService(),
      new FakeProductService(),
      lifecycle,
    );
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/scim/v2/Users",
    });

    expect(response.statusCode).toBe(401);
    expect(response.headers["www-authenticate"]).toContain("Bearer");
    expect(response.json()).toMatchObject({
      schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
      status: "401",
    });
  });

  it("normalizes a valid SCIM User and returns an ETag and location", async () => {
    const lifecycle = new FakeLifecycleService();
    const { app } = makeApp(
      new FakeAuthService(),
      new FakeAuthorizationService(),
      new FakeProductService(),
      lifecycle,
    );
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/scim/v2/Users",
      headers: {
        authorization: "Bearer zs_scim_test.token",
        "content-type": "application/scim+json",
      },
      payload: {
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
        externalId: "directory-user-1",
        userName: "directory@zerosheet.local",
        displayName: "Directory User",
        active: true,
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.headers.etag).toBe('W/"1"');
    expect(response.headers.location).toContain("/scim/v2/Users/");
    expect(lifecycle.createInput).toMatchObject({
      externalId: "directory-user-1",
      active: true,
    });
  });

  it("rejects unimplemented filters with the SCIM invalidFilter category", async () => {
    const { app } = makeApp();
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: '/scim/v2/Users?filter=department%20eq%20"Finance"',
      headers: { authorization: "Bearer zs_scim_test.token" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ scimType: string }>().scimType).toBe(
      "invalidFilter",
    );
  });

  it("rejects unknown path-less PATCH attributes instead of silently ignoring them", async () => {
    const lifecycle = new FakeLifecycleService();
    const { app } = makeApp(
      new FakeAuthService(),
      new FakeAuthorizationService(),
      new FakeProductService(),
      lifecycle,
    );
    apps.push(app);

    const response = await app.inject({
      method: "PATCH",
      url: "/scim/v2/Users/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      headers: { authorization: "Bearer zs_scim_test.token" },
      payload: {
        schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
        Operations: [
          {
            op: "replace",
            value: { department: "Finance" },
          },
        ],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ scimType: string }>().scimType).toBe("invalidValue");
    expect(lifecycle.replaceInput).toBeUndefined();
  });
});
