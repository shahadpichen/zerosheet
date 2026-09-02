import { AuthService } from "./auth/auth-service.js";
import { AuditService } from "./audit/audit-service.js";
import { PostgresAuditRepository } from "./audit/postgres-audit-repository.js";
import { createOpenIdClientGateway } from "./auth/openid-client-gateway.js";
import { PostgresAuthRepository } from "./auth/postgres-auth-repository.js";
import { buildApp } from "./app.js";
import { loadRuntimeConfig } from "./config.js";
import { createDatabasePool } from "./database.js";
import { AuthorizationService } from "./authorization/authorization-service.js";
import { createOpaContextualPolicyGateway } from "./authorization/opa-contextual-policy-gateway.js";
import { createOpenFgaAuthorizationGateway } from "./authorization/openfga-authorization-gateway.js";
import { PostgresPolicyContextRepository } from "./authorization/postgres-policy-context-repository.js";
import { LifecycleService } from "./lifecycle/lifecycle-service.js";
import { PostgresLifecycleRepository } from "./lifecycle/postgres-lifecycle-repository.js";
import { PostgresProductRepository } from "./product/postgres-product-repository.js";
import { ProductService } from "./product/product-service.js";
import { GoogleWebServerOAuthGateway } from "./google-storage/google-oauth-gateway.js";
import {
  DisabledGoogleStorageService,
  GoogleStorageService,
} from "./google-storage/google-storage-service.js";
import { PostgresGoogleStorageRepository } from "./google-storage/postgres-google-storage-repository.js";
import { AesGcmGoogleRefreshTokenProtector } from "./google-storage/refresh-token-protector.js";
import type { GoogleStorageApplicationService } from "./google-storage/types.js";

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
    const productRepository = new PostgresProductRepository(pool);
    await productRepository.assertReady();
    const policyContextRepository = new PostgresPolicyContextRepository(pool);
    await policyContextRepository.assertReady();
    const auditRepository = new PostgresAuditRepository(pool);
    await auditRepository.assertReady();
    const lifecycleRepository = new PostgresLifecycleRepository(pool);
    await lifecycleRepository.assertReady();

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
    const contextualPolicyGateway = createOpaContextualPolicyGateway(
      config.contextualAuthorization,
    );
    await contextualPolicyGateway.assertReady();
    const authorizationService = new AuthorizationService({
      relationships: authorizationGateway,
      context: policyContextRepository,
      policy: contextualPolicyGateway,
      audit: auditRepository,
    });
    const productService = new ProductService({
      repository: productRepository,
      decisions: authorizationService,
      relationships: authorizationGateway,
    });
    const lifecycleService = new LifecycleService({
      repository: lifecycleRepository,
      authorization: authorizationService,
      memberships: productService,
      audit: auditRepository,
    });
    const auditService = new AuditService(
      auditRepository,
      authorizationService,
    );
    let googleStorageService: GoogleStorageApplicationService =
      new DisabledGoogleStorageService();

    if (config.googleStorage.enabled) {
      const googleStorageRepository = new PostgresGoogleStorageRepository(pool);
      await googleStorageRepository.assertReady();
      const refreshTokens = new AesGcmGoogleRefreshTokenProtector(
        config.googleStorage.tokenEncryptionKey,
      );

      // The protector made its own private copy. Clear the parsed environment
      // byte array so runtime configuration is not a second long-lived key
      // buffer, while acknowledging the service must retain one usable copy.
      config.googleStorage.tokenEncryptionKey.fill(0);
      googleStorageService = new GoogleStorageService({
        repository: googleStorageRepository,
        oauth: new GoogleWebServerOAuthGateway(config.googleStorage),
        refreshTokens,
        transactionSeconds: config.googleStorage.transactionSeconds,
      });
    }

    /**
     * A previous process may have stopped after PostgreSQL stored a mutation or
     * after OpenFGA applied it. Replaying pending intents before listening
     * closes both windows; OpenFGA conflict-ignore semantics make replay safe.
     */
    await productService.reconcilePendingOperations();
    const reconciliationTimer = setInterval(() => {
      void productService.reconcilePendingOperations().catch(() => {
        // Request traffic remains fail-closed. A later interval retries; the
        // timer must not crash the API merely because one dependency is down.
      });
    }, 5_000);
    reconciliationTimer.unref();

    const app = buildApp({
      authService,
      authorizationService,
      productService,
      lifecycleService,
      auditService,
      googleStorageService,
      config,
    });

    // Fastify owns process lifecycle, so closing the app must also drain its
    // PostgreSQL connections. This matters during watch-mode restarts and
    // graceful container shutdowns.
    app.addHook("onClose", async () => {
      clearInterval(reconciliationTimer);
      await pool.end();
    });

    return { app, config };
  } catch (error) {
    await pool.end();
    throw error;
  }
}
