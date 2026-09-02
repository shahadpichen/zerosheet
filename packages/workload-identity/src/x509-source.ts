import {
  createPrivateKey,
  createPublicKey,
  timingSafeEqual,
  X509Certificate,
} from "node:crypto";

import {
  createClient,
  parseCertificateBundle,
  type X509SVID,
  type X509SVIDResponse,
} from "spiffe";

import {
  assertValidSpiffeId,
  extractUriSubjectAlternativeNames,
} from "./peer-authorization.js";

/**
 * The TLS-ready representation of one X.509-SVID update. The private key is a
 * TLS-ready representation deliberately held only in process memory. The PEM
 * private key exists because Node's TLS API consumes it directly; callers must
 * never inspect, serialize, persist, or log the credentials object.
 */
export interface WorkloadX509Credentials {
  readonly spiffeId: string;
  readonly certificateChainPem: string;
  readonly privateKeyPem: string;
  readonly trustBundlePem: string;
  readonly notBeforeEpochMs: number;
  readonly notAfterEpochMs: number;
  readonly certificateSerialNumber: string;
}

/**
 * These structural types form a deliberate test seam around the third-party
 * gRPC client. The production stream still comes from the real SPIFFE Workload
 * API, while unit tests can prove update and failure behavior without starting
 * a SPIRE control plane or manufacturing private keys.
 */
export type X509Update = Pick<X509SVIDResponse, "svids">;
export type X509UpdateStreamFactory = (
  abortSignal: AbortSignal,
) => AsyncIterable<X509Update>;
export type X509UpdateDecoder = (
  update: X509Update,
  expectedSpiffeId: string,
) => WorkloadX509Credentials;

export interface SpiffeX509SourceOptions {
  readonly expectedSpiffeId: string;
  readonly endpointSocket?: string;
  readonly reconnectDelayMs?: number;
  readonly clock?: () => number;
  readonly streamFactory?: X509UpdateStreamFactory;
  readonly decoder?: X509UpdateDecoder;
  readonly onStreamError?: (error: unknown) => void;
}

/**
 * Convert one response into TLS credentials only after validating all
 * security-relevant relationships among its fields. The Workload API is local
 * and trusted, but strict parsing makes corrupt state and adapter regressions
 * fail closed instead of flowing into the TLS stack.
 */
export function decodeX509Update(
  update: X509Update,
  expectedSpiffeId: string,
): WorkloadX509Credentials {
  assertValidSpiffeId(expectedSpiffeId);

  const matchingSvids = update.svids.filter(
    (candidate) => candidate.spiffeId === expectedSpiffeId,
  );

  if (matchingSvids.length !== 1) {
    throw new Error(
      "The Workload API did not return exactly one expected SVID.",
    );
  }

  const svid = matchingSvids[0] as X509SVID;
  const certificateChain = parseCertificateBundle(svid.x509Svid);
  const trustBundle = parseCertificateBundle(svid.bundle);
  const leafCertificate = certificateChain[0];

  if (leafCertificate === undefined || trustBundle.length === 0) {
    throw new Error(
      "The Workload API returned an incomplete certificate chain.",
    );
  }

  const nativeCertificate = new X509Certificate(
    Buffer.from(leafCertificate.rawData),
  );
  const uriNames = extractUriSubjectAlternativeNames(
    nativeCertificate.subjectAltName,
  );

  if (uriNames.length !== 1 || uriNames[0] !== expectedSpiffeId) {
    throw new Error("The X.509-SVID URI SAN does not match its SPIFFE ID.");
  }

  const privateKey = createPrivateKey({
    key: Buffer.from(svid.x509SvidKey),
    format: "der",
    type: "pkcs8",
  });
  const certificatePublicKey = nativeCertificate.publicKey.export({
    format: "der",
    type: "spki",
  });
  const privateKeyPublicPart = createPublicKey(privateKey).export({
    format: "der",
    type: "spki",
  });

  if (
    certificatePublicKey.length !== privateKeyPublicPart.length ||
    !timingSafeEqual(certificatePublicKey, privateKeyPublicPart)
  ) {
    throw new Error(
      "The X.509-SVID private key does not match its certificate.",
    );
  }

  const notBeforeEpochMs = Date.parse(nativeCertificate.validFrom);
  const notAfterEpochMs = Date.parse(nativeCertificate.validTo);

  if (
    !Number.isFinite(notBeforeEpochMs) ||
    !Number.isFinite(notAfterEpochMs) ||
    notAfterEpochMs <= notBeforeEpochMs
  ) {
    throw new Error("The X.509-SVID contains an invalid validity period.");
  }

  return {
    spiffeId: expectedSpiffeId,
    certificateChainPem: certificateChain.toString("pem-chain"),
    privateKeyPem: privateKey
      .export({ format: "pem", type: "pkcs8" })
      .toString(),
    trustBundlePem: trustBundle.toString("pem-chain"),
    notBeforeEpochMs,
    notAfterEpochMs,
    certificateSerialNumber: nativeCertificate.serialNumber,
  };
}

