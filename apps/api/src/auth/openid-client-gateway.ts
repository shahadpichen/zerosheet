import * as client from "openid-client";
import type { OidcConfig } from "../config.js";
import type {
  ExternalIdentityProfile,
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
  settings: OidcConfig,
): Promise<OidcGateway> {
  const configuration = await client.discovery(
    settings.issuerUrl,
    settings.clientId,
    settings.clientSecret,
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
      scope: "openid email profile",
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
  ): Promise<ExternalIdentityProfile> {
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

    return {
      issuer: this.configuration.serverMetadata().issuer,
      subject: claims.sub,
      email: claims.email,
      emailVerified: true,
      displayName,
    };
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
