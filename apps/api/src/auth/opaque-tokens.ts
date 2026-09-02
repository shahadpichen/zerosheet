import { createHash, randomBytes } from "node:crypto";

/**
 * Thirty-two random bytes provide 256 bits of entropy. Base64url keeps the
 * resulting token inside the cookie-safe alphabet without padding or escaping.
 */
export function createOpaqueToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * PostgreSQL stores this one-way selector instead of the raw cookie value. A
 * database read therefore does not immediately become a usable browser session
 * or login-transaction cookie. SHA-256 is appropriate here because the input
 * is already uniformly random; password hashing algorithms are for low-entropy
 * human passwords, which these tokens are not.
 */
export function hashOpaqueToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
