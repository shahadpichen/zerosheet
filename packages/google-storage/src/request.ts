import { GoogleStorageError } from "./errors.js";
import type { GoogleAccessTokenProvider } from "./types.js";

const GOOGLE_API_ORIGINS = {
  drive: "https://www.googleapis.com",
  sheets: "https://sheets.googleapis.com",
} as const;

type GoogleApi = keyof typeof GOOGLE_API_ORIGINS;

/**
 * Callers choose a known API and relative path rather than an arbitrary URL.
 * This prevents a future UI bug from attaching a Google bearer token to an
 * attacker-controlled origin. Every retry reconstructs the Authorization
 * header from the in-memory token provider.
 */
export class AuthorizedGoogleRequest {
  readonly #tokens: GoogleAccessTokenProvider;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  public constructor(options: {
    readonly tokens: GoogleAccessTokenProvider;
    readonly fetch?: typeof fetch;
    readonly timeoutMs?: number;
  }) {
    this.#tokens = options.tokens;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#timeoutMs = options.timeoutMs ?? 30_000;

    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 1) {
      throw new GoogleStorageError("GOOGLE_INVALID_INPUT");
    }
  }

  public async send(input: {
    readonly api: GoogleApi;
    readonly path: string;
    readonly method?: "GET" | "POST" | "PATCH" | "DELETE";
    readonly query?: URLSearchParams;
    readonly headers?: HeadersInit;
    readonly body?: BodyInit;
  }): Promise<Response> {
    this.assertRelativePath(input.path);
    const url = new URL(input.path, GOOGLE_API_ORIGINS[input.api]);
    if (input.query) url.search = input.query.toString();

    const first = await this.attempt(url, input, false);
    if (first.status !== 401) {
      if (!first.ok) throw this.responseError(first.status);
      return first;
    }

    // A 401 means Google rejected the bearer credential before authorizing the
    // operation, so retry once with a freshly issued token. Permission denials
    // (403), rate limits, and arbitrary failures are never blindly repeated.
    const second = await this.attempt(url, input, true);
    if (!second.ok) {
      if (second.status === 401) this.#tokens.clear();
      throw this.responseError(second.status);
    }
    return second;
  }

  private async attempt(
    url: URL,
    input: {
      readonly method?: "GET" | "POST" | "PATCH" | "DELETE";
      readonly headers?: HeadersInit;
      readonly body?: BodyInit;
    },
    forceRefresh: boolean,
  ): Promise<Response> {
    const token = await this.#tokens.getAccessToken({ forceRefresh });
    const headers = new Headers(input.headers);
    headers.set("Authorization", `Bearer ${token.value}`);
    headers.set("Accept", "application/json");

    const controller = new AbortController();
    const timeout = globalThis.setTimeout(
      () => controller.abort(),
      this.#timeoutMs,
    );

    try {
      return await this.#fetch(url, {
        method: input.method ?? "GET",
        headers,
        ...(input.body === undefined ? {} : { body: input.body }),
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new GoogleStorageError("GOOGLE_UNAVAILABLE", { cause: error });
      }
      throw new GoogleStorageError("GOOGLE_REQUEST_FAILED", { cause: error });
    } finally {
      globalThis.clearTimeout(timeout);
    }
  }

  private assertRelativePath(path: string): void {
    if (
      !path.startsWith("/") ||
      path.startsWith("//") ||
      path.length > 2_048 ||
      path.includes("?") ||
      path.includes("#")
    ) {
      throw new GoogleStorageError("GOOGLE_INVALID_INPUT");
    }
  }

  private responseError(status: number): GoogleStorageError {
    if (status === 401) {
      return new GoogleStorageError("GOOGLE_AUTH_EXPIRED", { status });
    }
    if (status === 403) {
      return new GoogleStorageError("GOOGLE_PERMISSION_DENIED", { status });
    }
    if (status === 404) {
      return new GoogleStorageError("GOOGLE_RESOURCE_NOT_FOUND", { status });
    }
    if (status === 429) {
      return new GoogleStorageError("GOOGLE_RATE_LIMITED", { status });
    }
    if (status >= 500) {
      return new GoogleStorageError("GOOGLE_UNAVAILABLE", { status });
    }
    return new GoogleStorageError("GOOGLE_REQUEST_FAILED", { status });
  }
}
