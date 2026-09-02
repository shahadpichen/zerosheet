export type AuditActorType = "user" | "scim_client" | "workload" | "system";
export type AuditOutcome = "allowed" | "denied" | "succeeded" | "failed";

/**
 * Audit details are intentionally restricted to JSON primitives. Credentials,
 * request bodies, ciphertext, personal profile objects, and caught exceptions
 * must never be copied wholesale into the security log.
 */
export type AuditDetails = Record<string, string | number | boolean | null>;

export interface AuditEventInput {
  actor: {
    type: AuditActorType;
    id: string;
  };
  organizationId?: string;
  action: string;
  resource: {
    type: string;
    id?: string;
  };
  outcome: AuditOutcome;
  reasonCode: string;
  details?: AuditDetails;
}

export interface AuditEvent extends AuditEventInput {
  id: string;
  sequence: number;
  occurredAt: Date;
}

/**
 * Security-sensitive services depend only on this append operation. They do
 * not receive generic UPDATE/DELETE access to the evidence store.
 */
export interface AuditRecorder {
  assertReady(): Promise<void>;
  record(event: AuditEventInput): Promise<void>;
}

export interface AuditRepository extends AuditRecorder {
  listForOrganization(
    organizationId: string,
    limit: number,
    beforeSequence?: number,
  ): Promise<AuditEvent[]>;
}

export interface AuditApplicationService {
  listOrganizationEvents(
    actorUserId: string,
    organizationId: string,
    limit: number,
    beforeSequence?: number,
  ): Promise<AuditEvent[]>;
}
