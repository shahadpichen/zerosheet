import { once } from "node:events";
import { writeFile, unlink } from "node:fs/promises";
import type { RequestListener } from "node:http";
import { createServer, type Server } from "node:https";
import type { TLSSocket } from "node:tls";

import {
  assertValidSpiffeId,
  authorizeExactPeerSpiffeId,
  SpiffeX509Source,
  type WorkloadX509Credentials,
} from "@zerosheet/workload-identity";

interface InternalServerConfig {
  readonly host: string;
  readonly port: number;
  readonly ownSpiffeId: string;
  readonly allowedWorkerSpiffeId: string;
  readonly endpointSocket: string;
  readonly readinessFile: string;
}

/**
 * This is a deliberately separate internal listener, not the browser-facing
 * Fastify application. Keeping the ports and protocols separate prevents a
 * public OIDC session endpoint from accidentally inheriting workload-only
 * assumptions or accepting a workload certificate as a human identity.
 */
function readConfig(environment: NodeJS.ProcessEnv): InternalServerConfig {
  const portText = environment.ZEROSHEET_INTERNAL_MTLS_PORT ?? "3443";
  const port = Number.parseInt(portText, 10);

  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("ZEROSHEET_INTERNAL_MTLS_PORT must be a valid TCP port.");
  }

  return {
    host: environment.ZEROSHEET_INTERNAL_MTLS_HOST ?? "0.0.0.0",
    port,
    ownSpiffeId:
      environment.ZEROSHEET_WORKLOAD_SPIFFE_ID ??
      "spiffe://zerosheet.internal/workload/api",
    allowedWorkerSpiffeId:
      environment.ZEROSHEET_ALLOWED_WORKER_SPIFFE_ID ??
      "spiffe://zerosheet.internal/workload/worker",
    endpointSocket:
      environment.SPIFFE_ENDPOINT_SOCKET ??
      "unix:///run/spire/agent/public/api.sock",
    readinessFile:
      environment.ZEROSHEET_INTERNAL_READY_FILE ??
      "/tmp/zerosheet-internal-mtls-ready",
  };
}

/** Write a small JSON response without reflecting request or certificate data. */
function writeJson(
  response: Parameters<RequestListener>[1],
  statusCode: number,
  body: Readonly<Record<string, string>>,
): void {
  const document = JSON.stringify(body);
  response.writeHead(statusCode, {
    "content-length": Buffer.byteLength(document),
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(document);
}

/**
 * Construct the narrow application-level PEP. TLS first validates that the
 * certificate chains to SPIRE; this handler then verifies that the validated
 * identity is specifically the worker rather than merely any ZeroSheet SVID.
 */
function createRequestListener(allowedWorkerSpiffeId: string): RequestListener {
  return (request, response) => {
    if (
      request.method !== "POST" ||
      request.url !== "/internal/reconciliation-tick"
    ) {
      writeJson(response, 404, { error: "not_found" });
      return;
    }

    // This lab endpoint accepts no body. Draining the stream permits connection
    // reuse without placing caller-controlled bytes into logs or application
    // state. The real reconciliation job will read committed outbox rows.
    request.resume();

    const socket = request.socket as TLSSocket;
    if (!socket.authorized) {
      writeJson(response, 401, { error: "workload_certificate_not_verified" });
      return;
    }

    try {
      const peerSpiffeId = authorizeExactPeerSpiffeId(
        socket.getPeerCertificate(),
        allowedWorkerSpiffeId,
      );
      writeJson(response, 200, {
        status: "reconciliation_tick_accepted",
        authenticatedCaller: peerSpiffeId,
      });
    } catch {
      // A certificate for the API itself is cryptographically valid but lacks
      // the worker role for this endpoint. A generic denial avoids reflecting
      // peer certificate details while still distinguishing authorization.
      writeJson(response, 403, { error: "workload_not_authorized" });
    }
  };
}

/** Create the server from one validated credential snapshot. */
function createInternalServer(
  credentials: WorkloadX509Credentials,
  allowedWorkerSpiffeId: string,
): Server {
  return createServer(
    {
      cert: credentials.certificateChainPem,
      key: credentials.privateKeyPem,
      ca: credentials.trustBundlePem,
      minVersion: "TLSv1.3",
      requestCert: true,
      rejectUnauthorized: true,
    },
    createRequestListener(allowedWorkerSpiffeId),
  );
}

/**
 * Start with an SVID obtained from the local Workload API and replace the TLS
 * secure context whenever SPIRE streams a rotation. Existing connections can
 * finish while new handshakes immediately use the newest in-memory material.
 */
async function main(): Promise<void> {
  const config = readConfig(process.env);
  // Validate both sides of the allowlist at startup. A configuration typo must
  // stop readiness rather than wait until the first internal request.
  assertValidSpiffeId(config.allowedWorkerSpiffeId);
  const source = new SpiffeX509Source({
    expectedSpiffeId: config.ownSpiffeId,
    endpointSocket: config.endpointSocket,
    onStreamError: (error) => {
      console.error(
        JSON.stringify({
          event: "spiffe_workload_stream_error",
          errorType: error instanceof Error ? error.name : "UnknownError",
        }),
      );
    },
  });

  await source.start();
  const server = createInternalServer(
    source.currentCredentials(),
    config.allowedWorkerSpiffeId,
  );
  const removeUpdateListener = source.onUpdate((credentials) => {
    server.setSecureContext({
      cert: credentials.certificateChainPem,
      key: credentials.privateKeyPem,
      ca: credentials.trustBundlePem,
      minVersion: "TLSv1.3",
    });
    console.log(
      JSON.stringify({
        event: "workload_certificate_rotated",
        workloadId: credentials.spiffeId,
        expiresAt: new Date(credentials.notAfterEpochMs).toISOString(),
      }),
    );
  });

  server.listen(config.port, config.host);
  await once(server, "listening");
  await writeFile(config.readinessFile, "ready\n", { mode: 0o600 });

  console.log(
    JSON.stringify({
      event: "internal_mtls_server_ready",
      workloadId: config.ownSpiffeId,
      allowedCaller: config.allowedWorkerSpiffeId,
      port: config.port,
    }),
  );

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    removeUpdateListener();
    await unlink(config.readinessFile).catch(() => undefined);
    await new Promise<void>((resolve, reject) => {
      server.close((error) =>
        error === undefined ? resolve() : reject(error),
      );
    });
    await source.stop();
  };

  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

await main().catch((error: unknown) => {
  // Error messages from TLS libraries can contain certificate metadata or
  // socket paths. The process logs only the error class and exits fail closed.
  console.error(
    JSON.stringify({
      event: "internal_mtls_server_failed",
      errorType: error instanceof Error ? error.name : "UnknownError",
    }),
  );
  process.exitCode = 1;
});
