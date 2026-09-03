import { createRuntimeApp } from "./runtime.js";

try {
  const { app, config } = await createRuntimeApp();
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  // Runtime construction may fail before Fastify exists (for example, missing
  // configuration, an unapplied migration, or unavailable OIDC discovery).
  // stderr is the only dependable logger at that boundary, and Node exits
  // non-zero so a supervisor never mistakes a failed IAM startup for health.
  // Never serialize the raw exception here. Dependency clients sometimes put
  // connection strings, OAuth responses, or paths to mounted secrets in an
  // error message. Operators receive a stable event and error class; detailed
  // diagnosis belongs in a locally reproduced, access-controlled environment.
  console.error(
    JSON.stringify({
      event: "api_startup_failed",
      errorType: error instanceof Error ? error.name : "UnknownError",
    }),
  );
  process.exitCode = 1;
}
