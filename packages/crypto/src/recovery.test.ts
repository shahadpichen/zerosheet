import { describe, expect, it } from "vitest";

import {
  generateRecoveryPhrase,
  normalizeAndValidateRecoveryPhrase,
  RecoveryPhraseMemory,
} from "./recovery.js";
import { ZeroSheetCryptoError } from "./errors.js";

const recoveryPhrase =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

describe("recovery phrase handling", () => {
  it("generates a checksummed 12-word phrase", () => {
    const generated = generateRecoveryPhrase();
    expect(generated.split(" ")).toHaveLength(12);
    expect(normalizeAndValidateRecoveryPhrase(generated)).toBe(generated);
  });

  it("normalizes whitespace and rejects a checksum failure", () => {
    expect(
      normalizeAndValidateRecoveryPhrase(`  ${recoveryPhrase.toUpperCase()}  `),
    ).toBe(recoveryPhrase);
    expect(() =>
      normalizeAndValidateRecoveryPhrase(
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon",
      ),
    ).toThrowError(ZeroSheetCryptoError);
  });

  it("binds live recovery access to the immutable product-user ID", async () => {
    const memory = new RecoveryPhraseMemory();
    memory.unlock("product-user-1", recoveryPhrase);

    expect(memory.isUnlockedFor("product-user-1")).toBe(true);
    expect(memory.isUnlockedFor("product-user-2")).toBe(false);
    await expect(
      memory.use("product-user-2", () => "should not run"),
    ).rejects.toMatchObject({ code: "RECOVERY_ACCOUNT_MISMATCH" });
    await expect(
      memory.use("product-user-1", (phrase) => phrase),
    ).resolves.toBe(recoveryPhrase);
  });

  it("invalidates an in-flight operation when recovery access changes", async () => {
    const memory = new RecoveryPhraseMemory();
    memory.unlock("product-user-1", recoveryPhrase);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const operation = memory.use("product-user-1", async () => {
      await gate;
      return "sensitive result";
    });

    memory.clear();
    release();

    await expect(operation).rejects.toMatchObject({
      code: "RECOVERY_ACCESS_REQUIRED",
    });
    expect(memory.isUnlockedFor("product-user-1")).toBe(false);
  });
});
