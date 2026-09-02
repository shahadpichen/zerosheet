import {
  AuthenticationErrorResponseSchema,
  AuthSessionResponseSchema,
} from "@zerosheet/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AuthCookieConfig, AuthLifetimeConfig } from "../config.js";
import { AuthenticationFlowError } from "./auth-service.js";
import type { AuthApplicationService } from "./types.js";

export interface AuthRouteOptions {
  service: AuthApplicationService;
  cookies: AuthCookieConfig;
  lifetimes: AuthLifetimeConfig;
  successfulLoginRedirectUrl: URL;
  callbackUrl: URL;
}

/**
 * OAuth callback parameters contain a short-lived authorization code and state.
 * Preventing caching and referrer forwarding keeps those values out of browser
 * caches and unrelated navigation. These headers apply to every auth route,
 * including redirects and error responses.
 */
function protectAuthenticationResponse(reply: FastifyReply): void {
  void reply
    .header("Cache-Control", "no-store")
    .header("Pragma", "no-cache")
    .header("Referrer-Policy", "no-referrer")
    .header("X-Content-Type-Options", "nosniff");
}

/**
 * We reconstruct the callback from the configured, registered redirect URI and
 * only copy the query string supplied by Keycloak. Trusting an arbitrary Host
 * or forwarded-host header here could make token validation use an attacker-
 * controlled callback URL when the service later runs behind a reverse proxy.
 */
function configuredCallbackUrl(request: FastifyRequest, callbackUrl: URL): URL {
  const incoming = new URL(
    request.raw.url ?? "/auth/callback",
    "http://internal",
  );
  const trusted = new URL(callbackUrl);
  trusted.search = incoming.search;
  return trusted;
}

export function registerAuthRoutes(
  app: FastifyInstance,
  options: AuthRouteOptions,
): void {
  app.addHook("onRequest", (_request, reply, done) => {
    protectAuthenticationResponse(reply);
    done();
  });

  app.get("/auth/login", async (_request, reply) => {
    const login = await options.service.beginLogin();

    reply.setCookie(
      options.cookies.loginTransactionName,
      login.transactionToken,
      {
        httpOnly: true,
        secure: options.cookies.secure,
        sameSite: "lax",
        path: "/",
        maxAge: options.lifetimes.loginTransactionSeconds,
      },
    );

    // A normal 302 is appropriate because both the incoming request and the
    // Keycloak authorization endpoint use GET.
    return reply.redirect(login.authorizationUrl.href, 302);
  });

  app.get("/auth/callback", async (request, reply) => {
    const transactionToken =
      request.cookies[options.cookies.loginTransactionName];

    /**
     * Clear the one-time cookie on every callback attempt. AuthService also
     * atomically consumes the database row, so both browser and server lose the
     * transaction regardless of success or failure.
     */
    reply.clearCookie(options.cookies.loginTransactionName, {
      httpOnly: true,
      secure: options.cookies.secure,
      sameSite: "lax",
      path: "/",
    });

    try {
      const login = await options.service.completeLogin(
        configuredCallbackUrl(request, options.callbackUrl),
        transactionToken,
      );

      reply.setCookie(options.cookies.sessionName, login.sessionToken, {
        httpOnly: true,
        secure: options.cookies.secure,
        sameSite: "lax",
        path: "/",
        maxAge: options.lifetimes.sessionSeconds,
      });

      return reply.redirect(options.successfulLoginRedirectUrl.href, 303);
    } catch (error) {
      if (error instanceof AuthenticationFlowError) {
        // Record only the safe event name. The callback URL and underlying
        // protocol exception may contain authorization credentials.
        request.log.warn("OIDC callback rejected");
        const response = AuthenticationErrorResponseSchema.parse({
          error: "authentication_failed",
          message: error.message,
        });

        return reply.code(400).send(response);
      }

      throw error;
    }
  });

  app.get("/auth/me", async (request, reply) => {
    const user = await options.service.currentUser(
      request.cookies[options.cookies.sessionName],
    );

    if (!user) {
      return reply.code(401).send(
        AuthSessionResponseSchema.parse({
          authenticated: false,
        }),
      );
    }

    return AuthSessionResponseSchema.parse({
      authenticated: true,
      user,
    });
  });

  app.post("/auth/logout", async (request, reply) => {
    await options.service.logout(request.cookies[options.cookies.sessionName]);

    reply.clearCookie(options.cookies.sessionName, {
      httpOnly: true,
      secure: options.cookies.secure,
      sameSite: "lax",
      path: "/",
    });

    /**
     * Local deletion ends the ZeroSheet session. Redirecting through Keycloak's
     * registered logout endpoint also ends the identity-provider SSO session,
     * so pressing Login again does not silently recreate a product session.
     */
    return reply.redirect(options.service.logoutUrl().href, 303);
  });
}
