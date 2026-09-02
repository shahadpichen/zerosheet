import { createRuntimeApp } from "./runtime.js";

try {
  const { app, config } = await createRuntimeApp();
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  // Runtime construction may fail before Fastify exists (for example, missing
  // configuration, an unapplied migration, or unavailable OIDC discovery).
  // stderr is the only dependable logger at that boundary, and Node exits
  // non-zero so a supervisor never mistakes a failed IAM startup for health.
  console.error(error);
  process.exitCode = 1;
}
