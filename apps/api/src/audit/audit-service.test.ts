import { describe, expect, it } from "vitest";
import type {
  AuthorizationApplicationService,
  CheckOrganizationPermissionInput,
} from "../authorization/types.js";
import { AuditAccessDeniedError, AuditService } from "./audit-service.js";
import type { AuditEvent, AuditEventInput, AuditRepository } from "./types.js";

/**
 * Audit export tests keep authorization and storage as separate fakes. That
 * separation proves the service checks the tenant administration permission
 * before it asks PostgreSQL for sensitive security evidence, and that cursor
 * arguments are forwarded unchanged after an allow decision.
 */
class FakeAuthorization implements AuthorizationApplicationService {
  public allowed = true;
  public organizationInput: CheckOrganizationPermissionInput | undefined;

  public canCreateOrganization() {
    return Promise.resolve(this.allowed);
  }

  public canAccessOrganization(input: CheckOrganizationPermissionInput) {
    this.organizationInput = input;
    return Promise.resolve(this.allowed);
  }

  public canAccessTeam() {
    return Promise.resolve(this.allowed);
  }

  public canAccessWorkbook() {
    return Promise.resolve(this.allowed);
  }
}

class FakeAuditRepository implements AuditRepository {
  public listInput:
    | {
        organizationId: string;
        limit: number;
        beforeSequence: number | undefined;
      }
    | undefined;
  public events: AuditEvent[] = [];

  public assertReady(): Promise<void> {
    return Promise.resolve();
  }

  public record(event: AuditEventInput): Promise<void> {
    // The export service never records, but consuming the typed argument keeps
    // this fake faithful to the repository port without weakening lint rules.
    void event;
    return Promise.resolve();
  }

  public listForOrganization(
    organizationId: string,
    limit: number,
    beforeSequence?: number,
  ) {
    this.listInput = { organizationId, limit, beforeSequence };
    return Promise.resolve(this.events);
  }
}

const actorUserId = "11111111-1111-4111-8111-111111111111";
const organizationId = "22222222-2222-4222-8222-222222222222";

describe("AuditService", () => {
  it("exports only after the composed tenant-administration decision allows it", async () => {
    const repository = new FakeAuditRepository();
    const authorization = new FakeAuthorization();
    const service = new AuditService(repository, authorization);

    await expect(
      service.listOrganizationEvents(actorUserId, organizationId, 25, 100),
    ).resolves.toEqual([]);
    expect(authorization.organizationInput).toEqual({
      userId: actorUserId,
      organizationId,
      permission: "can_manage_members",
    });
    expect(repository.listInput).toEqual({
      organizationId,
      limit: 25,
      beforeSequence: 100,
    });
  });

  it("does not query evidence when the actor lacks tenant administration", async () => {
    const repository = new FakeAuditRepository();
    const authorization = new FakeAuthorization();
    authorization.allowed = false;
    const service = new AuditService(repository, authorization);

    await expect(
      service.listOrganizationEvents(actorUserId, organizationId, 25),
    ).rejects.toBeInstanceOf(AuditAccessDeniedError);
    expect(repository.listInput).toBeUndefined();
  });
});
