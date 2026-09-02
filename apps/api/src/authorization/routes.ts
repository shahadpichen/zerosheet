import {
  AuthorizationDeniedResponseSchema,
  AuthSessionResponseSchema,
  InvalidWorkbookResponseSchema,
  WorkbookAccessResponseSchema,
  WorkbookParametersSchema,
} from "@zerosheet/contracts";
import type { FastifyInstance } from "fastify";
import type { AuthCookieConfig } from "../config.js";
import type { AuthApplicationService } from "../auth/types.js";
import type { AuthorizationApplicationService } from "./types.js";

export interface AuthorizationRouteOptions {
  authentication: AuthApplicationService;
  authorization: AuthorizationApplicationService;
  cookies: AuthCookieConfig;
}

/**
 * This route is the first concrete Policy Enforcement Point. It derives the
 * principal from the server-side session, asks one fixed business permission,
 * and returns resource information only after an explicit OpenFGA allow.
 */
export function registerAuthorizationRoutes(
  app: FastifyInstance,
  options: AuthorizationRouteOptions,
): void {
  app.get("/workbooks/:workbookId/access", async (request, reply) => {
    void reply.header("Cache-Control", "no-store");

    const parsedParameters = WorkbookParametersSchema.safeParse(request.params);

    if (!parsedParameters.success) {
      return reply.code(400).send(
        InvalidWorkbookResponseSchema.parse({
          error: "invalid_workbook_id",
          message: "The workbook identifier must be a UUID.",
        }),
      );
    }

    const user = await options.authentication.currentUser(
      request.cookies[options.cookies.sessionName],
    );

    if (!user) {
      return reply.code(401).send(
        AuthSessionResponseSchema.parse({
          authenticated: false,
        }),
      );
    }

    const allowed = await options.authorization.canAccessWorkbook({
      userId: user.id,
      workbookId: parsedParameters.data.workbookId,
      permission: "can_view",
    });

    if (!allowed) {
      return reply.code(403).send(
        AuthorizationDeniedResponseSchema.parse({
          error: "forbidden",
          message: "You do not have permission to access this workbook.",
        }),
      );
    }

    return WorkbookAccessResponseSchema.parse({
      workbookId: parsedParameters.data.workbookId,
      permission: "can_view",
      allowed: true,
    });
  });
}
