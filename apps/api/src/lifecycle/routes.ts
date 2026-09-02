import type { AuthenticatedUser } from "@zerosheet/contracts";
import { AuthSessionResponseSchema } from "@zerosheet/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AuthApplicationService } from "../auth/types.js";
import type { AuthCookieConfig } from "../config.js";
import { ProductDependencyError } from "../product/errors.js";
import {
  LifecycleConflictError,
  LifecycleForbiddenError,
  LifecycleNotFoundError,
  LifecycleUnauthorizedError,
} from "./errors.js";
import type {
  LifecycleApplicationService,
  ScimConnection,
  ScimManagedUser,
  ScimUserFilter,
} from "./types.js";

const USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";
const LIST_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
const PATCH_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
const ERROR_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:Error";
const SCHEMA_RESOURCE = "urn:ietf:params:scim:schemas:core:2.0:Schema";

const ScimConnectionInputSchema = z
  .object({ displayName: z.string().trim().min(1).max(200) })
  .strict();
const OrganizationParametersSchema = z.object({
  organizationId: z.string().uuid(),
});
const ScimUserParametersSchema = z.object({ id: z.string().uuid() });
const ScimUserInputSchema = z
  .object({
    schemas: z.array(z.string()).refine((value) => value.includes(USER_SCHEMA)),
    externalId: z.string().min(1).max(512),
    userName: z.string().email().max(320),
    displayName: z.string().trim().min(1).max(200).optional(),
    name: z
      .object({ formatted: z.string().trim().min(1).max(200) })
      .partial()
      .optional(),
    active: z.boolean().default(true),
  })
  .strict();
const ScimPatchSchema = z
  .object({
    schemas: z
      .array(z.string())
      .refine((value) => value.includes(PATCH_SCHEMA)),
    Operations: z
      .array(
        z
          .object({
            op: z.string(),
            path: z.string().optional(),
            value: z.unknown(),
          })
          .strict(),
      )
      .min(1)
      .max(20),
  })
  .strict();

export interface LifecycleRouteOptions {
  authentication: AuthApplicationService;
  lifecycle: LifecycleApplicationService;
  cookies: AuthCookieConfig;
  scimBaseUrl: URL;
}

function protectLifecycleResponse(reply: FastifyReply): void {
  void reply
    .header("Cache-Control", "no-store")
    .header("X-Content-Type-Options", "nosniff");
}

async function authenticatedUser(
  request: FastifyRequest,
  reply: FastifyReply,
  options: LifecycleRouteOptions,
): Promise<AuthenticatedUser | null> {
  const actor = await options.authentication.currentUser(
    request.cookies[options.cookies.sessionName],
  );
  if (!actor) {
    await reply
      .code(401)
      .send(AuthSessionResponseSchema.parse({ authenticated: false }));
  }
  return actor;
}

function bearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer ([A-Za-z0-9._~-]+)$/u.exec(header);
  return match?.[1];
}

function scimError(
  reply: FastifyReply,
  status: number,
  detail: string,
  scimType?: string,
): FastifyReply {
  void reply.type("application/scim+json");
  return reply.code(status).send({
    schemas: [ERROR_SCHEMA],
    status: String(status),
    ...(scimType ? { scimType } : {}),
    detail,
  });
}

async function connectionFor(
  request: FastifyRequest,
  reply: FastifyReply,
  options: LifecycleRouteOptions,
): Promise<ScimConnection | null> {
  try {
    return await options.lifecycle.authenticateConnection(
      bearerToken(request.headers.authorization),
    );
  } catch (error) {
    if (error instanceof LifecycleUnauthorizedError) {
      void reply.header("WWW-Authenticate", 'Bearer realm="ZeroSheet SCIM"');
      scimError(reply, 401, error.message);
      return null;
    }
    throw error;
  }
}

function userResponse(
  user: ScimManagedUser,
  baseUrl: URL,
): Record<string, unknown> {
  const location = new URL(`Users/${user.id}`, baseUrl).href;
  return {
    schemas: [USER_SCHEMA],
    id: user.id,
    externalId: user.externalId,
    userName: user.userName,
    displayName: user.displayName,
    active: user.active,
    meta: {
      resourceType: "User",
      created: user.createdAt.toISOString(),
      lastModified: user.updatedAt.toISOString(),
      version: `W/"${user.version}"`,
      location,
    },
  };
}

