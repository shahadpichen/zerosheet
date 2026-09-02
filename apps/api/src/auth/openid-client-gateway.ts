import * as client from "openid-client";
import type { OidcConfig } from "../config.js";
import type {
  ExternalIdentityProfile,
  IdentityProviderHint,
  OidcGateway,
  PendingOidcAuthorization,
  StoredLoginTransaction,
} from "./types.js";

/**
 * Discovery retrieves Keycloak's authorization, token, logout, and JWKS
 * endpoints from the realm issuer. `openid-client` then owns protocol parsing,
 * signature verification, issuer/audience validation, PKCE, state, and nonce
 * checks. Reimplementing those security-sensitive standards ourselves would be
 * both harder to audit and easier to get subtly wrong.
 */
export async function createOpenIdClientGateway(
  settings: OidcConfig,
): Promise<OidcGateway> {
  const discoveryOptions: client.DiscoveryRequestOptions | undefined =
    settings.allowInsecureHttp
      ? {
          // openid-client refuses HTTP by default. This explicit escape hatch is
          // set only after config.ts proves the issuer is loopback and the
          // process is not production.
          execute: [client.allowInsecureRequests],
        }
      : undefined;
  const configuration = await client.discovery(
    settings.issuerUrl,
    settings.clientId,
    settings.clientSecret,
    undefined,
    discoveryOptions,
  );

  return new OpenIdClientGateway(configuration, settings);
}

class OpenIdClientGateway implements OidcGateway {
  public constructor(
    private readonly configuration: client.Configuration,
    private readonly settings: OidcConfig,
  ) {}

  public async createAuthorizationRequest(
    identityProviderHint?: IdentityProviderHint,
  ): Promise<PendingOidcAuthorization> {
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
    };

    /**
     * `kc_idp_hint` is a Keycloak broker extension. It asks Keycloak to start
     * with a named upstream provider, but it does not bypass Keycloak's broker
     * callback, first-login flow, account-linking checks, or token issuance.
     * ZeroSheet still validates only the Keycloak issuer.
     */
    if (identityProviderHint) {
      authorizationParameters.kc_idp_hint = identityProviderHint;
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
      typeof claims.email !== "string"
    ) {
      throw new Error("The verified ID token is missing required user claims");
    }

    const displayName = this.displayName(claims, claims.email);

    return {
      issuer: this.configuration.serverMetadata().issuer,
      subject: claims.sub,
      email: claims.email,
      emailVerified: claims.email_verified === true,
      displayName,
    };
  }

  public createLogoutUrl(): URL {
    /**
     * `buildEndSessionUrl` adds the registered client identifier. Keycloak can
     * therefore validate the post-logout destination even though ZeroSheet does
     * not persist the ID token after creating its own opaque session.
     */
    return client.buildEndSessionUrl(this.configuration, {
      post_logout_redirect_uri: this.settings.postLogoutRedirectUrl.href,
    });
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
