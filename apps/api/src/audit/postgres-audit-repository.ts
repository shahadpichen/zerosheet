import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { AuditEvent, AuditEventInput, AuditRepository } from "./types.js";

interface AuditEventRow {
  sequence: string;
  id: string;
  occurred_at: Date;
  actor_type: AuditEvent["actor"]["type"];
  actor_id: string;
  organization_id: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  outcome: AuditEvent["outcome"];
  reason_code: string;
  details: AuditEvent["details"];
}

/**
 * PostgreSQL supplies monotonically ordered, append-only security evidence.
 * UUIDs make events safe to correlate across exports, while the identity
 * sequence provides stable cursor pagination without offset races.
 */
export class PostgresAuditRepository implements AuditRepository {
  public constructor(
    private readonly pool: Pool,
    private readonly now: () => Date = () => new Date(),
    private readonly id: () => string = randomUUID,
  ) {}

  public async assertReady(): Promise<void> {
    const result = await this.pool.query<{ present: boolean }>(
      `
        SELECT EXISTS (
          SELECT 1 FROM schema_migrations
          WHERE version = '004_enterprise_lifecycle_audit'
        ) AS present
      `,
    );

    if (result.rows[0]?.present !== true) {
      throw new Error(
        "The enterprise lifecycle migration is missing; run pnpm infra:db:migrate",
      );
    }
  }

  public async record(event: AuditEventInput): Promise<void> {
    await this.pool.query(
      `
        INSERT INTO security_audit_events (
          id,
          occurred_at,
          actor_type,
          actor_id,
          organization_id,
          action,
          resource_type,
          resource_id,
          outcome,
          reason_code,
          details
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
      `,
      [
        this.id(),
        this.now(),
        event.actor.type,
        event.actor.id,
        event.organizationId ?? null,
        event.action,
        event.resource.type,
        event.resource.id ?? null,
        event.outcome,
        event.reasonCode,
        JSON.stringify(event.details ?? {}),
      ],
    );
  }

  public async listForOrganization(
    organizationId: string,
    limit: number,
    beforeSequence?: number,
  ): Promise<AuditEvent[]> {
    const result = await this.pool.query<AuditEventRow>(
      `
        SELECT
          sequence,
          id,
          occurred_at,
          actor_type,
          actor_id,
          organization_id,
          action,
          resource_type,
          resource_id,
          outcome,
          reason_code,
          details
        FROM security_audit_events
        WHERE organization_id = $1
          AND ($2::bigint IS NULL OR sequence < $2)
        ORDER BY sequence DESC
        LIMIT $3
      `,
      [organizationId, beforeSequence ?? null, limit],
    );

    return result.rows.map((row) => ({
      id: row.id,
      sequence: Number(row.sequence),
      occurredAt: row.occurred_at,
      actor: { type: row.actor_type, id: row.actor_id },
      ...(row.organization_id ? { organizationId: row.organization_id } : {}),
      action: row.action,
      resource: {
        type: row.resource_type,
        ...(row.resource_id ? { id: row.resource_id } : {}),
      },
      outcome: row.outcome,
      reasonCode: row.reason_code,
      details: row.details ?? {},
    }));
  }
}
