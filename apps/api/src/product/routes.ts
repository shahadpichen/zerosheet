import {
  AuthSessionResponseSchema,
  NamedResourceInputSchema,
  OrganizationMemberInputSchema,
  OrganizationMemberParametersSchema,
  OrganizationMembershipResponseSchema,
  OrganizationParametersSchema,
  OrganizationResponseSchema,
  ProductErrorResponseSchema,
  TeamMemberInputSchema,
  TeamMemberParametersSchema,
  TeamMembershipResponseSchema,
  TeamResponseSchema,
  WorkbookParametersSchema,
  WorkbookResponseSchema,
  WorkbookShareInputSchema,
  WorkbookShareParametersSchema,
  WorkbookShareResponseSchema,
} from "@zerosheet/contracts";
import type { AuthenticatedUser } from "@zerosheet/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AuthApplicationService } from "../auth/types.js";
import type { AuthCookieConfig } from "../config.js";
import {
  ProductConflictError,
  ProductDependencyError,
  ProductForbiddenError,
  ProductNotFoundError,
} from "./errors.js";
import type {
  ProductApplicationService,
  WorkbookSharePrincipal,
} from "./types.js";

export interface ProductRouteOptions {
  authentication: AuthApplicationService;
  product: ProductApplicationService;
  cookies: AuthCookieConfig;
}

async function authenticatedUser(
  request: FastifyRequest,
  reply: FastifyReply,
  options: ProductRouteOptions,
): Promise<AuthenticatedUser | null> {
  const user = await options.authentication.currentUser(
    request.cookies[options.cookies.sessionName],
  );

  if (!user) {
    await reply.code(401).send(
      AuthSessionResponseSchema.parse({
        authenticated: false,
      }),
    );
    return null;
  }

  return user;
}

function invalidRequest(reply: FastifyReply): FastifyReply {
  return reply.code(400).send(
    ProductErrorResponseSchema.parse({
      error: "invalid_request",
      message: "The request parameters or body are invalid.",
    }),
  );
}

function handledProductError(
  reply: FastifyReply,
  error: unknown,
): FastifyReply | null {
  if (error instanceof ProductForbiddenError) {
    return reply.code(403).send(
      ProductErrorResponseSchema.parse({
        error: "forbidden",
        message: error.message,
      }),
    );
  }

  if (error instanceof ProductNotFoundError) {
    return reply.code(404).send(
      ProductErrorResponseSchema.parse({
        error: "not_found",
        message: error.message,
      }),
    );
  }

  if (error instanceof ProductConflictError) {
    return reply.code(409).send(
      ProductErrorResponseSchema.parse({
        error: "conflict",
        message: error.message,
      }),
    );
  }

  if (error instanceof ProductDependencyError) {
    return reply.code(503).send(
      ProductErrorResponseSchema.parse({
        error: "authorization_unavailable",
        message: error.message,
      }),
    );
  }

  return null;
}

async function executeProductAction<T>(
  reply: FastifyReply,
  action: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; reply: FastifyReply }> {
  try {
    return { ok: true, value: await action() };
  } catch (error) {
    const handled = handledProductError(reply, error);

    if (handled) {
      return { ok: false, reply: handled };
    }

    throw error;
  }
}

/**
 * These routes are Policy Enforcement Points for both reads and relationship
 * administration. They derive the actor from the opaque server-side session,
 * accept only product IDs/roles, and delegate fixed permission checks to the
 * product service. No endpoint accepts an OpenFGA tuple string from a client.
 */
