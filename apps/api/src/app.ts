import { HealthResponseSchema } from "@zerosheet/contracts";
import Fastify, { type FastifyInstance } from "fastify";

export function buildApp(): FastifyInstance {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
    },
  });

  app.get("/health", async () => {
    return HealthResponseSchema.parse({
      service: "zerosheet-api",
      status: "ok",
    });
  });

  return app;
}
