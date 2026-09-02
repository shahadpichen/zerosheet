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

export type AuthenticatedUser = z.infer<typeof AuthenticatedUserSchema>;
export type AuthSessionResponse = z.infer<typeof AuthSessionResponseSchema>;
export type AuthenticationErrorResponse = z.infer<
  typeof AuthenticationErrorResponseSchema
>;
