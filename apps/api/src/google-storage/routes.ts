import {
  AuthSessionResponseSchema,
  GoogleStorageAccessTokenRequestSchema,
  GoogleStorageAccessTokenResponseSchema,
  GoogleStorageConnectionStatusSchema,
  GoogleStorageErrorResponseSchema,
} from "@zerosheet/contracts";
import type { AuthenticatedUser } from "@zerosheet/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AuthApplicationService } from "../auth/types.js";
import type { AuthCookieConfig } from "../config.js";
import {
  GoogleStorageConnectionRequiredError,
  GoogleStorageDependencyError,
  GoogleStorageNotConfiguredError,
  GoogleStorageOAuthFlowError,
} from "./errors.js";
import type { GoogleStorageApplicationService } from "./types.js";

export interface GoogleStorageRouteOptions {
  readonly authentication: AuthApplicationService;
  readonly storage: GoogleStorageApplicationService;
  readonly cookies: AuthCookieConfig;
  readonly transactionSeconds: number;
  readonly callbackUrl: URL;
  readonly webUrl: URL;
}

/**
 * Rebuild the callback from configuration and copy only Google's query string.
 * Reverse-proxy Host headers therefore cannot change the redirect URI used by
 * the OAuth code exchange.
 */
function configuredCallbackUrl(request: FastifyRequest, callbackUrl: URL): URL {
  const incoming = new URL(
    request.raw.url ?? "/google/storage/callback",
    "http://internal",
  );
  const trusted = new URL(callbackUrl);
  trusted.search = incoming.search;
  return trusted;
}

async function authenticatedUser(
  request: FastifyRequest,
  reply: FastifyReply,
  options: GoogleStorageRouteOptions,
): Promise<AuthenticatedUser | null> {
  const user = await options.authentication.currentUser(
    request.cookies[options.cookies.sessionName],
  );
  if (user) return user;

  await reply
    .code(401)
    .send(AuthSessionResponseSchema.parse({ authenticated: false }));
  return null;
}

/**
 * SameSite cookies are useful defense in depth, but state-changing POST routes
 * also require the exact configured web Origin. OAuth callback GETs are exempt
 * because navigation comes from Google's origin and is protected by state,
 * the one-use HttpOnly selector, PKCE, and the current product session.
 */
function hasTrustedOrigin(request: FastifyRequest, webUrl: URL): boolean {
  const origin = request.headers.origin;
  return typeof origin === "string" && origin === webUrl.origin;
}

function safeError(reply: FastifyReply, error: unknown): FastifyReply | null {
  if (error instanceof GoogleStorageNotConfiguredError) {
    return reply.code(503).send(
      GoogleStorageErrorResponseSchema.parse({
        error: "not_configured",
        message: error.message,
      }),
    );
  }
  if (error instanceof GoogleStorageConnectionRequiredError) {
    return reply.code(409).send(
      GoogleStorageErrorResponseSchema.parse({
        error: "connection_required",
        message: error.message,
      }),
    );
  }
  if (error instanceof GoogleStorageOAuthFlowError) {
    return reply.code(400).send(
      GoogleStorageErrorResponseSchema.parse({
        error: "oauth_failed",
        message: error.message,
      }),
    );
  }
  if (error instanceof GoogleStorageDependencyError) {
    return reply.code(503).send(
      GoogleStorageErrorResponseSchema.parse({
        error: "google_unavailable",
        message: error.message,
      }),
    );
  }
  return null;
}

export function registerGoogleStorageRoutes(
  app: FastifyInstance,
  options: GoogleStorageRouteOptions,
): void {
  app.addHook("onRequest", (_request, reply, done) => {
    // OAuth query parameters and access-token responses must not enter browser
    // caches, referrers, MIME sniffing, or shared intermediary storage.
    void reply
      .header("Cache-Control", "no-store")
      .header("Pragma", "no-cache")
      .header("Referrer-Policy", "no-referrer")
      .header("X-Content-Type-Options", "nosniff");
    done();
  });

  app.get("/google/storage/status", async (request, reply) => {
    const actor = await authenticatedUser(request, reply, options);
    if (!actor) return reply;
    return GoogleStorageConnectionStatusSchema.parse(
      await options.storage.status(actor.id),
    );
  });

  app.get("/google/storage/connect", async (request, reply) => {
    const actor = await authenticatedUser(request, reply, options);
    if (!actor) return reply;
    try {
      const started = await options.storage.beginConnection(actor.id);
      reply.setCookie(
        options.cookies.googleStorageTransactionName,
        started.transactionToken,
        {
          httpOnly: true,
          secure: options.cookies.secure,
          sameSite: "lax",
          path: "/",
          maxAge: options.transactionSeconds,
        },
      );
      return reply.redirect(started.authorizationUrl.href, 302);
    } catch (error) {
      const handled = safeError(reply, error);
      if (handled) return handled;
      throw error;
    }
  });

  app.get("/google/storage/callback", async (request, reply) => {
    const actor = await authenticatedUser(request, reply, options);
    const transactionToken =
      request.cookies[options.cookies.googleStorageTransactionName];

    reply.clearCookie(options.cookies.googleStorageTransactionName, {
      httpOnly: true,
      secure: options.cookies.secure,
      sameSite: "lax",
      path: "/",
    });
    if (!actor) return reply;

    try {
      await options.storage.completeConnection({
        userId: actor.id,
        callbackUrl: configuredCallbackUrl(request, options.callbackUrl),
        transactionToken,
      });
      return reply.redirect(options.webUrl.href, 303);
    } catch (error) {
      // Do not log the callback URL: it contains the authorization code and
      // state. The generic category is sufficient for operations and users.
      request.log.warn("Google storage OAuth callback rejected");
      const handled = safeError(reply, error);
      if (handled) return handled;
      throw error;
    }
  });

  app.post("/google/storage/access-token", async (request, reply) => {
    const actor = await authenticatedUser(request, reply, options);
    if (!actor) return reply;
    if (!hasTrustedOrigin(request, options.webUrl)) {
      return reply.code(403).send(
        GoogleStorageErrorResponseSchema.parse({
          error: "forbidden_origin",
          message: "The request origin is not allowed.",
        }),
      );
    }
    const body = GoogleStorageAccessTokenRequestSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send(
        GoogleStorageErrorResponseSchema.parse({
          error: "invalid_request",
          message: "The request body is invalid.",
        }),
      );
    }

    try {
      return GoogleStorageAccessTokenResponseSchema.parse(
        await options.storage.accessToken(actor.id, body.data.forceRefresh),
      );
    } catch (error) {
      const handled = safeError(reply, error);
      if (handled) return handled;
      throw error;
    }
  });

  app.post("/google/storage/disconnect", async (request, reply) => {
    const actor = await authenticatedUser(request, reply, options);
    if (!actor) return reply;
    if (!hasTrustedOrigin(request, options.webUrl)) {
      return reply.code(403).send(
        GoogleStorageErrorResponseSchema.parse({
          error: "forbidden_origin",
          message: "The request origin is not allowed.",
        }),
      );
    }

    try {
      await options.storage.disconnect(actor.id);
      return reply.code(204).send();
    } catch (error) {
      const handled = safeError(reply, error);
      if (handled) return handled;
      throw error;
    }
  });
}
