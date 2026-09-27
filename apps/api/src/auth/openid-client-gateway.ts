import * as client from "openid-client";
import type { GoogleOAuthClientConfig, OidcConfig } from "../config.js";
import {
  GOOGLE_STORAGE_SCOPES,
  requireGoogleStorageGrant,
} from "../google-storage/consent.js";
import type {
  VerifiedOidcLogin,
  OidcGateway,
  PendingOidcAuthorization,
  StoredLoginTransaction,
} from "./types.js";

/**
 * Discovery retrieves Google's authorization, token, and JWKS endpoints from
 * its fixed issuer. `openid-client` then owns protocol parsing, signature
 * verification, issuer/audience validation, PKCE, state, and nonce checks.
 * Reimplementing those security-sensitive standards ourselves would be both
 * harder to audit and easier to get subtly wrong.
 */
export async function createOpenIdClientGateway(
  googleClient: GoogleOAuthClientConfig,
  settings: OidcConfig,
): Promise<OidcGateway> {
  const configuration = await client.discovery(
    settings.issuerUrl,
    googleClient.clientId,
    googleClient.clientSecret,
  );

  return new OpenIdClientGateway(configuration, settings);
}

class OpenIdClientGateway implements OidcGateway {
  public constructor(
    private readonly configuration: client.Configuration,
    private readonly settings: OidcConfig,
  ) {}

  public async createAuthorizationRequest(): Promise<PendingOidcAuthorization> {
    const state = client.randomState();
    const nonce = client.randomNonce();
    const codeVerifier = client.randomPKCECodeVerifier();
    const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);

    const authorizationParameters: Record<string, string> = {
      response_type: "code",
      redirect_uri: this.settings.callbackUrl.href,
      scope: this.requestedScopes().join(" "),
      state,
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      /**
       * A local ZeroSheet logout intentionally does not sign the person out of
       * their whole Google account. Showing the chooser on the next login lets
       * them select a different account without requiring a Google-wide logout.
       */
      prompt: "select_account",
    };

    if (this.settings.connectStorageOnLogin) {
      // One Google visit establishes identity and durable storage authority.
      // Explicit consent requests a fresh refresh token even for an existing
      // Google grant. This deliberately shows consent on login; it avoids
      // reusing an old token tied to another account/client after migration.
      authorizationParameters.access_type = "offline";
      authorizationParameters.include_granted_scopes = "true";
      authorizationParameters.prompt = "select_account consent";
    }

    /**
     * Google's `hd` request parameter narrows the account chooser, but request
     * parameters are never authorization evidence. The callback validates the
     * signed `hd` claim again before creating a ZeroSheet session.
     */
    if (this.settings.hostedDomain) {
      authorizationParameters.hd = this.settings.hostedDomain;
    }

    const authorizationUrl = client.buildAuthorizationUrl(
      this.configuration,
      authorizationParameters,
    );

    return {
      authorizationUrl,
      state,
      nonce,
      codeVerifier,
    };
  }

  public async exchangeAuthorizationCode(
    callbackUrl: URL,
    transaction: StoredLoginTransaction,
  ): Promise<VerifiedOidcLogin> {
    const tokens = await client.authorizationCodeGrant(
      this.configuration,
      callbackUrl,
      {
        expectedState: transaction.state,
        expectedNonce: transaction.nonce,
        pkceCodeVerifier: transaction.codeVerifier,
        idTokenExpected: true,
      },
    );
    const claims = tokens.claims();

    /**
     * A validly signed token can still be unusable for this product if it lacks
     * a stable subject or email. The library validates the cryptographic and
     * protocol claims; this block validates ZeroSheet's data requirements.
     */
    if (
      !claims ||
      typeof claims.sub !== "string" ||
      typeof claims.email !== "string" ||
      claims.email_verified !== true
    ) {
      throw new Error("The verified ID token is missing required user claims");
    }

    if (
      this.settings.hostedDomain &&
      (typeof claims.hd !== "string" ||
        claims.hd.toLowerCase() !== this.settings.hostedDomain)
    ) {
      throw new Error(
        "The verified Google account does not belong to the required Workspace domain",
      );
    }

    const displayName = this.displayName(claims, claims.email);

    const identity = {
      issuer: this.configuration.serverMetadata().issuer,
      subject: claims.sub,
      email: claims.email,
      emailVerified: true,
      displayName,
    };

    if (!this.settings.connectStorageOnLogin) return { identity };

    // These tokens and the ID token came from the SAME code exchange. Only
    // project the storage grant after verifying the identity and hosted domain.
    // OAuth allows scope omission when unchanged; an explicit list always wins
    // so a user declining one permission cannot be treated as fully connected.
    const storageGrant = {
      accessToken: tokens.access_token,
      expiresInSeconds: tokens.expires_in ?? 0,
      ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
      grantedScopes:
        tokens.scope === undefined
          ? this.requestedScopes()
          : tokens.scope.split(/\s+/u).filter(Boolean),
    };
    requireGoogleStorageGrant(storageGrant);
    return { identity, storageGrant };
  }

  private requestedScopes(): string[] {
    return [
      "openid",
      "email",
      "profile",
      ...(this.settings.connectStorageOnLogin ? GOOGLE_STORAGE_SCOPES : []),
    ];
  }

  private displayName(
    claims: ReturnType<client.TokenEndpointResponseHelpers["claims"]> & object,
    email: string,
  ): string {
    if (typeof claims.name === "string" && claims.name.trim()) {
      return claims.name.trim();
    }

    if (
      typeof claims.preferred_username === "string" &&
      claims.preferred_username.trim()
    ) {
      return claims.preferred_username.trim();
    }

    return email;
  }
}
