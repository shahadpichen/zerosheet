import { z } from "zod";
import type { GoogleStorageOAuthConfig } from "../config.js";
import { GoogleStorageDependencyError } from "./errors.js";
import type {
  GoogleOAuthTokenResult,
  GoogleStorageOAuthGateway,
} from "./types.js";

const GOOGLE_AUTHORIZATION_ENDPOINT =
  "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOCATION_ENDPOINT = "https://oauth2.googleapis.com/revoke";
const GOOGLE_REQUIRED_SCOPES = [
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/drive.appdata",
] as const;
const MAX_TOKEN_RESPONSE_BYTES = 64 * 1024;

const GoogleTokenResponseSchema = z
  .object({
    access_token: z.string().min(1).max(8_192).regex(/^\S+$/u),
    expires_in: z.number().int().positive().max(604_800),
    token_type: z.string().regex(/^Bearer$/iu),
    refresh_token: z.string().min(1).max(8_192).regex(/^\S+$/u).optional(),
    scope: z.string().max(4_096).optional(),
  })
  .passthrough();

type EnabledGoogleStorageConfig = Extract<
  GoogleStorageOAuthConfig,
  { enabled: true }
>;
type GoogleOAuthEndpointConfig = Pick<
  EnabledGoogleStorageConfig,
  "callbackUrl" | "clientId" | "clientSecret"
>;

/**
 * This adapter talks only to Google's fixed OAuth endpoints. It deliberately
 * does not request identity claims: Keycloak already authenticated the person,
 * while this independent grant authorizes Drive and Sheets storage actions.
 */
export class GoogleWebServerOAuthGateway implements GoogleStorageOAuthGateway {
  readonly #config: GoogleOAuthEndpointConfig;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  public constructor(
    config: GoogleOAuthEndpointConfig,
    options: {
      readonly fetch?: typeof fetch;
      readonly timeoutMs?: number;
    } = {},
  ) {
    // Copy only OAuth endpoint settings. The runtime config also contains the
    // independent refresh-token encryption key, which this network adapter has
    // no reason to retain or access.
    this.#config = {
      callbackUrl: new URL(config.callbackUrl),
      clientId: config.clientId,
      clientSecret: config.clientSecret,
    };
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#timeoutMs = options.timeoutMs ?? 10_000;
  }

  public createAuthorizationUrl(input: {
    readonly state: string;
    readonly codeChallenge: string;
  }): URL {
    assertOpaqueValue(input.state, 32, 512);
    assertOpaqueValue(input.codeChallenge, 43, 128);
    const url = new URL(GOOGLE_AUTHORIZATION_ENDPOINT);
    url.search = new URLSearchParams({
      client_id: this.#config.clientId,
      redirect_uri: this.#config.callbackUrl.href,
      response_type: "code",
      scope: GOOGLE_REQUIRED_SCOPES.join(" "),
      access_type: "offline",
      include_granted_scopes: "true",
      // Explicit consent makes reconnect reliable after ZeroSheet has deleted
      // its old refresh token; Google otherwise may omit a replacement token.
      prompt: "consent",
      state: input.state,
      code_challenge: input.codeChallenge,
      code_challenge_method: "S256",
    }).toString();
    return url;
  }

  public async exchangeAuthorizationCode(input: {
    readonly code: string;
    readonly codeVerifier: string;
  }): Promise<GoogleOAuthTokenResult> {
    assertOpaqueValue(input.code, 1, 8_192);
    assertOpaqueValue(input.codeVerifier, 43, 128);
    const token = await this.tokenRequest(
      new URLSearchParams({
        client_id: this.#config.clientId,
        client_secret: this.#config.clientSecret,
        redirect_uri: this.#config.callbackUrl.href,
        grant_type: "authorization_code",
        code: input.code,
        code_verifier: input.codeVerifier,
      }),
    );

    // OAuth permits the token response to omit `scope` when it is identical to
    // the requested scope. An explicit returned list still wins so the service
    // can reject any partial or unexpectedly changed grant.
    return token.grantedScopes
      ? token
      : { ...token, grantedScopes: [...GOOGLE_REQUIRED_SCOPES] };
  }

  public async refreshAccessToken(
    refreshToken: string,
  ): Promise<GoogleOAuthTokenResult> {
    assertOpaqueValue(refreshToken, 1, 8_192);
    return this.tokenRequest(
      new URLSearchParams({
        client_id: this.#config.clientId,
        client_secret: this.#config.clientSecret,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
    );
  }

  public async revoke(refreshToken: string): Promise<void> {
    assertOpaqueValue(refreshToken, 1, 8_192);
    const response = await this.fixedEndpointRequest(
      GOOGLE_REVOCATION_ENDPOINT,
      new URLSearchParams({ token: refreshToken }),
    );
    if (!response.ok) throw new GoogleStorageDependencyError();
  }

  private async tokenRequest(
    body: URLSearchParams,
  ): Promise<GoogleOAuthTokenResult> {
    const response = await this.fixedEndpointRequest(
      GOOGLE_TOKEN_ENDPOINT,
      body,
    );
    if (!response.ok) throw new GoogleStorageDependencyError();

    const declaredLength = Number(response.headers.get("Content-Length"));
    if (
      Number.isFinite(declaredLength) &&
      declaredLength > MAX_TOKEN_RESPONSE_BYTES
    ) {
      throw new GoogleStorageDependencyError();
    }
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MAX_TOKEN_RESPONSE_BYTES) {
      throw new GoogleStorageDependencyError();
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      throw new GoogleStorageDependencyError();
    }
    const token = GoogleTokenResponseSchema.safeParse(parsed);
    if (!token.success) throw new GoogleStorageDependencyError();

    const grantedScopes = token.data.scope
      ? [...new Set(token.data.scope.split(/\s+/u).filter(Boolean))].sort()
      : undefined;
    return {
      accessToken: token.data.access_token,
      expiresInSeconds: token.data.expires_in,
      ...(token.data.refresh_token === undefined
        ? {}
        : { refreshToken: token.data.refresh_token }),
      ...(grantedScopes === undefined ? {} : { grantedScopes }),
    };
  }

  private async fixedEndpointRequest(
    endpoint: string,
    body: URLSearchParams,
  ): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
    timeout.unref();
    try {
      return await this.#fetch(endpoint, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body,
        signal: controller.signal,
      });
    } catch {
      throw new GoogleStorageDependencyError();
    } finally {
      clearTimeout(timeout);
    }
  }
}

function assertOpaqueValue(
  value: string,
  minimum: number,
  maximum: number,
): void {
  if (
    value.length < minimum ||
    value.length > maximum ||
    /\s/u.test(value) ||
    containsAsciiControlCharacter(value)
  ) {
    throw new GoogleStorageDependencyError();
  }
}

function containsAsciiControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) {
      return true;
    }
  }
  return false;
}
