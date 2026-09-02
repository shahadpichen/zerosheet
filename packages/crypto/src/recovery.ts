import {
  generateRecoveryPhrase as generateCapsuleRecoveryPhrase,
  normalizeRecoveryPhrase,
  validateRecoveryPhrase,
} from "@zerodrivehq/capsule";

import { ZeroSheetCryptoError } from "./errors.js";

/** Generate 128 bits of entropy encoded as a checksummed 12-word BIP39 phrase. */
export function generateRecoveryPhrase(): string {
  return generateCapsuleRecoveryPhrase();
}

/** Normalize whitespace/case and fail before any expensive crypto operation. */
export function normalizeAndValidateRecoveryPhrase(phrase: string): string {
  const normalized = normalizeRecoveryPhrase(phrase.toLowerCase());
  if (!validateRecoveryPhrase(normalized)) {
    throw new ZeroSheetCryptoError("INVALID_RECOVERY_PHRASE");
  }
  return normalized;
}

/**
 * Keep a recovery phrase in JavaScript memory only and bind it to the immutable
 * product-user ID, never an email address. No sessionStorage/localStorage path
 * is built into the crypto core; a reload therefore locks access by default.
 */
export class RecoveryPhraseMemory {
  #productUserId: string | undefined;
  #phrase: string | undefined;
  #generation = 0;

  public unlock(productUserId: string, phrase: string): void {
    assertProductUserId(productUserId);
    const normalized = normalizeAndValidateRecoveryPhrase(phrase);

    this.clear();
    this.#productUserId = productUserId;
    this.#phrase = normalized;
    this.#generation += 1;
  }

  public isUnlockedFor(productUserId: string): boolean {
    return this.#phrase !== undefined && this.#productUserId === productUserId;
  }

  public get generation(): number {
    return this.#generation;
  }

  /**
   * Give the phrase to one synchronous or asynchronous operation without
   * exposing a general getter that encourages UI state copies.
   */
  public async use<T>(
    productUserId: string,
    operation: (phrase: string) => Promise<T> | T,
  ): Promise<T> {
    if (this.#phrase === undefined || this.#productUserId === undefined) {
      throw new ZeroSheetCryptoError("RECOVERY_ACCESS_REQUIRED");
    }
    if (this.#productUserId !== productUserId) {
      throw new ZeroSheetCryptoError("RECOVERY_ACCOUNT_MISMATCH");
    }

    const generationAtStart = this.#generation;
    const result = await operation(this.#phrase);
    if (generationAtStart !== this.#generation) {
      throw new ZeroSheetCryptoError("RECOVERY_ACCESS_REQUIRED");
    }
    return result;
  }

  public clear(): void {
    // JavaScript strings are immutable, so the old character buffer cannot be
    // reliably overwritten. Dropping all references is the best browser API
    // permits; the threat model documents that active XSS can read live memory.
    this.#phrase = undefined;
    this.#productUserId = undefined;
    this.#generation += 1;
  }
}

function assertProductUserId(productUserId: string): void {
  if (
    productUserId.length < 1 ||
    productUserId.length > 200 ||
    productUserId.trim() !== productUserId
  ) {
    throw new ZeroSheetCryptoError("INVALID_CONTEXT");
  }
}