export function registerProductRoutes(
  app: FastifyInstance,
  options: ProductRouteOptions,
): void {
  app.addHook("onRequest", (_request, reply, done) => {
    // Product responses can reveal tenant and sharing metadata. Intermediaries
    // must not cache them for another authenticated browser session.
    void reply.header("Cache-Control", "no-store");
    done();
  });

  app.post("/organizations", async (request, reply) => {
    const actor = await authenticatedUser(request, reply, options);
    const body = NamedResourceInputSchema.safeParse(request.body);

    if (!actor) return reply;
    if (!body.success) return invalidRequest(reply);

    const result = await executeProductAction(reply, () =>
      options.product.createOrganization(actor, body.data),
    );

    return result.ok
      ? reply.code(201).send(OrganizationResponseSchema.parse(result.value))
      : result.reply;
  });

  app.post("/organizations/:organizationId/teams", async (request, reply) => {
    const actor = await authenticatedUser(request, reply, options);
    const parameters = OrganizationParametersSchema.safeParse(request.params);
    const body = NamedResourceInputSchema.safeParse(request.body);

    if (!actor) return reply;
    if (!parameters.success || !body.success) return invalidRequest(reply);

    const result = await executeProductAction(reply, () =>
      options.product.createTeam(
        actor,
        parameters.data.organizationId,
        body.data,
      ),
    );

    return result.ok
      ? reply.code(201).send(TeamResponseSchema.parse(result.value))
      : result.reply;
  });

  app.post(
    "/organizations/:organizationId/workbooks",
    async (request, reply) => {
      const actor = await authenticatedUser(request, reply, options);
      const parameters = OrganizationParametersSchema.safeParse(request.params);
      const body = NamedResourceInputSchema.safeParse(request.body);

      if (!actor) return reply;
      if (!parameters.success || !body.success) return invalidRequest(reply);

      const result = await executeProductAction(reply, () =>
        options.product.createWorkbook(
          actor,
          parameters.data.organizationId,
          body.data,
        ),
      );

      return result.ok
        ? reply.code(201).send(WorkbookResponseSchema.parse(result.value))
        : result.reply;
    },
  );

  app.get("/workbooks/:workbookId", async (request, reply) => {
    const actor = await authenticatedUser(request, reply, options);
    const parameters = WorkbookParametersSchema.safeParse(request.params);

    if (!actor) return reply;
    if (!parameters.success) return invalidRequest(reply);

    const result = await executeProductAction(reply, () =>
      options.product.getWorkbook(actor, parameters.data.workbookId),
    );

    return result.ok
      ? WorkbookResponseSchema.parse(result.value)
      : result.reply;
  });

  app.put(
    "/organizations/:organizationId/members/:userId",
    async (request, reply) => {
      const actor = await authenticatedUser(request, reply, options);
      const parameters = OrganizationMemberParametersSchema.safeParse(
        request.params,
      );
      const body = OrganizationMemberInputSchema.safeParse(request.body);

      if (!actor) return reply;
      if (!parameters.success || !body.success) return invalidRequest(reply);

      const result = await executeProductAction(reply, () =>
        options.product.setOrganizationMember(
          actor,
          parameters.data.organizationId,
          parameters.data.userId,
          body.data.role,
        ),
      );

      return result.ok
        ? OrganizationMembershipResponseSchema.parse(result.value)
        : result.reply;
    },
  );

  app.delete(
    "/organizations/:organizationId/members/:userId",
    async (request, reply) => {
      const actor = await authenticatedUser(request, reply, options);
      const parameters = OrganizationMemberParametersSchema.safeParse(
        request.params,
      );

      if (!actor) return reply;
      if (!parameters.success) return invalidRequest(reply);

      const result = await executeProductAction(reply, () =>
        options.product.removeOrganizationMember(
          actor,
          parameters.data.organizationId,
          parameters.data.userId,
        ),
      );

      return result.ok ? reply.code(204).send() : result.reply;
    },
  );

  app.put("/teams/:teamId/members/:userId", async (request, reply) => {
    const actor = await authenticatedUser(request, reply, options);
    const parameters = TeamMemberParametersSchema.safeParse(request.params);
    const body = TeamMemberInputSchema.safeParse(request.body);

    if (!actor) return reply;
    if (!parameters.success || !body.success) return invalidRequest(reply);

    const result = await executeProductAction(reply, () =>
      options.product.setTeamMember(
        actor,
        parameters.data.teamId,
        parameters.data.userId,
        body.data.role,
      ),
    );

    return result.ok
      ? TeamMembershipResponseSchema.parse(result.value)
      : result.reply;
  });

  app.delete("/teams/:teamId/members/:userId", async (request, reply) => {
    const actor = await authenticatedUser(request, reply, options);
    const parameters = TeamMemberParametersSchema.safeParse(request.params);

    if (!actor) return reply;
    if (!parameters.success) return invalidRequest(reply);

    const result = await executeProductAction(reply, () =>
      options.product.removeTeamMember(
        actor,
        parameters.data.teamId,
        parameters.data.userId,
      ),
    );

    return result.ok ? reply.code(204).send() : result.reply;
  });

  // Direct user sharing now requires a matching HPKE envelope and Google Drive
  // permission, so Milestone 13 exposes it only through `/secure-shares/users`.
  // Leaving the former role-only route active would authorize a recipient who
  // cannot decrypt and would bypass the coordinated Drive rollback workflow.
  registerWorkbookShareRoutes(app, options, "team");
}

function registerWorkbookShareRoutes(
  app: FastifyInstance,
  options: ProductRouteOptions,
  principalType: WorkbookSharePrincipal["type"],
): void {
  const path = `/workbooks/:workbookId/shares/${principalType}s/:principalId`;

  app.put(path, async (request, reply) => {
    const actor = await authenticatedUser(request, reply, options);
    const parameters = WorkbookShareParametersSchema.safeParse(request.params);
    const body = WorkbookShareInputSchema.safeParse(request.body);

    if (!actor) return reply;
    if (!parameters.success || !body.success) return invalidRequest(reply);

    const principal: WorkbookSharePrincipal = {
      type: principalType,
      id: parameters.data.principalId,
    };
    const result = await executeProductAction(reply, () =>
      options.product.setWorkbookShare(
        actor,
        parameters.data.workbookId,
        principal,
        body.data.role,
      ),
    );

    return result.ok
      ? WorkbookShareResponseSchema.parse(result.value)
      : result.reply;
  });

  app.delete(path, async (request, reply) => {
    const actor = await authenticatedUser(request, reply, options);
    const parameters = WorkbookShareParametersSchema.safeParse(request.params);

    if (!actor) return reply;
    if (!parameters.success) return invalidRequest(reply);

    const principal: WorkbookSharePrincipal = {
      type: principalType,
      id: parameters.data.principalId,
    };
    const result = await executeProductAction(reply, () =>
      options.product.removeWorkbookShare(
        actor,
        parameters.data.workbookId,
        principal,
      ),
    );

    return result.ok ? reply.code(204).send() : result.reply;
  });
}
