import { beforeEach, describe, expect, it, vi } from "vitest";
import { saveRecoverySetup } from "./recovery-setup.js";

const mocks = vi.hoisted(() => ({
  exists: vi.fn(),
  create: vi.fn(),
  recover: vi.fn(),
}));
vi.mock("./workspace-client.js", () => ({
  hasEncryptionIdentity: mocks.exists,
}));
vi.mock("./secure-workbook.js", () => ({
  createAndRegisterEncryptionIdentity: mocks.create,
  recoverEncryptionIdentity: mocks.recover,
}));

// Public BIP39 test phrase, never a real user's recovery secret. Crypto itself
// is exercised by package tests and the browser run; these tests cover ordering.
const phrase =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
beforeEach(() => {
  vi.resetAllMocks();
  mocks.create.mockResolvedValue(undefined);
  mocks.recover.mockResolvedValue(undefined);
});

describe("first-page recovery setup", () => {
  it("validates locally, creates only a missing identity, then verifies the saved backup", async () => {
    mocks.exists.mockResolvedValue(false);
    await expect(
      saveRecoverySetup("  " + phrase.toUpperCase() + "  "),
    ).resolves.toBe(phrase);
    expect(mocks.create).toHaveBeenCalledExactlyOnceWith({
      recoveryPhrase: phrase,
      keyVersion: 1,
    });
    expect(mocks.recover).toHaveBeenCalledExactlyOnceWith(phrase);
    expect(mocks.create.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.recover.mock.invocationCallOrder[0]!,
    );
  });

  it("recovers instead of replacing an identity created by another tab or a previous attempt", async () => {
    mocks.exists.mockResolvedValue(true);
    await saveRecoverySetup(phrase);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.recover).toHaveBeenCalledExactlyOnceWith(phrase);
  });

  it("does not create a key when the identity lookup is unavailable", async () => {
    mocks.exists.mockRejectedValue(new Error("offline"));
    await expect(saveRecoverySetup(phrase)).rejects.toThrow("offline");
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.recover).not.toHaveBeenCalled();
  });

  it("does not accept a phrase just because its checksum is valid", async () => {
    mocks.exists.mockResolvedValue(true);
    mocks.recover.mockRejectedValue(new Error("backup cannot be opened"));
    await expect(saveRecoverySetup(phrase)).rejects.toThrow(
      "backup cannot be opened",
    );
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("retains the existing backup after a lost creation response", async () => {
    mocks.exists.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    mocks.create.mockRejectedValueOnce(new Error("response lost"));
    await expect(saveRecoverySetup(phrase)).rejects.toThrow("response lost");
    await expect(saveRecoverySetup(phrase)).resolves.toBe(phrase);
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.recover).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed words before any request", async () => {
    await expect(saveRecoverySetup("not a recovery phrase")).rejects.toThrow();
    expect(mocks.exists).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
