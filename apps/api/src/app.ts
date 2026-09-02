import { HealthResponseSchema } from "@zerosheet/contracts";
import cookie from "@fastify/cookie";
import Fastify, {
  type FastifyInstance,
  type FastifyServerOptions,
} from "fastify";
import type { RuntimeConfig } from "./config.js";
import { registerAuthRoutes } from "./auth/routes.js";
import type { AuthApplicationService } from "./auth/types.js";
import { registerAuthorizationRoutes } from "./authorization/routes.js";
import type { AuthorizationApplicationService } from "./authorization/types.js";

export interface BuildAppOptions {
  authService: AuthApplicationService;
  authorizationService: AuthorizationApplicationService;
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

  return app;
}
