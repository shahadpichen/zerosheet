import { z } from "zod";

export const HealthResponseSchema = z.object({
  service: z.literal("zerosheet-api"),
  status: z.literal("ok"),
});

export type HealthResponse = z.infer<typeof HealthResponseSchema>;

/**
 * This is the deliberately small identity projection that ZeroSheet returns to
 * its own browser. It contains product-facing data only; Keycloak access
 * tokens, refresh tokens, password credentials, and raw OIDC claims must never
 * cross the BFF boundary into browser JavaScript.
 */
export const AuthenticatedUserSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  displayName: z.string().min(1),
});

/**
 * A discriminated response lets the web application narrow the type by reading
 * `authenticated`. Returning the anonymous shape with HTTP 401 is intentional:
 * it is a normal session state, not an exception containing implementation
 * details about cookies, PostgreSQL, or Keycloak.
 */
export const AuthSessionResponseSchema = z.discriminatedUnion("authenticated", [
  z.object({
    authenticated: z.literal(true),
    user: AuthenticatedUserSchema,
  }),
  z.object({
    authenticated: z.literal(false),
  }),
]);

/**
 * Authentication errors are intentionally generic at the HTTP boundary. The
 * server may know whether a state value, transaction cookie, authorization
 * code, or nonce failed, but revealing that distinction helps attackers probe
 * the flow and does not help an end user recover.
 */
export const AuthenticationErrorResponseSchema = z.object({
  error: z.literal("authentication_failed"),
  message: z.string().min(1),
});

/**
 * The first PEP route returns only a non-sensitive proof that authorization
 * succeeded. Real workbook metadata and encrypted content arrive in later
 * product milestones, but they will reuse this fixed permission boundary.
 */
export const WorkbookAccessResponseSchema = z.object({
  workbookId: z.string().uuid(),
  permission: z.literal("can_view"),
  allowed: z.literal(true),
});

export const WorkbookParametersSchema = z.object({
  workbookId: z.string().uuid(),
});

export const AuthorizationDeniedResponseSchema = z.object({
  error: z.literal("forbidden"),
  message: z.string().min(1),
});

export const InvalidWorkbookResponseSchema = z.object({
  error: z.literal("invalid_workbook_id"),
  message: z.string().min(1),
});

/**
 * Product lifecycle inputs are intentionally narrow. OpenFGA tuple strings,
 * owner roles, authorization states, and creator IDs are never accepted from
 * the browser; the API derives all of them from the authenticated operation.
 */
export const NamedResourceInputSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
  })
  .strict();

export const OrganizationParametersSchema = z.object({
  organizationId: z.string().uuid(),
});

export const OrganizationMemberParametersSchema = z.object({
  organizationId: z.string().uuid(),
  userId: z.string().uuid(),
});

export const TeamParametersSchema = z.object({
  teamId: z.string().uuid(),
});

export const TeamMemberParametersSchema = z.object({
  teamId: z.string().uuid(),
  userId: z.string().uuid(),
});

export const WorkbookShareParametersSchema = z.object({
  workbookId: z.string().uuid(),
  principalId: z.string().uuid(),
});

export const OrganizationMemberInputSchema = z
  .object({
    role: z.enum(["admin", "member"]),
  })
  .strict();

export const TeamMemberInputSchema = z
  .object({
    role: z.enum(["manager", "member"]),
  })
  .strict();

export const WorkbookShareInputSchema = z
  .object({
    role: z.enum(["editor", "viewer"]),
  })
  .strict();

export const OrganizationResponseSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(200),
});

export const TeamResponseSchema = z.object({
  id: z.string().uuid(),
  organizationId: z.string().uuid(),
  name: z.string().min(1).max(200),
});

export const WorkbookResponseSchema = z.object({
  id: z.string().uuid(),
  organizationId: z.string().uuid(),
  name: z.string().min(1).max(200),
  createdBy: z.string().uuid(),
});

export const OrganizationMembershipResponseSchema = z.object({
  organizationId: z.string().uuid(),
  userId: z.string().uuid(),
  role: z.enum(["owner", "admin", "member"]),
});

export const TeamMembershipResponseSchema = z.object({
  teamId: z.string().uuid(),
  userId: z.string().uuid(),
  role: z.enum(["manager", "member"]),
});

export const WorkbookShareResponseSchema = z.object({
  workbookId: z.string().uuid(),
  principal: z.discriminatedUnion("type", [
    z.object({ type: z.literal("user"), id: z.string().uuid() }),
    z.object({ type: z.literal("team"), id: z.string().uuid() }),
  ]),
  role: z.enum(["editor", "viewer"]),
});

export const ProductErrorResponseSchema = z.object({
  error: z.enum([
    "invalid_request",
    "forbidden",
    "not_found",
    "conflict",
    "authorization_unavailable",
  ]),
  message: z.string().min(1),
});

export type AuthenticatedUser = z.infer<typeof AuthenticatedUserSchema>;
export type AuthSessionResponse = z.infer<typeof AuthSessionResponseSchema>;
export type AuthenticationErrorResponse = z.infer<
  typeof AuthenticationErrorResponseSchema
>;
export type WorkbookAccessResponse = z.infer<
  typeof WorkbookAccessResponseSchema
>;
export type AuthorizationDeniedResponse = z.infer<
  typeof AuthorizationDeniedResponseSchema
>;
export type OrganizationResponse = z.infer<typeof OrganizationResponseSchema>;
export type TeamResponse = z.infer<typeof TeamResponseSchema>;
export type WorkbookResponse = z.infer<typeof WorkbookResponseSchema>;
export type OrganizationMembershipResponse = z.infer<
  typeof OrganizationMembershipResponseSchema
>;
export type TeamMembershipResponse = z.infer<
  typeof TeamMembershipResponseSchema
>;
export type WorkbookShareResponse = z.infer<typeof WorkbookShareResponseSchema>;
export type ProductErrorResponse = z.infer<typeof ProductErrorResponseSchema>;
