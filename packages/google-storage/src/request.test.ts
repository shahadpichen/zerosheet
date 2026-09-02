import { describe, expect, it, vi } from "vitest";
import { MemoryGoogleAccessTokenProvider } from "./access-token-provider.js";
import { GoogleStorageError } from "./errors.js";
import { AuthorizedGoogleRequest } from "./request.js";
import type { GoogleAccessTokenProvider } from "./types.js";

class RecordingTokenProvider implements GoogleAccessTokenProvider {
  public readonly forced: boolean[] = [];
  public cleared = false;

  public getAccessToken(options: { forceRefresh?: boolean } = {}) {
    const forceRefresh = options.forceRefresh === true;
    this.forced.push(forceRefresh);
    return Promise.resolve({
      value: forceRefresh ? "refreshed-access-token" : "first-access-token",
      expiresAt: new Date("2026-09-03T02:00:00.000Z"),
    });
  }

  public clear(): void {
    this.cleared = true;
  }
}

describe("MemoryGoogleAccessTokenProvider", () => {
  it("deduplicates concurrent fetches and keeps usable tokens in memory", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchToken = vi.fn(async () => {
      await gate;
      return {
        value: "short-lived-google-token",
        expiresAt: new Date("2026-09-03T01:10:00.000Z"),
      };
    });
    const provider = new MemoryGoogleAccessTokenProvider({
      fetchToken,
      now: () => new Date("2026-09-03T01:00:00.000Z"),
    });

    const first = provider.getAccessToken();
    const second = provider.getAccessToken();
    release();

    await expect(first).resolves.toEqual(await second);
    await provider.getAccessToken();
    expect(fetchToken).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed credentials instead of persisting them", async () => {
    const provider = new MemoryGoogleAccessTokenProvider({
      fetchToken: () =>
        Promise.resolve({
          value: "token with spaces",
          expiresAt: new Date("2026-09-03T01:10:00.000Z"),
        }),
      now: () => new Date("2026-09-03T01:00:00.000Z"),
    });

    await expect(provider.getAccessToken()).rejects.toBeInstanceOf(
      GoogleStorageError,
    );
  });
});

describe("AuthorizedGoogleRequest", () => {
  it("attaches a token only to a fixed Google API origin", async () => {
    const tokens = new RecordingTokenProvider();
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(Response.json({ ok: true })),
    );
    const request = new AuthorizedGoogleRequest({
      tokens,
      fetch: fetchMock,
    });

    await request.send({ api: "drive", path: "/drive/v3/files" });

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.origin).toBe("https://www.googleapis.com");
    expect(new Headers(init.headers).get("Authorization")).toBe(
      "Bearer first-access-token",
    );
    expect(tokens.forced).toEqual([false]);
  });

  it("refreshes once after 401 and never retries a permission denial", async () => {
    const tokens = new RecordingTokenProvider();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(Response.json({ ok: true }));
    const request = new AuthorizedGoogleRequest({
      tokens,
      fetch: fetchMock,
    });

    await request.send({ api: "sheets", path: "/v4/spreadsheets/test" });

    expect(tokens.forced).toEqual([false, true]);
    const retryHeaders = new Headers(
      (fetchMock.mock.calls[1]?.[1] as RequestInit).headers,
    );
    expect(retryHeaders.get("Authorization")).toBe(
      "Bearer refreshed-access-token",
    );

    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 403 }));
    await expect(
      request.send({ api: "drive", path: "/drive/v3/files" }),
    ).rejects.toMatchObject({ code: "GOOGLE_PERMISSION_DENIED" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses an absolute or query-bearing path before reading a token", async () => {
    const tokens = new RecordingTokenProvider();
    const request = new AuthorizedGoogleRequest({ tokens });

    await expect(
      request.send({ api: "drive", path: "https://attacker.example/steal" }),
    ).rejects.toMatchObject({ code: "GOOGLE_INVALID_INPUT" });
    await expect(
      request.send({ api: "drive", path: "/drive/v3/files?alt=media" }),
    ).rejects.toMatchObject({ code: "GOOGLE_INVALID_INPUT" });
    expect(tokens.forced).toHaveLength(0);
  });
});
