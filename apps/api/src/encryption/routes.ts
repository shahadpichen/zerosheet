import {
  AuthSessionResponseSchema,
  EncryptionIdentityResponseSchema,
  EncryptionIdentityVersionParametersSchema,
  InitializeWorkbookEncryptionInputSchema,
  ProductErrorResponseSchema,
  RecipientEncryptionKeyResponseSchema,
  RegisterEncryptionIdentityInputSchema,
  SecureWorkbookShareInputSchema,
  StageWorkbookRotationInputSchema,
  WorkbookEncryptionAccessResponseSchema,
  WorkbookEncryptionStateResponseSchema,
  WorkbookParametersSchema,
  WorkbookRecipientKeyParametersSchema,
  WorkbookRotationParametersSchema,
  WorkbookRotationPlanResponseSchema,
  WorkbookRotationResponseSchema,
  WorkbookShareParametersSchema,
  WorkbookShareResponseSchema,
  WorkbookSharingAuditExpectationResponseSchema,
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
} from "../product/errors.js";
import {
  EncryptionIdentityRequiredError,
  WorkbookEnvelopeUnavailableError,
  WorkbookSecurityInputError,
} from "./errors.js";
import type { WorkbookSecurityApplicationService } from "./types.js";

export interface WorkbookSecurityRouteOptions {
  readonly authentication: AuthApplicationService;
  readonly security: WorkbookSecurityApplicationService;
  readonly cookies: AuthCookieConfig;
}

/**
 * Every response is private session state or encryption metadata. `no-store`
 * prevents an intermediary or shared browser cache from replaying another
 * user's encrypted backup, public-key choice, or workbook envelope.
 */
