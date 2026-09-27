import { z } from "zod";

/** Browser metadata only: never put cell values, keys, or tokens in a file list. */
export const WorkspaceFolderSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(200),
  parentId: z.string().uuid().nullable(),
});
export const WorkspaceWorkbookSchema = z.object({
  id: z.string().uuid(),
  organizationId: z.string().uuid(),
  name: z.string(),
  createdBy: z.string().uuid(),
  createdAt: z.string().datetime(),
  folderId: z.string().uuid().nullable(),
  ready: z.boolean(),
  canEdit: z.boolean(),
  canShare: z.boolean(),
});
export const WorkspaceResponseSchema = z.object({
  workbooks: z.array(WorkspaceWorkbookSchema).max(50),
  folders: z.array(WorkspaceFolderSchema).max(500),
  organizations: z
    .array(z.object({ id: z.string().uuid(), name: z.string() }))
    .max(100),
  nextCursor: z.string().uuid().nullable(),
});
export const CreateWorkspaceFolderSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .refine((name) => !name.includes("\0")),
    parentId: z.string().uuid().nullable(),
  })
  .strict();
export const WorkbookFolderInputSchema = z
  .object({ folderId: z.string().uuid().nullable() })
  .strict();
export const WorkspaceQuerySchema = z
  .object({ after: z.string().uuid().optional() })
  .strict();
export type WorkspaceWorkbook = z.infer<typeof WorkspaceWorkbookSchema>;
export type WorkspaceFolder = z.infer<typeof WorkspaceFolderSchema>;
export type WorkspaceResponse = z.infer<typeof WorkspaceResponseSchema>;