/**
 * Keep a current X.509-SVID in memory and follow SPIRE's streamed rotations.
 * Consumers read the latest credentials for every new connection and subscribe
 * when a long-lived TLS server must replace its secure context in place.
 */
export class SpiffeX509Source {
  readonly #expectedSpiffeId: string;
  readonly #reconnectDelayMs: number;
  readonly #clock: () => number;
  readonly #streamFactory: X509UpdateStreamFactory;
  readonly #decoder: X509UpdateDecoder;
  readonly #onStreamError: (error: unknown) => void;
  readonly #abortController = new AbortController();
  readonly #listeners = new Set<
    (credentials: WorkloadX509Credentials) => void
  >();

  #current: WorkloadX509Credentials | undefined;
  #runPromise: Promise<void> | undefined;
  #readySettled = false;
  #resolveReady!: () => void;
  #rejectReady!: (error: unknown) => void;
  readonly #readyPromise: Promise<void>;

  public constructor(options: SpiffeX509SourceOptions) {
    assertValidSpiffeId(options.expectedSpiffeId);

    this.#expectedSpiffeId = options.expectedSpiffeId;
    this.#reconnectDelayMs = options.reconnectDelayMs ?? 1_000;
    this.#clock = options.clock ?? Date.now;
    this.#decoder = options.decoder ?? decodeX509Update;
    this.#onStreamError = options.onStreamError ?? (() => undefined);
    this.#streamFactory =
      options.streamFactory ??
      ((abortSignal) => {
        // The standard environment value is a `unix:///...` URI. No TCP port
        // or bearer credential is introduced for the local Workload API.
        const client = createClient(options.endpointSocket);
        return client.fetchX509SVID({}, { abort: abortSignal }).responses;
      });

    this.#readyPromise = new Promise<void>((resolve, reject) => {
      this.#resolveReady = resolve;
      this.#rejectReady = reject;
    });
  }

  /** Start watching and wait until one fully validated credential exists. */
  public async start(): Promise<void> {
    if (this.#runPromise === undefined) {
      this.#runPromise = this.#watch();
    }

    await this.#readyPromise;
  }

  /**
   * Return credentials only while currently valid. The 1-second safety margin
   * avoids starting a connection with a certificate expiring at that instant.
   */
  public currentCredentials(): WorkloadX509Credentials {
    if (this.#current === undefined) {
      throw new Error("No workload credential is available yet.");
    }

    const now = this.#clock();
    if (
      now < this.#current.notBeforeEpochMs ||
      now + 1_000 >= this.#current.notAfterEpochMs
    ) {
      throw new Error("The current workload credential is not valid now.");
    }

    return this.#current;
  }

  /**
   * Subscribe a TLS server to future rotations. The returned function removes
   * the listener and avoids retaining stopped server instances in memory.
   */
  public onUpdate(
    listener: (credentials: WorkloadX509Credentials) => void,
  ): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Stop the gRPC stream and wait for its background loop to finish. */
  public async stop(): Promise<void> {
    this.#abortController.abort();
    await this.#runPromise;
  }

  async #watch(): Promise<void> {
    while (!this.#abortController.signal.aborted) {
      try {
        const stream = this.#streamFactory(this.#abortController.signal);

        for await (const update of stream) {
          if (this.#abortController.signal.aborted) {
            return;
          }

          const credentials = this.#decoder(update, this.#expectedSpiffeId);
          this.#current = credentials;

          if (!this.#readySettled) {
            this.#readySettled = true;
            this.#resolveReady();
          }

          for (const listener of this.#listeners) {
            try {
              listener(credentials);
            } catch (error) {
              // A consumer callback must not kill credential rotation for all
              // other consumers. Report the opaque error through the supplied
              // hook and continue serving the valid update.
              this.#onStreamError(error);
            }
          }
        }

        if (!this.#abortController.signal.aborted) {
          throw new Error("The Workload API update stream ended unexpectedly.");
        }
      } catch (error) {
        if (this.#abortController.signal.aborted) {
          return;
        }

        if (!this.#readySettled) {
          this.#readySettled = true;
          this.#rejectReady(error);
          return;
        }

        // Once initialized, an existing SVID may remain usable during a short
        // agent interruption. Report the failure and reconnect; expiry checks
        // still fail closed if no fresh update arrives in time.
        this.#onStreamError(error);
        await abortableDelay(
          this.#reconnectDelayMs,
          this.#abortController.signal,
        );
      }
    }
  }
}

/** Wait between reconnects without making shutdown wait for the full delay. */
async function abortableDelay(
  durationMs: number,
  abortSignal: AbortSignal,
): Promise<void> {
  if (abortSignal.aborted) {
    return;
  }

  await new Promise<void>((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      abortSignal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, durationMs);
    abortSignal.addEventListener("abort", finish, { once: true });
  });
}