function sendUser(
  reply: FastifyReply,
  user: ScimManagedUser,
  baseUrl: URL,
  status = 200,
): FastifyReply {
  protectLifecycleResponse(reply);
  void reply
    .type("application/scim+json")
    .header("ETag", `W/"${user.version}"`)
    .header("Location", new URL(`Users/${user.id}`, baseUrl).href);
  return reply.code(status).send(userResponse(user, baseUrl));
}

function parseFilter(raw: unknown): ScimUserFilter | undefined | null {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || raw.length > 1_024) return null;
  const match = /^(externalId|userName) eq "([^"\\]{1,512})"$/u.exec(raw);
  return match
    ? {
        attribute: match[1] as ScimUserFilter["attribute"],
        value: match[2] ?? "",
      }
    : null;
}

function replaceInput(body: z.infer<typeof ScimUserInputSchema>) {
  return {
    externalId: body.externalId,
    userName: body.userName,
    displayName: body.displayName ?? body.name?.formatted ?? body.userName,
    active: body.active,
  };
}

function applyPatch(
  existing: ScimManagedUser,
  body: z.infer<typeof ScimPatchSchema>,
): {
  externalId: string;
  userName: string;
  displayName: string;
  active: boolean;
} | null {
  const next = {
    externalId: existing.externalId,
    userName: existing.userName,
    displayName: existing.displayName,
    active: existing.active,
  };

  for (const operation of body.Operations) {
    if (operation.op.toLowerCase() !== "replace") return null;

    if (
      !operation.path &&
      operation.value &&
      typeof operation.value === "object"
    ) {
      const value = operation.value as Record<string, unknown>;
      /**
       * SCIM permits a path-less replace whose value is an attribute object.
       * Silently discarding an unknown attribute would tell the directory that
       * provisioning succeeded when ZeroSheet did not apply the requested
       * state. Reject unknown or empty objects so the client can correct them.
       */
      const supportedKeys = new Set([
        "active",
        "userName",
        "displayName",
        "externalId",
      ]);
      const keys = Object.keys(value);
      if (
        keys.length === 0 ||
        keys.some((key) => !supportedKeys.has(key)) ||
        ("active" in value && typeof value.active !== "boolean") ||
        ("userName" in value && typeof value.userName !== "string") ||
        ("displayName" in value && typeof value.displayName !== "string") ||
        ("externalId" in value && typeof value.externalId !== "string")
      ) {
        return null;
      }
      if (typeof value.active === "boolean") next.active = value.active;
      if (typeof value.userName === "string") next.userName = value.userName;
      if (typeof value.displayName === "string") {
        next.displayName = value.displayName;
      }
      if (typeof value.externalId === "string") {
        next.externalId = value.externalId;
      }
      continue;
    }

    switch (operation.path?.toLowerCase()) {
      case "active":
        if (typeof operation.value !== "boolean") return null;
        next.active = operation.value;
        break;
      case "username":
        if (typeof operation.value !== "string") return null;
        next.userName = operation.value;
        break;
      case "displayname":
        if (typeof operation.value !== "string") return null;
        next.displayName = operation.value;
        break;
      case "externalid":
        if (typeof operation.value !== "string") return null;
        next.externalId = operation.value;
        break;
      default:
        return null;
    }
  }

  const validated = ScimUserInputSchema.safeParse({
    schemas: [USER_SCHEMA],
    ...next,
  });
  return validated.success ? replaceInput(validated.data) : null;
}

/**
 * This is the exact SCIM schema subset implemented by ZeroSheet today. It is
 * intentionally small and honest: advertising unsupported enterprise fields
 * or Group resources would cause directory providers to send updates the
 * service cannot preserve.
 */
