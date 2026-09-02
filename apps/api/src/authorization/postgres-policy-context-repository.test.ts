import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { PostgresPolicyContextRepository } from "./postgres-policy-context-repository.js";

function repositoryReturning(rows: unknown[]) {
  const query = vi.fn().mockResolvedValue({ rows });
  const repository = new PostgresPolicyContextRepository({
    query,
  } as unknown as Pool);
  return { repository, query };
}

describe("PostgresPolicyContextRepository", () => {
  it("refuses startup until the contextual status migration exists", async () => {
    const { repository } = repositoryReturning([{ present: false }]);

    await expect(repository.assertReady()).rejects.toThrow(
      /contextual authorization migration/u,
    );
  });

  it("projects only the subject status for platform policy", async () => {
    const { repository, query } = repositoryReturning([
      { subject_status: "active" },
    ]);

    await expect(repository.findPlatformContext("user-1")).resolves.toEqual({
      subject: { id: "user-1", status: "active" },
    });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("product_users"),
      ["user-1"],
    );
  });

  it("joins workbook tenancy while excluding inactive product metadata", async () => {
    const { repository, query } = repositoryReturning([
      {
        subject_status: "active",
        organization_id: "organization-1",
        organization_status: "suspended",
      },
    ]);

    await expect(
      repository.findWorkbookContext("user-1", "workbook-1"),
    ).resolves.toEqual({
      subject: { id: "user-1", status: "active" },
      organization: { id: "organization-1", status: "suspended" },
    });
    expect(query.mock.calls[0]?.[0]).toContain(
      "workbooks.authorization_state = 'active'",
    );
  });

  it("returns no context when either the subject or resource is absent", async () => {
    const { repository } = repositoryReturning([]);

    await expect(
      repository.findOrganizationContext("missing-user", "missing-org"),
    ).resolves.toBeNull();
  });
});
