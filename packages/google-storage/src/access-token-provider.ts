import { GoogleStorageError } from "./errors.js";
import type { GoogleAccessToken, GoogleAccessTokenProvider } from "./types.js";

const DEFAULT_MINIMUM_VALIDITY_MS = 60_000;

/**
 * Cache only the short-lived access token in this JavaScript object. A page
 * reload, account switch, explicit clear, or process crash loses it. The BFF
 * remains responsible for the encrypted refresh token and Google client
 * secret; browser storage APIs are intentionally never used here.
 */
export class MemoryGoogleAccessTokenProvider implements GoogleAccessTokenProvider {
  readonly #fetchToken: (forceRefresh: boolean) => Promise<GoogleAccessToken>;
  readonly #now: () => Date;
  readonly #minimumValidityMs: number;
  #cached: GoogleAccessToken | undefined;
  #inFlight: Promise<GoogleAccessToken> | undefined;

  public constructor(options: {
    readonly fetchToken: (forceRefresh: boolean) => Promise<GoogleAccessToken>;
    readonly now?: () => Date;
    readonly minimumValidityMs?: number;
  }) {
    this.#fetchToken = options.fetchToken;
    this.#now = options.now ?? (() => new Date());
    this.#minimumValidityMs =
      options.minimumValidityMs ?? DEFAULT_MINIMUM_VALIDITY_MS;

    if (
      !Number.isSafeInteger(this.#minimumValidityMs) ||
      this.#minimumValidityMs < 0
    ) {
      throw new GoogleStorageError("GOOGLE_INVALID_INPUT");
    }
  }

  public async getAccessToken(
    options: { readonly forceRefresh?: boolean } = {},
  ): Promise<GoogleAccessToken> {
    const forceRefresh = options.forceRefresh === true;

    if (!forceRefresh && this.isUsable(this.#cached)) {
      return this.#cached;
    }

    // If a normal request is already refreshing, every concurrent caller uses
    // the same promise. A forced refresh waits for it and then deliberately
    // performs a second request because the first token already received 401.
    if (this.#inFlight) {
      try {
        const token = await this.#inFlight;
        if (!forceRefresh && this.isUsable(token)) return token;
      } catch (error) {
        // Concurrent callers must observe the same safe failure category. A
        // network outage must not be rewritten as a missing user connection.
        if (!forceRefresh) throw error;
      }
    }

    if (forceRefresh) this.#cached = undefined;
    const request = this.#fetchToken(forceRefresh);
    this.#inFlight = request;

    try {
      const token = await request;
      this.assertToken(token);
      this.#cached = token;
      return token;
    } finally {
      if (this.#inFlight === request) this.#inFlight = undefined;
    }
  }

  public clear(): void {
    this.#cached = undefined;
  }

  private isUsable(
    token: GoogleAccessToken | undefined,
  ): token is GoogleAccessToken {
    return (
      token !== undefined &&
      token.expiresAt.getTime() - this.#now().getTime() >
        this.#minimumValidityMs
    );
  }

  private assertToken(token: GoogleAccessToken): void {
    if (
      typeof token.value !== "string" ||
      token.value.length < 1 ||
      token.value.length > 8_192 ||
      /\s/u.test(token.value) ||
      !Number.isFinite(token.expiresAt.getTime()) ||
      token.expiresAt.getTime() <= this.#now().getTime()
    ) {
      this.#cached = undefined;
      throw new GoogleStorageError("GOOGLE_INVALID_RESPONSE");
    }
  }
}