function userSchemaDefinition(): Record<string, unknown> {
  return {
    schemas: [SCHEMA_RESOURCE],
    id: USER_SCHEMA,
    name: "User",
    description: "ZeroSheet tenant-scoped user lifecycle resource",
    attributes: [
      {
        name: "userName",
        type: "string",
        multiValued: false,
        required: true,
        caseExact: false,
        mutability: "readWrite",
        returned: "default",
        uniqueness: "server",
      },
      {
        name: "displayName",
        type: "string",
        multiValued: false,
        required: false,
        caseExact: false,
        mutability: "readWrite",
        returned: "default",
        uniqueness: "none",
      },
      {
        name: "active",
        type: "boolean",
        multiValued: false,
        required: false,
        mutability: "readWrite",
        returned: "default",
      },
    ],
    meta: { resourceType: "Schema" },
  };
}

async function executeScim<T>(
  reply: FastifyReply,
  action: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; reply: FastifyReply }> {
  try {
    return { ok: true, value: await action() };
  } catch (error) {
    if (error instanceof LifecycleNotFoundError) {
      return { ok: false, reply: scimError(reply, 404, error.message) };
    }
    if (error instanceof LifecycleConflictError) {
      return {
        ok: false,
        reply: scimError(reply, 409, error.message, "uniqueness"),
      };
    }
    if (error instanceof ProductDependencyError) {
      return {
        ok: false,
        reply: scimError(
          reply,
          503,
          "Lifecycle synchronization is unavailable.",
        ),
      };
    }
    throw error;
  }
}

