import { readFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";

import { createSpiffeCheckServerIdentity } from "@zerosheet/workload-identity";

/**
 * This negative control trusts SPIRE's public CA and validates the API's exact
 * SPIFFE ID, but intentionally supplies no client SVID. The server must reject
 * the TLS handshake; receiving any HTTP response means mutual authentication
 * was accidentally weakened to ordinary one-way TLS.
 */
async function expectMutualTlsRejection(): Promise<void> {
  const host = process.env.ZEROSHEET_INTERNAL_MTLS_SERVER ?? "mtls-api";
  const port = Number.parseInt(
    process.env.ZEROSHEET_INTERNAL_MTLS_PORT ?? "3443",
    10,
  );
  const expectedServerSpiffeId =
    process.env.ZEROSHEET_EXPECTED_API_SPIFFE_ID ??
    "spiffe://zerosheet.internal/workload/api";
  const bundlePath =
    process.env.ZEROSHEET_SPIFFE_BUNDLE_FILE ??
    "/run/spire/bootstrap/bundle.pem";
  const ca = await readFile(bundlePath, "utf8");

  await new Promise<void>((resolve, reject) => {
    let timedOut = false;
    const request = httpsRequest(
      {
        host,
        port,
        path: "/internal/reconciliation-tick",
        method: "POST",
        ca,
        minVersion: "TLSv1.3",
        rejectUnauthorized: true,
        checkServerIdentity: createSpiffeCheckServerIdentity(
          expectedServerSpiffeId,
        ),
        agent: false,
      },
      (response) => {
        response.resume();
        reject(
          new Error(
            `Server returned HTTP ${response.statusCode ?? 0} without a client SVID.`,
          ),
        );
      },
    );

    request.setTimeout(5_000, () => {
      timedOut = true;
      request.destroy(new Error("Unauthenticated TLS probe timed out."));
    });
    request.on("error", (error: NodeJS.ErrnoException) => {
      // A timeout or routing/DNS failure does not prove that client
      // certificates are required. Accept only TLS-layer rejection codes (and
      // connection reset, which some OpenSSL/platform combinations report).
      if (
        !timedOut &&
        (error.code?.startsWith("ERR_SSL_") === true ||
          error.code === "ECONNRESET")
      ) {
        resolve();
        return;
      }
      reject(new Error("Missing-certificate probe failed before TLS policy."));
    });
    request.end();
  });

  console.log(
    JSON.stringify({
      event: "missing_client_certificate_rejected",
      expectedServer: expectedServerSpiffeId,
    }),
  );
}

await expectMutualTlsRejection().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      event: "missing_client_certificate_probe_failed",
      errorType: error instanceof Error ? error.name : "UnknownError",
    }),
  );
  process.exitCode = 1;
});
