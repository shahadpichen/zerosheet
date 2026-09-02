import { request as httpsRequest } from "node:https";

import {
  createSpiffeCheckServerIdentity,
  SpiffeX509Source,
  type WorkloadX509Credentials,
} from "@zerosheet/workload-identity";

interface ProbeConfig {
  readonly host: string;
  readonly port: number;
  readonly ownSpiffeId: string;
  readonly expectedServerSpiffeId: string;
  readonly expectedStatus: number;
  readonly endpointSocket: string;
}

function readPositiveInteger(value: string, name: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error(`${name} must be a positive integer no larger than 65535.`);
  }
  return parsed;
}

/** Read explicit identities instead of accepting them from request content. */
function readConfig(environment: NodeJS.ProcessEnv): ProbeConfig {
  return {
    host: environment.ZEROSHEET_INTERNAL_MTLS_SERVER ?? "mtls-api",
    port: readPositiveInteger(
      environment.ZEROSHEET_INTERNAL_MTLS_PORT ?? "3443",
      "ZEROSHEET_INTERNAL_MTLS_PORT",
    ),
    ownSpiffeId:
      environment.ZEROSHEET_WORKLOAD_SPIFFE_ID ??
      "spiffe://zerosheet.internal/workload/worker",
    expectedServerSpiffeId:
      environment.ZEROSHEET_EXPECTED_API_SPIFFE_ID ??
      "spiffe://zerosheet.internal/workload/api",
    expectedStatus: readPositiveInteger(
      environment.ZEROSHEET_EXPECTED_HTTP_STATUS ?? "200",
      "ZEROSHEET_EXPECTED_HTTP_STATUS",
    ),
    endpointSocket:
      environment.SPIFFE_ENDPOINT_SOCKET ??
      "unix:///run/spire/agent/public/api.sock",
  };
}

/**
 * Make one fresh connection using the source's current SVID. Chain validation,
 * client authentication, and exact server SPIFFE-ID validation all happen
 * before HTTP response handling.
 */
async function callInternalApi(
  config: ProbeConfig,
  credentials: WorkloadX509Credentials,
): Promise<{ readonly statusCode: number; readonly body: string }> {
  return await new Promise((resolve, reject) => {
    const request = httpsRequest(
      {
        host: config.host,
        port: config.port,
        path: "/internal/reconciliation-tick",
        method: "POST",
        cert: credentials.certificateChainPem,
        key: credentials.privateKeyPem,
        ca: credentials.trustBundlePem,
        minVersion: "TLSv1.3",
        rejectUnauthorized: true,
        checkServerIdentity: createSpiffeCheckServerIdentity(
          config.expectedServerSpiffeId,
        ),
        headers: {
          "content-length": "0",
        },
        agent: false,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let length = 0;

        response.on("data", (chunk: Buffer) => {
          length += chunk.length;
          if (length > 16_384) {
            request.destroy(new Error("Internal response exceeded 16 KiB."));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          resolve({
            statusCode: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );

    request.setTimeout(5_000, () => {
      request.destroy(new Error("Internal mTLS request timed out."));
    });
    request.on("error", reject);
    request.end();
  });
}

async function main(): Promise<void> {
  const config = readConfig(process.env);
  const source = new SpiffeX509Source({
    expectedSpiffeId: config.ownSpiffeId,
    endpointSocket: config.endpointSocket,
  });

  try {
    await source.start();
    const result = await callInternalApi(config, source.currentCredentials());

    if (result.statusCode !== config.expectedStatus) {
      throw new Error("The internal API returned an unexpected status.");
    }

    // Parse the bounded response to prove it is JSON, but output only the
    // status and configured public identities. Response content is never
    // copied into logs where future job details might become sensitive.
    JSON.parse(result.body) as unknown;
    console.log(
      JSON.stringify({
        event: "internal_mtls_probe_passed",
        caller: config.ownSpiffeId,
        expectedServer: config.expectedServerSpiffeId,
        statusCode: result.statusCode,
      }),
    );
  } finally {
    await source.stop();
  }
}

await main().catch((error: unknown) => {
  const errorWithCode = error as { readonly code?: unknown };
  console.error(
    JSON.stringify({
      event: "internal_mtls_probe_failed",
      errorType: error instanceof Error ? error.name : "UnknownError",
      errorCode:
        typeof errorWithCode.code === "string" ? errorWithCode.code : "none",
    }),
  );
  process.exitCode = 1;
});
