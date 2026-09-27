import {
  CreateWorkspaceFolderSchema,
  WorkbookFolderInputSchema,
  WorkbookParametersSchema,
  WorkspaceFolderSchema,
  WorkspaceQuerySchema,
  WorkspaceResponseSchema,
  WorkspaceWorkbookSchema,
} from "@zerosheet/contracts";
import type { FastifyInstance } from "fastify";
import type { AuthApplicationService } from "../auth/types.js";
import {
  ProductConflictError,
  ProductDependencyError,
  ProductForbiddenError,
  ProductNotFoundError,
} from "../product/errors.js";
import type { WorkspaceService } from "./service.js";

/** Session cookies supply the actor. Origin checks protect mutations; browser
 * clients cannot supply another user ID to browse or reorganize their files. */
export function registerWorkspaceRoutes(
  app: FastifyInstance,
  options: {
    service: WorkspaceService;
    auth: AuthApplicationService;
    cookieName: string;
    webOrigin: string;
  },
) {
  app.addHook("onRequest", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (
      request.method !== "GET" &&
      request.headers.origin !== options.webOrigin
    )
      return reply.code(403).send({ error: "forbidden_origin" });
    if (!(await options.auth.currentUser(request.cookies[options.cookieName])))
      return reply.code(401).send({ authenticated: false });
  });
  app.setErrorHandler((error, _request, reply) => {
    const status =
      error instanceof ProductForbiddenError
        ? 403
        : error instanceof ProductNotFoundError
          ? 404
          : error instanceof ProductConflictError
            ? 409
            : error instanceof ProductDependencyError
              ? 503
              : 500;
    // Do not expose database errors or candidate metadata when a dependency fails.
    return reply.code(status).send({ error: "workspace_unavailable" });
  });
  app.get("/workspace", async (request, reply) => {
    const query = WorkspaceQuerySchema.safeParse(request.query);
    if (!query.success)
      return reply.code(400).send({ error: "invalid_request" });
    const actor = await options.auth.currentUser(
      request.cookies[options.cookieName],
    );
    if (!actor) return reply.code(401).send({ authenticated: false });
    return WorkspaceResponseSchema.parse(
      await options.service.list(actor, query.data.after),
    );
  });
  app.get("/workspace/workbooks/:workbookId", async (request, reply) => {
    const params = WorkbookParametersSchema.safeParse(request.params);
    if (!params.success)
      return reply.code(400).send({ error: "invalid_request" });
    const actor = await options.auth.currentUser(
      request.cookies[options.cookieName],
    );
    if (!actor) return reply.code(401).send({ authenticated: false });
    return WorkspaceWorkbookSchema.parse(
      await options.service.open(actor, params.data.workbookId),
    );
  });
  app.post("/workspace/folders", async (request, reply) => {
    const body = CreateWorkspaceFolderSchema.safeParse(request.body);
    if (!body.success)
      return reply.code(400).send({ error: "invalid_request" });
    const actor = await options.auth.currentUser(
      request.cookies[options.cookieName],
    );
    if (!actor) return reply.code(401).send({ authenticated: false });
    return reply
      .code(201)
      .send(
        WorkspaceFolderSchema.parse(
          await options.service.createFolder(
            actor,
            body.data.name,
            body.data.parentId,
          ),
        ),
      );
  });
  app.put("/workspace/workbooks/:workbookId/folder", async (request, reply) => {
    const body = WorkbookFolderInputSchema.safeParse(request.body);
    const params = WorkbookParametersSchema.safeParse(request.params);
    if (!body.success || !params.success)
      return reply.code(400).send({ error: "invalid_request" });
    const actor = await options.auth.currentUser(
      request.cookies[options.cookieName],
    );
    if (!actor) return reply.code(401).send({ authenticated: false });
    await options.service.placeWorkbook(
      actor,
      params.data.workbookId,
      body.data.folderId,
    );
    return reply.code(204).send();
  });
}