export function registerWorkbookSecurityRoutes(
  app: FastifyInstance,
  options: WorkbookSecurityRouteOptions,
): void {
  app.addHook("onRequest", (_request, reply, done) => {
    void reply.header("Cache-Control", "no-store");
    done();
  });

  app.post("/encryption/identities", async (request, reply) => {
    const actor = await authenticatedUser(request, reply, options);
    const body = RegisterEncryptionIdentityInputSchema.safeParse(request.body);
    if (!actor) return reply;
    if (!body.success) return invalidRequest(reply);

    return execute(reply, async () => {
      const value = await options.security.registerIdentity(actor, body.data);
      return reply
        .code(201)
        .send(EncryptionIdentityResponseSchema.parse(value));
    });
  });

  app.get("/encryption/identities/me", async (request, reply) => {
    const actor = await authenticatedUser(request, reply, options);
    if (!actor) return reply;
    return execute(reply, async () =>
      EncryptionIdentityResponseSchema.parse(
        await options.security.ownIdentity(actor),
      ),
    );
  });

  app.get("/encryption/identities/me/:keyVersion", async (request, reply) => {
    const actor = await authenticatedUser(request, reply, options);
    const parameters = EncryptionIdentityVersionParametersSchema.safeParse(
      request.params,
    );
    if (!actor) return reply;
    if (!parameters.success) return invalidRequest(reply);
    return execute(reply, async () =>
      EncryptionIdentityResponseSchema.parse(
        await options.security.ownIdentityVersion(
          actor,
          parameters.data.keyVersion,
        ),
      ),
    );
  });

  app.get(
    "/workbooks/:workbookId/encryption/recipients/:userId/key",
    async (request, reply) => {
      const actor = await authenticatedUser(request, reply, options);
      const parameters = WorkbookRecipientKeyParametersSchema.safeParse(
        request.params,
      );
      if (!actor) return reply;
      if (!parameters.success) return invalidRequest(reply);
      return execute(reply, async () =>
        RecipientEncryptionKeyResponseSchema.parse(
          await options.security.recipientKey(
            actor,
            parameters.data.workbookId,
            parameters.data.userId,
          ),
        ),
      );
    },
  );

  app.post("/workbooks/:workbookId/encryption", async (request, reply) => {
    const actor = await authenticatedUser(request, reply, options);
    const parameters = WorkbookParametersSchema.safeParse(request.params);
    const body = InitializeWorkbookEncryptionInputSchema.safeParse(
      request.body,
    );
    if (!actor) return reply;
    if (!parameters.success || !body.success) return invalidRequest(reply);
    return execute(reply, async () =>
      reply
        .code(201)
        .send(
          WorkbookEncryptionStateResponseSchema.parse(
            await options.security.initializeWorkbook(
              actor,
              parameters.data.workbookId,
              body.data,
            ),
          ),
        ),
    );
  });

  app.get("/workbooks/:workbookId/encryption", async (request, reply) => {
    const actor = await authenticatedUser(request, reply, options);
    const parameters = WorkbookParametersSchema.safeParse(request.params);
    if (!actor) return reply;
    if (!parameters.success) return invalidRequest(reply);
    return execute(reply, async () =>
      WorkbookEncryptionAccessResponseSchema.parse(
        await options.security.workbookAccess(
          actor,
          parameters.data.workbookId,
        ),
      ),
    );
  });

  app.put(
    "/workbooks/:workbookId/secure-shares/users/:principalId",
    async (request, reply) => {
      const actor = await authenticatedUser(request, reply, options);
      const parameters = WorkbookShareParametersSchema.safeParse(
        request.params,
      );
      const body = SecureWorkbookShareInputSchema.safeParse(request.body);
      if (!actor) return reply;
      if (!parameters.success || !body.success) return invalidRequest(reply);
      return execute(reply, async () =>
        WorkbookShareResponseSchema.parse(
          await options.security.setSecureUserShare(
            actor,
            parameters.data.workbookId,
            parameters.data.principalId,
            body.data,
          ),
        ),
      );
    },
  );

  app.get(
    "/workbooks/:workbookId/secure-shares/audit-expectation",
    async (request, reply) => {
      const actor = await authenticatedUser(request, reply, options);
      const parameters = WorkbookParametersSchema.safeParse(request.params);
      if (!actor) return reply;
      if (!parameters.success) return invalidRequest(reply);
      return execute(reply, async () =>
        WorkbookSharingAuditExpectationResponseSchema.parse(
          await options.security.sharingAuditExpectation(
            actor,
            parameters.data.workbookId,
          ),
        ),
      );
    },
  );

  app.post(
    "/workbooks/:workbookId/encryption/rotations",
    async (request, reply) => {
      const actor = await authenticatedUser(request, reply, options);
      const parameters = WorkbookParametersSchema.safeParse(request.params);
      const body = StageWorkbookRotationInputSchema.safeParse(request.body);
      if (!actor) return reply;
      if (!parameters.success || !body.success) return invalidRequest(reply);
      return execute(reply, async () =>
        reply
          .code(201)
          .send(
            WorkbookRotationResponseSchema.parse(
              await options.security.stageRotation(
                actor,
                parameters.data.workbookId,
                body.data,
              ),
            ),
          ),
      );
    },
  );

  app.get(
    "/workbooks/:workbookId/encryption/rotations/revoke/:userId/plan",
    async (request, reply) => {
      const actor = await authenticatedUser(request, reply, options);
      const parameters = WorkbookRecipientKeyParametersSchema.safeParse(
        request.params,
      );
      if (!actor) return reply;
      if (!parameters.success) return invalidRequest(reply);
      return execute(reply, async () =>
        WorkbookRotationPlanResponseSchema.parse(
          await options.security.rotationPlan(
            actor,
            parameters.data.workbookId,
            parameters.data.userId,
          ),
        ),
      );
    },
  );

  app.post(
    "/workbooks/:workbookId/encryption/rotations/:toKeyVersion/commit",
    async (request, reply) => {
      const actor = await authenticatedUser(request, reply, options);
      const parameters = WorkbookRotationParametersSchema.safeParse(
        request.params,
      );
      if (!actor) return reply;
      if (!parameters.success) return invalidRequest(reply);
      return execute(reply, async () =>
        WorkbookRotationResponseSchema.parse(
          await options.security.commitRotation(
            actor,
            parameters.data.workbookId,
            parameters.data.toKeyVersion,
          ),
        ),
      );
    },
  );
}

async function authenticatedUser(
  request: FastifyRequest,
  reply: FastifyReply,
  options: WorkbookSecurityRouteOptions,
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

async function execute(
  reply: FastifyReply,
  action: () => Promise<unknown>,
): Promise<unknown> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof WorkbookSecurityInputError) {
      return reply.code(400).send(
        ProductErrorResponseSchema.parse({
          error: "invalid_request",
          message: error.message,
        }),
      );
    }
    if (
      error instanceof EncryptionIdentityRequiredError ||
      error instanceof WorkbookEnvelopeUnavailableError ||
      error instanceof ProductConflictError
    ) {
      return reply.code(409).send(
        ProductErrorResponseSchema.parse({
          error: "conflict",
          message: error.message,
        }),
      );
    }
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
    if (error instanceof ProductDependencyError) {
      return reply.code(503).send(
        ProductErrorResponseSchema.parse({
          error: "authorization_unavailable",
          message: error.message,
        }),
      );
    }
    throw error;
  }
}

function invalidRequest(reply: FastifyReply): FastifyReply {
  return reply.code(400).send(
    ProductErrorResponseSchema.parse({
      error: "invalid_request",
      message: "The request parameters or body are invalid.",
    }),
  );
}