export function registerLifecycleRoutes(
  app: FastifyInstance,
  options: LifecycleRouteOptions,
): void {
  app.post(
    "/organizations/:organizationId/scim/connections",
    async (request, reply) => {
      protectLifecycleResponse(reply);
      const actor = await authenticatedUser(request, reply, options);
      const parameters = OrganizationParametersSchema.safeParse(request.params);
      const body = ScimConnectionInputSchema.safeParse(request.body);
      if (!actor) return reply;
      if (!parameters.success || !body.success) {
        return reply.code(400).send({ error: "invalid_request" });
      }

      try {
        const connection = await options.lifecycle.createConnection(
          actor,
          parameters.data.organizationId,
          body.data.displayName,
        );
        return reply.code(201).send(connection);
      } catch (error) {
        if (error instanceof LifecycleForbiddenError) {
          return reply.code(403).send({ error: "forbidden" });
        }
        if (error instanceof ProductDependencyError) {
          return reply.code(503).send({ error: "authorization_unavailable" });
        }
        throw error;
      }
    },
  );

  app.get("/scim/v2/ServiceProviderConfig", (_request, reply) => {
    protectLifecycleResponse(reply);
    return reply.type("application/scim+json").send({
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
      patch: { supported: true },
      bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
      filter: { supported: true, maxResults: 200 },
      changePassword: { supported: false },
      sort: { supported: false },
      etag: { supported: true },
      authenticationSchemes: [
        {
          type: "oauthbearertoken",
          name: "Bearer token",
          description: "ZeroSheet tenant-scoped SCIM bearer credential",
          specUri: "https://www.rfc-editor.org/rfc/rfc6750",
          primary: true,
        },
      ],
    });
  });

  app.get("/scim/v2/ResourceTypes", (_request, reply) => {
    protectLifecycleResponse(reply);
    return reply.type("application/scim+json").send({
      schemas: [LIST_SCHEMA],
      totalResults: 1,
      startIndex: 1,
      itemsPerPage: 1,
      Resources: [
        {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"],
          id: "User",
          name: "User",
          endpoint: "/Users",
          schema: USER_SCHEMA,
        },
      ],
    });
  });

  app.get("/scim/v2/Schemas", (_request, reply) => {
    protectLifecycleResponse(reply);
    return reply.type("application/scim+json").send({
      schemas: [LIST_SCHEMA],
      totalResults: 1,
      startIndex: 1,
      itemsPerPage: 1,
      Resources: [userSchemaDefinition()],
    });
  });

  app.get("/scim/v2/Schemas/:id", (request, reply) => {
    protectLifecycleResponse(reply);
    const parameters = z.object({ id: z.string() }).safeParse(request.params);
    if (!parameters.success || parameters.data.id !== USER_SCHEMA) {
      return scimError(reply, 404, "The SCIM schema was not found.");
    }
    return reply.type("application/scim+json").send(userSchemaDefinition());
  });

  app.post("/scim/v2/Users", async (request, reply) => {
    const connection = await connectionFor(request, reply, options);
    const body = ScimUserInputSchema.safeParse(request.body);
    if (!connection) return reply;
    if (!body.success) {
      return scimError(
        reply,
        400,
        "The SCIM User body is invalid.",
        "invalidValue",
      );
    }
    const result = await executeScim(reply, () =>
      options.lifecycle.createUser(connection, replaceInput(body.data)),
    );
    return result.ok
      ? sendUser(reply, result.value, options.scimBaseUrl, 201)
      : result.reply;
  });

  app.get("/scim/v2/Users", async (request, reply) => {
    const connection = await connectionFor(request, reply, options);
    if (!connection) return reply;
    const query = request.query as Record<string, unknown>;
    const filter = parseFilter(query.filter);
    if (filter === null) {
      return scimError(
        reply,
        400,
        "Only externalId/userName eq filters are supported.",
        "invalidFilter",
      );
    }
    const users = await options.lifecycle.listUsers(connection, filter);
    protectLifecycleResponse(reply);
    return reply.type("application/scim+json").send({
      schemas: [LIST_SCHEMA],
      totalResults: users.length,
      startIndex: 1,
      itemsPerPage: users.length,
      Resources: users.map((user) => userResponse(user, options.scimBaseUrl)),
    });
  });

  app.get("/scim/v2/Users/:id", async (request, reply) => {
    const connection = await connectionFor(request, reply, options);
    const parameters = ScimUserParametersSchema.safeParse(request.params);
    if (!connection) return reply;
    if (!parameters.success)
      return scimError(reply, 404, "The SCIM resource was not found.");
    const result = await executeScim(reply, () =>
      options.lifecycle.findUser(connection, parameters.data.id),
    );
    return result.ok
      ? sendUser(reply, result.value, options.scimBaseUrl)
      : result.reply;
  });

  app.put("/scim/v2/Users/:id", async (request, reply) => {
    const connection = await connectionFor(request, reply, options);
    const parameters = ScimUserParametersSchema.safeParse(request.params);
    const body = ScimUserInputSchema.safeParse(request.body);
    if (!connection) return reply;
    if (!parameters.success)
      return scimError(reply, 404, "The SCIM resource was not found.");
    if (!body.success)
      return scimError(
        reply,
        400,
        "The SCIM User body is invalid.",
        "invalidValue",
      );
    const result = await executeScim(reply, () =>
      options.lifecycle.replaceUser(
        connection,
        parameters.data.id,
        replaceInput(body.data),
      ),
    );
    return result.ok
      ? sendUser(reply, result.value, options.scimBaseUrl)
      : result.reply;
  });

  app.patch("/scim/v2/Users/:id", async (request, reply) => {
    const connection = await connectionFor(request, reply, options);
    const parameters = ScimUserParametersSchema.safeParse(request.params);
    const body = ScimPatchSchema.safeParse(request.body);
    if (!connection) return reply;
    if (!parameters.success)
      return scimError(reply, 404, "The SCIM resource was not found.");
    if (!body.success)
      return scimError(
        reply,
        400,
        "The SCIM PATCH body is invalid.",
        "invalidSyntax",
      );
    const current = await executeScim(reply, () =>
      options.lifecycle.findUser(connection, parameters.data.id),
    );
    if (!current.ok) return current.reply;
    const replacement = applyPatch(current.value, body.data);
    if (!replacement) {
      return scimError(
        reply,
        400,
        "Only supported replace operations are accepted.",
        "invalidValue",
      );
    }
    const result = await executeScim(reply, () =>
      options.lifecycle.replaceUser(
        connection,
        parameters.data.id,
        replacement,
      ),
    );
    return result.ok
      ? sendUser(reply, result.value, options.scimBaseUrl)
      : result.reply;
  });

  app.delete("/scim/v2/Users/:id", async (request, reply) => {
    const connection = await connectionFor(request, reply, options);
    const parameters = ScimUserParametersSchema.safeParse(request.params);
    if (!connection) return reply;
    if (!parameters.success)
      return scimError(reply, 404, "The SCIM resource was not found.");
    const result = await executeScim(reply, () =>
      options.lifecycle.deactivateUser(connection, parameters.data.id),
    );
    return result.ok ? reply.code(204).send() : result.reply;
  });
}
