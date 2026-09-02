import pg from "pg";
import type { DatabaseConfig } from "./config.js";

const { Pool } = pg;

/**
 * A small shared pool is enough for the API on the initial 2 GB VPS. Pooling
 * avoids opening a new PostgreSQL TCP connection for every HTTP request while
 * the low maximum prevents this single Node.js process from exhausting the
 * database's connection budget as more IAM services are added.
 */
export function createDatabasePool(config: DatabaseConfig): pg.Pool {
  return new Pool({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    max: 10,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    ssl: config.useTls
      ? {
          // Production should install the database provider's CA rather than
          // turning certificate checks off merely to make TLS connect.
          rejectUnauthorized: true,
        }
      : false,
  });
}
