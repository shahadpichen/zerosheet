import { describe, expect, it } from "vitest";

import {
  decryptCell,
  encryptCell,
  encryptCellWithNonce,
  inspectEncryptedCell,
  isEncryptedCell,
  type CellEncryptionContext,
  type PlainCellValue,
} from "./cell.js";
import { ZeroSheetCryptoError } from "./errors.js";
import { generateWorkbookKeyBytes, importWorkbookKey } from "./workbook-key.js";

const context: CellEncryptionContext = {
  workbookId: "workbook-test-01",
  sheetId: "google-sheet-tab-0",
  row: 4,
  column: 2,
  keyVersion: 1,
};

async function fixedWorkbookKey(): Promise<CryptoKey> {
  return await importWorkbookKey(
    Uint8Array.from({ length: 32 }, (_value, index) => index),
  );
}

describe("encrypted cell format v1", () => {
  it.each<PlainCellValue>([
    { kind: "blank" },
    { kind: "boolean", value: false },
    { kind: "boolean", value: true },
    { kind: "number", value: -0 },
    { kind: "number", value: 42.5 },
    { kind: "string", value: "Acme Corp 🔐" },
    { kind: "formula", value: "=SUM(A1:A4)" },
  ])("round-trips $kind values without losing their type", async (value) => {
    const key = await fixedWorkbookKey();
    const encrypted = await encryptCell(key, context, value);
    const opened = await decryptCell(key, context, encrypted);

    expect(opened).toEqual(value);
    if (value.kind === "number" && Object.is(value.value, -0)) {
      expect(Object.is((opened as { value: number }).value, -0)).toBe(true);
    }
  });

  it("produces a different encrypted value for the same cell plaintext", async () => {
    const key = await fixedWorkbookKey();
    const value: PlainCellValue = { kind: "string", value: "same value" };

    const first = await encryptCell(key, context, value);
    const second = await encryptCell(key, context, value);

    expect(first).not.toBe(second);
    expect(await decryptCell(key, context, first)).toEqual(value);
    expect(await decryptCell(key, context, second)).toEqual(value);
  });

  it("matches the stable format-v1 test vector", async () => {
    const key = await fixedWorkbookKey();
    const nonce = Uint8Array.from(
      { length: 12 },
      (_value, index) => 160 + index,
    );
    const encrypted = await encryptCellWithNonce(
      key,
      context,
      { kind: "string", value: "Acme Corp" },
      nonce,
    );

    expect(encrypted).toBe(
      "zs1:1:oKGio6Slpqeoqaqr4lkfQCDrQdAQFRaZnP9BKVjiQr-gY7QtKs8",
    );
  });

  it("detects ciphertext tampering", async () => {
    const key = await fixedWorkbookKey();
    const encrypted = await encryptCell(key, context, {
      kind: "string",
      value: "confidential",
    });
    const parts = encrypted.split(":");
    const payload = parts[2] as string;
    const tamperIndex = Math.floor(payload.length / 2);
    const changedCharacter = payload[tamperIndex] === "A" ? "B" : "A";
    const tampered = `${parts[0]}:${parts[1]}:${payload.slice(0, tamperIndex)}${changedCharacter}${payload.slice(tamperIndex + 1)}`;

    await expect(decryptCell(key, context, tampered)).rejects.toMatchObject({
      code: "CELL_AUTHENTICATION_FAILED",
    });
  });

  it.each([
    { ...context, workbookId: "another-workbook" },
    { ...context, sheetId: "another-tab" },
    { ...context, row: context.row + 1 },
    { ...context, column: context.column + 1 },
  ])(
    "rejects ciphertext moved to a different context",
    async (wrongContext) => {
      const key = await fixedWorkbookKey();
      const encrypted = await encryptCell(key, context, {
        kind: "number",
        value: 4_200,
      });

      await expect(
        decryptCell(key, wrongContext, encrypted),
      ).rejects.toMatchObject({ code: "CELL_AUTHENTICATION_FAILED" });
    },
  );

  it("exposes only public routing metadata before decryption", async () => {
    const key = await fixedWorkbookKey();
    const encrypted = await encryptCell(key, context, {
      kind: "string",
      value: "john@acme.example",
    });

    expect(isEncryptedCell(encrypted)).toBe(true);
    const header = inspectEncryptedCell(encrypted);
    expect(header.formatVersion).toBe(1);
    expect(header.keyVersion).toBe(1);
    expect(header.encryptedByteLength).toBeGreaterThan(29);
    expect(encrypted).not.toContain("john");
  });

  it("rejects unknown versions and malformed cells without calling AES", async () => {
    const key = await fixedWorkbookKey();

    expect(() => inspectEncryptedCell("zs2:1:AAAA")).toThrowError(
      ZeroSheetCryptoError,
    );
    await expect(
      decryptCell(key, context, "zs1:0:not-valid-base64!"),
    ).rejects.toBeInstanceOf(ZeroSheetCryptoError);
  });

  it("rejects a key-version mismatch before attempting decryption", async () => {
    const key = await fixedWorkbookKey();
    const encrypted = await encryptCell(key, context, {
      kind: "string",
      value: "version-bound",
    });

    await expect(
      decryptCell(key, { ...context, keyVersion: 2 }, encrypted),
    ).rejects.toMatchObject({ code: "INVALID_CONTEXT" });
  });

  it.each<PlainCellValue>([
    { kind: "number", value: Number.NaN },
    { kind: "number", value: Number.POSITIVE_INFINITY },
    { kind: "formula", value: "SUM(A1:A4)" },
    { kind: "formula", value: "=" },
  ])(
    "rejects values that cannot have a canonical v1 meaning",
    async (value) => {
      const key = await fixedWorkbookKey();

      await expect(encryptCell(key, context, value)).rejects.toMatchObject({
        code: "ENCRYPTION_FAILED",
      });
    },
  );

  it("imports workbook keys as non-extractable browser handles", async () => {
    const raw = generateWorkbookKeyBytes();
    try {
      const key = await importWorkbookKey(raw);
      expect(key.extractable).toBe(false);
      expect(key.algorithm.name).toBe("AES-GCM");
      await expect(crypto.subtle.exportKey("raw", key)).rejects.toThrow();
    } finally {
      raw.fill(0);
    }
  });
});
