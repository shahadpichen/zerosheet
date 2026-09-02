import { request as httpRequest } from "node:http";

/**
 * Attempt ordinary HTTP against the private TLS port. A reset or parse failure
 * is the expected result; receiving an HTTP response would reveal an accidental
 * plaintext listener beside the authenticated channel.
 */
async function expectPlaintextRejection(): Promise<void> {
  const host = process.env.ZEROSHEET_INTERNAL_MTLS_SERVER ?? "mtls-api";
  const port = Number.parseInt(
    process.env.ZEROSHEET_INTERNAL_MTLS_PORT ?? "3443",
    10,
  );

  await new Promise<void>((resolve, reject) => {
    let timedOut = false;
    const request = httpRequest(
      {
        host,
        port,
        path: "/internal/reconciliation-tick",
        method: "POST",
        agent: false,
      },
      (response) => {
        response.resume();
        reject(
          new Error(
            `Private port unexpectedly returned plaintext HTTP ${response.statusCode ?? 0}.`,
          ),
        );
      },
    );

    request.setTimeout(5_000, () => {
      timedOut = true;
      request.destroy(new Error("Plaintext negative probe timed out."));
    });
    request.on("error", (error: NodeJS.ErrnoException) => {
      // Positive mTLS probes already prove reachability. Still, explicitly
      // reject DNS, refused-connection, and timeout failures so this control
      // passes only when a reachable TLS listener rejects/parses no HTTP.
      if (
        timedOut ||
        error.code === "ENOTFOUND" ||
        error.code === "ECONNREFUSED"
      ) {
        reject(new Error("Plaintext probe could not reach the TLS listener."));
        return;
      }
      resolve();
    });
    request.end();
  });

  console.log(JSON.stringify({ event: "plaintext_internal_http_rejected" }));
}

await expectPlaintextRejection().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      event: "plaintext_internal_http_probe_failed",
      errorType: error instanceof Error ? error.name : "UnknownError",
    }),
  );
  process.exitCode = 1;
});
