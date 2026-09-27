import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { describe, it, expect, vi } from "vitest";
import {
  WorkspaceService,
  type WorkbookCandidate,
  type WorkspaceRepository,
} from "./service.js";
import { registerWorkspaceRoutes } from "./routes.js";
import type { AuthApplicationService } from "../auth/types.js";
import {
  ProductDependencyError,
  ProductForbiddenError,
} from "../product/errors.js";

const actor = {
  id: "a1000000-0000-4000-8000-000000000001",
  email: "user@example.com",
  displayName: "User",
};
const candidate: WorkbookCandidate = {
  id: "a1000000-0000-4000-8000-000000000002",
  organizationId: "a1000000-0000-4000-8000-000000000003",
  name: "Private workbook",
  createdBy: actor.id,
  createdAt: "2026-09-26T10:00:00.000Z",
  folderId: null,
  ready: true,
};
function setup() {
  const repository = {
    candidates: vi
      .fn<WorkspaceRepository["candidates"]>()
      .mockResolvedValue([candidate]),
    workbook: vi
      .fn<WorkspaceRepository["workbook"]>()
      .mockResolvedValue(candidate),
    organizations: vi
      .fn<WorkspaceRepository["organizations"]>()
      .mockResolvedValue([
        { id: candidate.organizationId, name: "Private organization" },
      ]),
    folders: vi.fn<WorkspaceRepository["folders"]>().mockResolvedValue([]),
    createFolder: vi.fn<WorkspaceRepository["createFolder"]>(
      (_user, name, parentId) =>
        Promise.resolve({
          id: candidate.id,
          name,
          parentId,
        }),
    ),
    placeWorkbook: vi
      .fn<WorkspaceRepository["placeWorkbook"]>()
      .mockResolvedValue(undefined),
  } satisfies WorkspaceRepository;
  const decisions = {
    canCreateOrganization: vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValue(true),
    canAccessWorkbook: vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
    canAccessOrganization: vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValue(true),
    canAccessTeam: vi.fn<() => Promise<boolean>>().mockResolvedValue(false),
  };
  return {
    repository,
    decisions,
    service: new WorkspaceService(repository, decisions),
  };
}
describe("workbook browser authorization", () => {
  it("filters denied candidates and organizations before exposing names", async () => {
    const { service, decisions } = setup();
    decisions.canAccessWorkbook.mockResolvedValue(false);
    decisions.canAccessOrganization.mockResolvedValue(false);
    expect(await service.list(actor)).toEqual({
      workbooks: [],
      organizations: [],
      folders: [],
      nextCursor: null,
    });
  });
  it("fails closed if policy is unavailable", async () => {
    const { service, decisions } = setup();
    decisions.canAccessWorkbook.mockRejectedValue(new Error("offline"));
    await expect(service.list(actor)).rejects.toBeInstanceOf(
      ProductDependencyError,
    );
  });
  it("checks view permission before reading a direct workbook link", async () => {
    const { service, decisions, repository } = setup();
    decisions.canAccessWorkbook.mockResolvedValue(false);
    await expect(service.open(actor, candidate.id)).rejects.toBeInstanceOf(
      ProductForbiddenError,
    );
    expect(repository.workbook).not.toHaveBeenCalled();
  });
  it("prevents moving a workbook the actor cannot view", async () => {
    const { service, decisions, repository } = setup();
    decisions.canAccessWorkbook.mockResolvedValue(false);
    await expect(
      service.placeWorkbook(actor, candidate.id, null),
    ).rejects.toBeInstanceOf(ProductForbiddenError);
    expect(repository.placeWorkbook).not.toHaveBeenCalled();
  });
  it("uses the session actor for folder placement", async () => {
    const { service, repository } = setup();
    await service.placeWorkbook(actor, candidate.id, null);
    expect(repository.placeWorkbook).toHaveBeenCalledWith(
      actor.id,
      candidate.id,
      null,
    );
  });
  it("advances a bounded cursor even when all candidates are denied", async () => {
    const { service, repository, decisions } = setup();
    vi.mocked(repository.candidates).mockResolvedValue(
      Array.from({ length: 51 }, () => candidate),
    );
    decisions.canAccessWorkbook.mockResolvedValue(false);
    const page = await service.list(actor);
    expect(page.workbooks).toEqual([]);
    expect(page.nextCursor).toBe(candidate.id);
    expect(decisions.canAccessWorkbook).toHaveBeenCalledTimes(50);
  });
  it("guards HTTP routes with session, origin, strict bodies and no-store", async () => {
    const { service, repository } = setup();
    const app = Fastify();
    await app.register(cookie);
    const currentUser = vi
      .fn<() => Promise<typeof actor | null>>()
      .mockResolvedValue(actor);
    await app.register((scope, _options, done) => {
      registerWorkspaceRoutes(scope, {
        service,
        auth: { currentUser } as unknown as AuthApplicationService,
        cookieName: "session",
        webOrigin: "http://localhost:5173",
      });
      done();
    });
    try {
      const denied = await app.inject({
        method: "POST",
        url: "/workspace/folders",
        payload: { name: "Folder", parentId: null },
      });
      expect(denied.statusCode).toBe(403);
      expect(repository.createFolder).not.toHaveBeenCalled();
      const injectedActor = await app.inject({
        method: "POST",
        url: "/workspace/folders",
        headers: { origin: "http://localhost:5173" },
        payload: { name: "Folder", parentId: null, userId: candidate.id },
      });
      expect(injectedActor.statusCode).toBe(400);
      const allowed = await app.inject({ method: "GET", url: "/workspace" });
      expect(allowed.statusCode).toBe(200);
      expect(allowed.headers["cache-control"]).toBe("no-store");
      currentUser.mockResolvedValue(null);
      expect((await app.inject({ url: "/workspace" })).statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});
