import type {
  AuthenticatedUser,
  WorkspaceFolder,
  WorkspaceResponse,
  WorkspaceWorkbook,
} from "@zerosheet/contracts";
import type { AuthorizationApplicationService } from "../authorization/types.js";
import {
  ProductDependencyError,
  ProductForbiddenError,
} from "../product/errors.js";

export type WorkbookCandidate = Omit<WorkspaceWorkbook, "canEdit" | "canShare">;
export interface WorkspaceRepository {
  candidates(userId: string, after?: string): Promise<WorkbookCandidate[]>;
  workbook(userId: string, workbookId: string): Promise<WorkbookCandidate>;
  organizations(userId: string): Promise<{ id: string; name: string }[]>;
  folders(userId: string): Promise<WorkspaceFolder[]>;
  createFolder(
    userId: string,
    name: string,
    parentId: string | null,
  ): Promise<WorkspaceFolder>;
  placeWorkbook(
    userId: string,
    workbookId: string,
    folderId: string | null,
  ): Promise<void>;
}

/** SQL narrows candidates; the same OpenFGA + OPA checks as opening a file
 * decide visibility. A list endpoint must never become a shortcut around IAM. */
export class WorkspaceService {
  constructor(
    private readonly repository: WorkspaceRepository,
    private readonly decisions: AuthorizationApplicationService,
  ) {}

  private async allowed(check: Promise<boolean>): Promise<boolean> {
    try {
      return await check;
    } catch {
      throw new ProductDependencyError();
    }
  }

  async list(
    actor: AuthenticatedUser,
    after?: string,
  ): Promise<WorkspaceResponse> {
    const [candidates, organizations, folders] = await Promise.all([
      this.repository.candidates(actor.id, after),
      this.repository.organizations(actor.id),
      this.repository.folders(actor.id),
    ]);
    const workbooks: WorkspaceWorkbook[] = [];
    // One bounded page, evaluated sequentially, avoids a user request flooding
    // the policy services. The cursor advances even over denied candidates.
    for (const workbook of candidates.slice(0, 50)) {
      const check = (
        permission: "can_view" | "can_edit" | "can_manage_sharing",
      ) =>
        this.allowed(
          this.decisions.canAccessWorkbook({
            userId: actor.id,
            workbookId: workbook.id,
            permission,
          }),
        );
      if (!(await check("can_view"))) continue;
      workbooks.push({
        ...workbook,
        canEdit: await check("can_edit"),
        canShare: await check("can_manage_sharing"),
      });
    }
    const writableOrganizations = [];
    for (const organization of organizations) {
      if (
        await this.allowed(
          this.decisions.canAccessOrganization({
            userId: actor.id,
            organizationId: organization.id,
            permission: "can_create_workbook",
          }),
        )
      )
        writableOrganizations.push(organization);
    }
    return {
      workbooks,
      folders,
      organizations: writableOrganizations,
      nextCursor: candidates.length > 50 ? candidates[49]!.id : null,
    };
  }

  async createFolder(
    actor: AuthenticatedUser,
    name: string,
    parentId: string | null,
  ) {
    if (
      !(await this.allowed(
        this.decisions.canCreateOrganization({ userId: actor.id }),
      ))
    )
      throw new ProductForbiddenError();
    return this.repository.createFolder(actor.id, name, parentId);
  }

  async open(
    actor: AuthenticatedUser,
    workbookId: string,
  ): Promise<WorkspaceWorkbook> {
    const check = (
      permission: "can_view" | "can_edit" | "can_manage_sharing",
    ) =>
      this.allowed(
        this.decisions.canAccessWorkbook({
          userId: actor.id,
          workbookId,
          permission,
        }),
      );
    if (!(await check("can_view"))) throw new ProductForbiddenError();
    const workbook = await this.repository.workbook(actor.id, workbookId);
    return {
      ...workbook,
      canEdit: await check("can_edit"),
      canShare: await check("can_manage_sharing"),
    };
  }

  async placeWorkbook(
    actor: AuthenticatedUser,
    workbookId: string,
    folderId: string | null,
  ) {
    if (
      !(await this.allowed(
        this.decisions.canAccessWorkbook({
          userId: actor.id,
          workbookId,
          permission: "can_view",
        }),
      ))
    )
      throw new ProductForbiddenError();
    // Moving a shortcut only changes this user's personal organization. It does
    // not move a Google file, change ownership, or grant access to another user.
    return this.repository.placeWorkbook(actor.id, workbookId, folderId);
  }
}
