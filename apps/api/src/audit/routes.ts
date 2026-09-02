import { AuthSessionResponseSchema } from "@zerosheet/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AuthApplicationService } from "../auth/types.js";
import type { AuthCookieConfig } from "../config.js";
import { AuditAccessDeniedError } from "./audit-service.js";
import type { AuditApplicationService } from "./types.js";

const ParametersSchema = z.object({ organizationId: z.string().uuid() });
const QuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100),
  beforeSequence: z.coerce.number().int().positive().optional(),
});

export interface AuditRouteOptions {
  authentication: AuthApplicationService;
  audit: AuditApplicationService;
  cookies: AuthCookieConfig;
}

/**
 * Audit export is no-store JSON and exposes only events for the organization
 * whose composed administration permission was checked. The endpoint uses a
 * sequence cursor rather than offset pagination so concurrent appends cannot
 * cause skipped or duplicated evidence pages.
 */
export function registerAuditRoutes(
  app: FastifyInstance,
  options: AuditRouteOptions,
): void {
  app.get(
    "/organizations/:organizationId/audit-events",
    async (request, reply) => {
      void reply.header("Cache-Control", "no-store");
      const actor = await options.authentication.currentUser(
        request.cookies[options.cookies.sessionName],
      );
      if (!actor) {
        return reply
          .code(401)
          .send(AuthSessionResponseSchema.parse({ authenticated: false }));
      }

      const parameters = ParametersSchema.safeParse(request.params);
      const query = QuerySchema.safeParse(request.query);
      if (!parameters.success || !query.success) {
        return reply.code(400).send({ error: "invalid_request" });
      }

      try {
        const events = await options.audit.listOrganizationEvents(
          actor.id,
          parameters.data.organizationId,
          query.data.limit,
          query.data.beforeSequence,
        );
        return {
          events: events.map((event) => ({
            ...event,
            occurredAt: event.occurredAt.toISOString(),
          })),
          nextBeforeSequence: events.at(-1)?.sequence,
        };
      } catch (error) {
        if (error instanceof AuditAccessDeniedError) {
          return reply.code(403).send({ error: "forbidden" });
        }
        throw error;
      }
    },
  );
}
