import { describe, expect, it, vi } from "vitest";

import {
  SpiffeX509Source,
  type WorkloadX509Credentials,
  type X509Update,
} from "./x509-source.js";

const expectedSpiffeId = "spiffe://zerosheet.internal/workload/api";
/** Unit tests use opaque placeholder PEM strings; the live verifier exercises
 * real SPIRE DER decoding and an actual TLS handshake. */
function fakeCredentials(serial: string, now: number): WorkloadX509Credentials {
  return {
    spiffeId: expectedSpiffeId,
    certificateChainPem: `certificate-${serial}`,
    privateKeyPem: "test-private-key-is-never-passed-to-tls",
    trustBundlePem: "trust-bundle",
    notBeforeEpochMs: now - 1_000,
    notAfterEpochMs: now + 60_000,
    certificateSerialNumber: serial,
  };
}

describe("SpiffeX509Source", () => {
  it("publishes a streamed rotation and returns only the latest credential", async () => {
    const now = 1_000_000;
    let releaseRotation!: () => void;
    const rotationGate = new Promise<void>((resolve) => {
      releaseRotation = resolve;
    });
    const updates: X509Update[] = [{ svids: [] }, { svids: [] }];
    const decoder = vi
      .fn()
      .mockReturnValueOnce(fakeCredentials("first", now))
      .mockReturnValueOnce(fakeCredentials("second", now));

    const source = new SpiffeX509Source({
      expectedSpiffeId,
      clock: () => now,
      decoder,
      streamFactory: async function* () {
        yield updates[0] as X509Update;
        await rotationGate;
        yield updates[1] as X509Update;
      },
    });
    const receivedSerials: string[] = [];
    source.onUpdate((credentials) => {
      receivedSerials.push(credentials.certificateSerialNumber);
    });

    await source.start();
    expect(source.currentCredentials().certificateSerialNumber).toBe("first");

    releaseRotation();
    await vi.waitFor(() => {
      expect(source.currentCredentials().certificateSerialNumber).toBe(
        "second",
      );
    });

    expect(receivedSerials).toEqual(["first", "second"]);
    await source.stop();
  });

  it("fails startup closed when the first Workload API update is invalid", async () => {
    const source = new SpiffeX509Source({
      expectedSpiffeId,
      decoder: () => {
        throw new Error("invalid test update");
      },
      streamFactory: async function* () {
        // Preserve the asynchronous boundary of the real gRPC stream even
        // though this failure fixture has an immediately available update.
        await Promise.resolve();
        yield { svids: [] };
      },
    });

    await expect(source.start()).rejects.toThrow("invalid test update");
    await source.stop();
  });

  it("refuses to return an expired credential", async () => {
    const now = 1_000_000;
    const source = new SpiffeX509Source({
      expectedSpiffeId,
      clock: () => now,
      decoder: () => ({
        ...fakeCredentials("expired", now),
        notAfterEpochMs: now,
      }),
      streamFactory: async function* () {
        // Match the real stream's asynchronous delivery for this single-item
        // expiry fixture.
        await Promise.resolve();
        yield { svids: [] };
      },
    });

    await source.start();
    expect(() => source.currentCredentials()).toThrow("not valid now");
    await source.stop();
  });
});
