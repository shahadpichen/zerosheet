import type { Pool } from "pg";
import type {
  OrganizationPolicyContext,
  PlatformPolicyContext,
  PolicyContextRepository,
  PolicyStatus,
} from "./types.js";

interface PlatformContextRow {
  subject_status: PolicyStatus;
}

interface OrganizationContextRow extends PlatformContextRow {
  organization_id: string;
  organization_status: PolicyStatus;
}

/**
 * PostgreSQL is ZeroSheet's Policy Information Point (PIP): it supplies fresh
 * account and tenant lifecycle facts to the decision layer. OpenFGA should not
 * own these rapidly changing operational attributes because they are not
 * relationships and administrators need one transactional source of truth.
 */
export class PostgresPolicyContextRepository implements PolicyContextRepository {
  public constructor(private readonly pool: Pool) {}

  public async assertReady(): Promise<void> {
    const result = await this.pool.query<{ present: boolean }>(
      `
        SELECT EXISTS (
          SELECT 1
          FROM schema_migrations
          WHERE version = '003_contextual_authorization_status'
        ) AS present
      `,
    );

    if (result.rows[0]?.present !== true) {
      throw new Error(
        "The contextual authorization migration is missing; run pnpm infra:db:migrate",
      );
    }
  }

  public async findPlatformContext(
    userId: string,
  ): Promise<PlatformPolicyContext | null> {
    const result = await this.pool.query<PlatformContextRow>(
      `
        SELECT account_status AS subject_status
        FROM product_users
        WHERE id = $1
      `,
      [userId],
    );
    const row = result.rows[0];

    return row ? { subject: { id: userId, status: row.subject_status } } : null;
  }

  public findOrganizationContext(
    userId: string,
    organizationId: string,
  ): Promise<OrganizationPolicyContext | null> {
    return this.findResourceContext(
      userId,
      `
        SELECT
          users.account_status AS subject_status,
          organizations.id AS organization_id,
          organizations.tenant_status AS organization_status
        FROM product_users AS users
        CROSS JOIN organizations
        WHERE users.id = $1
          AND organizations.id = $2
          AND organizations.authorization_state = 'active'
      `,
      organizationId,
    );
  }

  public findTeamContext(
    userId: string,
    teamId: string,
  ): Promise<OrganizationPolicyContext | null> {
    return this.findResourceContext(
      userId,
      `
        SELECT
          users.account_status AS subject_status,
          organizations.id AS organization_id,
          organizations.tenant_status AS organization_status
        FROM product_users AS users
        CROSS JOIN teams
        INNER JOIN organizations ON organizations.id = teams.organization_id
        WHERE users.id = $1
          AND teams.id = $2
          AND teams.authorization_state = 'active'
          AND organizations.authorization_state = 'active'
      `,
      teamId,
    );
  }

  public findWorkbookContext(
    userId: string,
    workbookId: string,
  ): Promise<OrganizationPolicyContext | null> {
    return this.findResourceContext(
      userId,
      `
        SELECT
          users.account_status AS subject_status,
          organizations.id AS organization_id,
          organizations.tenant_status AS organization_status
        FROM product_users AS users
        CROSS JOIN workbooks
        INNER JOIN organizations ON organizations.id = workbooks.organization_id
        WHERE users.id = $1
          AND workbooks.id = $2
          AND workbooks.authorization_state = 'active'
          AND organizations.authorization_state = 'active'
      `,
      workbookId,
    );
  }

  private async findResourceContext(
    userId: string,
    query: string,
    resourceId: string,
  ): Promise<OrganizationPolicyContext | null> {
    const result = await this.pool.query<OrganizationContextRow>(query, [
      userId,
      resourceId,
    ]);
    const row = result.rows[0];

    return row
      ? {
          subject: { id: userId, status: row.subject_status },
          organization: {
            id: row.organization_id,
            status: row.organization_status,
          },
        }
      : null;
  }
}
