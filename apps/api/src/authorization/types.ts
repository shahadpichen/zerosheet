/**
 * The API asks business permissions rather than inspecting OpenFGA roles. A
 * model can later change how `can_view` is derived without changing every
 * protected route.
 */
export type WorkbookPermission = "can_view" | "can_edit" | "can_manage_sharing";

export interface CheckWorkbookPermissionInput {
  userId: string;
  workbookId: string;
  permission: WorkbookPermission;
}

/**
 * This gateway is the anti-corruption layer around the OpenFGA SDK. Product
 * services never construct raw `user:<id>` or `workbook:<id>` tuple strings and
 * remain testable without a running network decision service.
 */
export interface AuthorizationGateway {
  assertReady(): Promise<void>;
  checkWorkbookPermission(
    input: CheckWorkbookPermissionInput,
  ): Promise<boolean>;
}

export interface AuthorizationApplicationService {
  canAccessWorkbook(input: CheckWorkbookPermissionInput): Promise<boolean>;
}
