import type { AuthorizationApplicationService } from "../authorization/types.js";
import type {
  AuditApplicationService,
  AuditEvent,
  AuditRepository,
} from "./types.js";

export class AuditAccessDeniedError extends Error {
  public constructor() {
    super("The principal may not export this organization's audit events.");
    this.name = "AuditAccessDeniedError";
  }
}

/**
 * Audit export is itself a privileged product action because event metadata
 * can reveal user IDs, resource IDs, and security outcomes. This service uses
 * the same composed OpenFGA + OPA organization administration decision as the
 * rest of the tenant control plane.
 */
export class AuditService implements AuditApplicationService {
  public constructor(
    private readonly repository: AuditRepository,
    private readonly authorization: AuthorizationApplicationService,
  ) {}

  public async listOrganizationEvents(
    actorUserId: string,
    organizationId: string,
    limit: number,
    beforeSequence?: number,
  ): Promise<AuditEvent[]> {
    const allowed = await this.authorization.canAccessOrganization({
      userId: actorUserId,
      organizationId,
      permission: "can_manage_members",
    });
    if (!allowed) throw new AuditAccessDeniedError();

    return this.repository.listForOrganization(
      organizationId,
      limit,
      beforeSequence,
    );
  }
}
