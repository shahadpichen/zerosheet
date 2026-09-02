import { HealthResponseSchema } from "@zerosheet/contracts";
import cookie from "@fastify/cookie";
import Fastify, {
  type FastifyInstance,
  type FastifyServerOptions,
} from "fastify";
import type { RuntimeConfig } from "./config.js";
import { registerGoogleStorageRoutes } from "./google-storage/routes.js";
import type { GoogleStorageApplicationService } from "./google-storage/types.js";
import { registerAuditRoutes } from "./audit/routes.js";
import type { AuditApplicationService } from "./audit/types.js";
import { registerAuthRoutes } from "./auth/routes.js";
import type { AuthApplicationService } from "./auth/types.js";
import { registerAuthorizationRoutes } from "./authorization/routes.js";
import type { AuthorizationApplicationService } from "./authorization/types.js";
import { registerLifecycleRoutes } from "./lifecycle/routes.js";
import type { LifecycleApplicationService } from "./lifecycle/types.js";
import { registerProductRoutes } from "./product/routes.js";
import type { ProductApplicationService } from "./product/types.js";

export interface BuildAppOptions {
  authService: AuthApplicationService;
  authorizationService: AuthorizationApplicationService;
  productService: ProductApplicationService;
  lifecycleService: LifecycleApplicationService;
  auditService: AuditApplicationService;
  googleStorageService: GoogleStorageApplicationService;
  config: RuntimeConfig;
  logger?: boolean;
}

/**
 * `buildApp` assembles HTTP concerns only. Database pools and OIDC discovery are
 * created by the runtime composition root, which lets tests inject controlled
 * authentication behavior without weakening production validation.
 */
export function buildApp(options: BuildAppOptions): FastifyInstance {
  const serverOptions: FastifyServerOptions = {
    logger:
      options.logger === false
        ? false
        : {
            level: options.config.logLevel,
            serializers: {
              /**
               * Query strings are omitted because `/auth/callback` contains a
               * short-lived authorization code and state. Logging the path is
               * enough for operations without copying credentials into logs.
               */
              req(request) {
                return {
                  method: request.method,
                  url: request.url.split("?", 1)[0] ?? request.url,
                  hostname: request.hostname,
                  remoteAddress: request.ip,
                };
              },
            },
          },
  };
  const app: FastifyInstance = Fastify(serverOptions);

  /**
   * SCIM clients use `application/scim+json`, not generic application/json.
   * Reusing Fastify's hardened default JSON parser preserves its prototype-
   * poisoning checks and body-size enforcement while making the standards-
   * registered media type behave exactly like JSON at the route boundary.
   */
  app.addContentTypeParser(
    "application/scim+json",
    { parseAs: "string" },
    app.getDefaultJsonParser("ignore", "ignore"),
  );

  // Cookie parsing must run before authentication handlers read request.cookies.
  void app.register(cookie);

  app.get("/health", () => {
    return HealthResponseSchema.parse({
      service: "zerosheet-api",
      status: "ok",
    });
  });

  /**
   * The child plugin scopes authentication-only hooks such as `no-store` to
   * these routes. Future workbook endpoints can then choose their own caching
   * policy instead of accidentally inheriting OAuth callback protections.
   */
  void app.register((authScope, _pluginOptions, done) => {
    registerAuthRoutes(authScope, {
      service: options.authService,
      cookies: options.config.authCookies,
      lifetimes: options.config.authLifetimes,
      successfulLoginRedirectUrl: options.config.webUrl,
      callbackUrl: options.config.oidc.callbackUrl,
    });
    done();
  });

  /**
   * Protected product routes receive both the authenticated session boundary
   * and the authorization decision boundary. Registering them together makes
   * it difficult to accidentally expose a workbook route that checks neither.
   */
  void app.register((authorizationScope, _pluginOptions, done) => {
    registerAuthorizationRoutes(authorizationScope, {
      authentication: options.authService,
      authorization: options.authorizationService,
      cookies: options.config.authCookies,
    });
    done();
  });

  /**
   * Product lifecycle routes form a second PEP surface. The product service
   * coordinates metadata and relationship mutations, while this plugin keeps
   * session cookies and HTTP response policy at the transport boundary.
   */
  void app.register((productScope, _pluginOptions, done) => {
    registerProductRoutes(productScope, {
      authentication: options.authService,
      product: options.productService,
      cookies: options.config.authCookies,
    });
    done();
  });

  /**
   * Lifecycle routes contain two distinct authentication surfaces. Creating a
   * SCIM connection uses the human administrator's opaque session; `/scim/v2`
   * uses only the generated tenant-bound provisioning credential. Registering
   * both through one reviewed plugin makes that distinction explicit.
   */
  void app.register((lifecycleScope, _pluginOptions, done) => {
    registerLifecycleRoutes(lifecycleScope, {
      authentication: options.authService,
      lifecycle: options.lifecycleService,
      cookies: options.config.authCookies,
      scimBaseUrl: new URL("/scim/v2/", options.config.oidc.callbackUrl),
    });
    done();
  });

  void app.register((auditScope, _pluginOptions, done) => {
    registerAuditRoutes(auditScope, {
      authentication: options.authService,
      audit: options.auditService,
      cookies: options.config.authCookies,
    });
    done();
  });

  /**
   * Delegated Google storage is a separate OAuth surface from Keycloak sign-in.
   * Its plugin owns a different transaction cookie and never receives a
   * Keycloak token, recovery phrase, workbook key, or cell payload.
   */
  void app.register((googleStorageScope, _pluginOptions, done) => {
    registerGoogleStorageRoutes(googleStorageScope, {
      authentication: options.authService,
      storage: options.googleStorageService,
      cookies: options.config.authCookies,
      transactionSeconds: options.config.googleStorage.transactionSeconds,
      callbackUrl: options.config.googleStorage.callbackUrl,
      webUrl: options.config.webUrl,
    });
    done();
  });

  return app;
}
