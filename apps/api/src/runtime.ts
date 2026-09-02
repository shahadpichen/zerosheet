import { AuthService } from "./auth/auth-service.js";
import { createOpenIdClientGateway } from "./auth/openid-client-gateway.js";
import { PostgresAuthRepository } from "./auth/postgres-auth-repository.js";
import { buildApp } from "./app.js";
import { loadRuntimeConfig } from "./config.js";
import { createDatabasePool } from "./database.js";
import { AuthorizationService } from "./authorization/authorization-service.js";
import { createOpenFgaAuthorizationGateway } from "./authorization/openfga-authorization-gateway.js";

/**
 * This composition root is the only place that chooses concrete adapters.
 * Domain/authentication logic depends on interfaces, while the running process
 * receives PostgreSQL and Keycloak implementations. Keeping construction here
 * makes trust boundaries visible and prevents routes from opening ad-hoc
 * database connections or discovering arbitrary issuers.
 */
export async function createRuntimeApp() {
  const config = loadRuntimeConfig();
  const pool = createDatabasePool(config.database);

  try {
    const repository = new PostgresAuthRepository(pool);
    await repository.assertReady();

    const oidc = await createOpenIdClientGateway(config.oidc);
    const authService = new AuthService({
      repository,
      oidc,
      lifetimes: config.authLifetimes,
    });
    const authorizationGateway = createOpenFgaAuthorizationGateway(
      config.authorization,
    );
    await authorizationGateway.assertReady();
    const authorizationService = new AuthorizationService(authorizationGateway);
    const app = buildApp({ authService, authorizationService, config });

    // Fastify owns process lifecycle, so closing the app must also drain its
    // PostgreSQL connections. This matters during watch-mode restarts and
    // graceful container shutdowns.
    app.addHook("onClose", async () => {
      await pool.end();
    });

    return { app, config };
  } catch (error) {
    await pool.end();
    throw error;
  }
}
