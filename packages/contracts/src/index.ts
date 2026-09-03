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

export const WorkbookRecipientKeyParametersSchema = z.object({
  workbookId: z.string().uuid(),
  userId: z.string().uuid(),
});

export const WorkbookRotationParametersSchema = z.object({
  workbookId: z.string().uuid(),
  toKeyVersion: z.coerce.number().int().min(2).max(2_147_483_647),
});

export const EncryptionIdentityVersionParametersSchema = z.object({
  keyVersion: z.coerce.number().int().min(1).max(2_147_483_647),
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

/**
 * The HPKE identifiers below are persisted protocol constants, not caller-
 * selected algorithms. Accepting only version 1 prevents downgrade or
 * algorithm-confusion input from entering the public-key directory.
 */
export const UserPublicEncryptionKeySchema = z
  .object({
    formatVersion: z.literal(1),
    keyVersion: z.number().int().min(1).max(2_147_483_647),
    suite: z.literal("DHKEM_P256_HKDF_SHA256_HKDF_SHA256_AES_256_GCM"),
    publicKey: z.string().regex(/^[A-Za-z0-9_-]{80,100}$/u),
    fingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
  })
  .strict();

export const WorkbookKeyEnvelopeSchema = z
  .object({
    formatVersion: z.literal(1),
    suite: z.literal("DHKEM_P256_HKDF_SHA256_HKDF_SHA256_AES_256_GCM"),
    workbookKeyVersion: z.number().int().min(1).max(2_147_483_647),
    recipientKeyVersion: z.number().int().min(1).max(2_147_483_647),
    recipientFingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
    encapsulatedKey: z.string().regex(/^[A-Za-z0-9_-]{80,100}$/u),
    ciphertext: z.string().regex(/^[A-Za-z0-9_-]{60,80}$/u),
  })
  .strict();

/**
 * The encrypted backup is base64url transport for a phrase-protected Capsule.
 * The server stores it opaquely and never accepts or returns the recovery
 * phrase. The generous string limit represents the 256 KiB decoded cap.
 */
export const RegisterEncryptionIdentityInputSchema = z
  .object({
    publicKey: UserPublicEncryptionKeySchema,
    encryptedPrivateKeyBackup: z
      .string()
      .regex(/^[A-Za-z0-9_-]+$/u)
      .max(349_526),
  })
  .strict();

export const EncryptionIdentityResponseSchema = z.object({
  userId: z.string().uuid(),
  publicKey: UserPublicEncryptionKeySchema,
  encryptedPrivateKeyBackup: z.string().regex(/^[A-Za-z0-9_-]+$/u),
});

export const RecipientEncryptionKeyResponseSchema = z.object({
  userId: z.string().uuid(),
  email: z.string().email(),
  publicKey: UserPublicEncryptionKeySchema,
});

export const InitializeWorkbookEncryptionInputSchema = z
  .object({
    googleSpreadsheetId: z.string().regex(/^[A-Za-z0-9_-]{10,256}$/u),
    googleSheetId: z.number().int().min(0).max(2_147_483_647),
    googleSheetTitle: z.string().min(1).max(100),
    creatorEnvelope: WorkbookKeyEnvelopeSchema,
  })
  .strict();

export const SecureWorkbookShareInputSchema = z
  .object({
    role: z.enum(["editor", "viewer"]),
    googlePermissionId: z.string().regex(/^[A-Za-z0-9_-]{3,256}$/u),
    recipientEnvelope: WorkbookKeyEnvelopeSchema,
  })
  .strict();

export const WorkbookEncryptionAccessResponseSchema = z.object({
  workbookId: z.string().uuid(),
  googleSpreadsheetId: z.string(),
  googleSheetId: z.number().int().min(0),
  googleSheetTitle: z.string().min(1).max(100),
  activeKeyVersion: z.number().int().min(1),
  envelope: WorkbookKeyEnvelopeSchema,
  pendingRotation: z
    .object({
      toKeyVersion: z.number().int().min(2),
      envelope: WorkbookKeyEnvelopeSchema,
    })
    .nullable(),
});

export const WorkbookEncryptionStateResponseSchema = z.object({
  workbookId: z.string().uuid(),
  googleSpreadsheetId: z.string(),
  googleSheetId: z.number().int().min(0),
  googleSheetTitle: z.string().min(1).max(100),
  activeKeyVersion: z.number().int().min(1),
  rotationState: z.enum(["active", "rotation_pending"]),
  pendingKeyVersion: z.number().int().min(2).nullable(),
});

export const StageWorkbookRotationInputSchema = z
  .object({
    revokedUserId: z.string().uuid(),
    toKeyVersion: z.number().int().min(2).max(2_147_483_647),
    remainingRecipientEnvelopes: z
      .array(
        z.object({
          userId: z.string().uuid(),
          envelope: WorkbookKeyEnvelopeSchema,
        }),
      )
      .min(1)
      .max(10_000),
  })
  .strict();

export const WorkbookRotationResponseSchema = z.object({
  workbookId: z.string().uuid(),
  fromKeyVersion: z.number().int().min(1),
  toKeyVersion: z.number().int().min(2),
  revokedUserId: z.string().uuid(),
  state: z.enum(["pending", "committed"]),
});

export const WorkbookRotationPlanResponseSchema = z.object({
  workbookId: z.string().uuid(),
  fromKeyVersion: z.number().int().min(1),
  toKeyVersion: z.number().int().min(2),
  revokedUserId: z.string().uuid(),
  rotationState: z.enum(["new", "pending"]),
  googlePermissionId: z.string().regex(/^[A-Za-z0-9_-]{3,256}$/u),
  remainingRecipients: z.array(RecipientEncryptionKeyResponseSchema).min(1),
});

/**
 * An owner-assisted provider audit compares this server-side expectation with
 * Google Drive's live permission list in the browser. It contains no envelope,
 * key material, or token. The owner already has sharing-management permission
 * and needs the address to decide whether an unmanaged Google grant is
 * intentional; the response remains `no-store` at the route boundary.
 */
export const WorkbookSharingAuditExpectationResponseSchema = z.object({
  workbookId: z.string().uuid(),
  googleSpreadsheetId: z.string().regex(/^[A-Za-z0-9_-]{10,256}$/u),
  expectedPermissions: z
    .array(
      z.object({
        userId: z.string().uuid(),
        email: z.string().email(),
        role: z.enum(["editor", "viewer"]),
        googlePermissionId: z.string().regex(/^[A-Za-z0-9_-]{3,256}$/u),
      }),
    )
    .max(10_000),
});

/**
 * Google storage status never returns a Google account token or provider user
 * profile. The browser only needs to know whether the independent Drive grant
 * exists and whether its required narrow scopes are still recorded.
 */
export const GoogleStorageConnectionStatusSchema = z.discriminatedUnion(
  "connected",
  [
    z.object({
      configured: z.boolean(),
      connected: z.literal(false),
      requiredScopes: z.array(z.string().url()).length(2),
    }),
    z.object({
      configured: z.literal(true),
      connected: z.literal(true),
      requiredScopes: z.array(z.string().url()).length(2),
      grantedScopes: z.array(z.string().url()).min(2).max(16),
      connectedAt: z.string().datetime(),
    }),
  ],
);

/**
 * A forced refresh is allowed only after the browser receives 401 from Google.
 * Keeping this as a strict body prevents arbitrary OAuth parameters from being
 * reflected into the provider token request.
 */
export const GoogleStorageAccessTokenRequestSchema = z
  .object({
    forceRefresh: z.boolean().optional().default(false),
  })
  .strict();

/**
 * This short-lived bearer token is the only Google credential browser code may
 * receive. It must remain in memory and every response carrying it is no-store.
 * Refresh tokens and client secrets never cross the BFF boundary.
 */
export const GoogleStorageAccessTokenResponseSchema = z.object({
  accessToken: z.string().min(1).max(8_192),
  expiresAt: z.string().datetime(),
});

export const GoogleStorageErrorResponseSchema = z.object({
  error: z.enum([
    "not_configured",
    "connection_required",
    "oauth_failed",
    "invalid_request",
    "forbidden_origin",
    "google_unavailable",
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
export type UserPublicEncryptionKey = z.infer<
  typeof UserPublicEncryptionKeySchema
>;
export type WorkbookKeyEnvelope = z.infer<typeof WorkbookKeyEnvelopeSchema>;
export type RegisterEncryptionIdentityInput = z.infer<
  typeof RegisterEncryptionIdentityInputSchema
>;
export type EncryptionIdentityResponse = z.infer<
  typeof EncryptionIdentityResponseSchema
>;
export type RecipientEncryptionKeyResponse = z.infer<
  typeof RecipientEncryptionKeyResponseSchema
>;
export type InitializeWorkbookEncryptionInput = z.infer<
  typeof InitializeWorkbookEncryptionInputSchema
>;
export type SecureWorkbookShareInput = z.infer<
  typeof SecureWorkbookShareInputSchema
>;
export type WorkbookEncryptionAccessResponse = z.infer<
  typeof WorkbookEncryptionAccessResponseSchema
>;
export type WorkbookEncryptionStateResponse = z.infer<
  typeof WorkbookEncryptionStateResponseSchema
>;
export type StageWorkbookRotationInput = z.infer<
  typeof StageWorkbookRotationInputSchema
>;
export type WorkbookRotationResponse = z.infer<
  typeof WorkbookRotationResponseSchema
>;
export type WorkbookRotationPlanResponse = z.infer<
  typeof WorkbookRotationPlanResponseSchema
>;
export type WorkbookSharingAuditExpectationResponse = z.infer<
  typeof WorkbookSharingAuditExpectationResponseSchema
>;
export type GoogleStorageConnectionStatus = z.infer<
  typeof GoogleStorageConnectionStatusSchema
>;
export type GoogleStorageAccessTokenResponse = z.infer<
  typeof GoogleStorageAccessTokenResponseSchema
>;
export type GoogleStorageErrorResponse = z.infer<
  typeof GoogleStorageErrorResponseSchema
>;
