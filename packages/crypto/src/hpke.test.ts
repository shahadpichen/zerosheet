import { describe, expect, it } from "vitest";

import {
  createUserEncryptionIdentity,
  openUserPrivateKeyBackup,
  openWorkbookKeyEnvelope,
  sealWorkbookKeyForRecipient,
  USER_HPKE_SUITE,
} from "./hpke.js";
import { generateWorkbookKeyBytes } from "./workbook-key.js";

const firstRecoveryPhrase =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const secondRecoveryPhrase =
  "legal winner thank year wave sausage worth useful legal winner thank yellow";

describe("browser HPKE user identity", () => {
  it("publishes only a versioned public key and recovers the private key", async () => {
    const identity = await createUserEncryptionIdentity({
      recoveryPhrase: firstRecoveryPhrase,
      keyVersion: 1,
      createdAt: "2026-09-03T00:00:00.000Z",
    });

    expect(identity.publicKey.formatVersion).toBe(1);
    expect(identity.publicKey.keyVersion).toBe(1);
    expect(identity.publicKey.suite).toBe(USER_HPKE_SUITE);
    expect(identity.publicKey.publicKey).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(identity.publicKey.fingerprint).toMatch(/^[0-9a-f]{64}$/u);
    expect(JSON.stringify(identity.publicKey)).not.toContain("private");
    expect(identity.encryptedPrivateKeyBackup.byteLength).toBeGreaterThan(100);

    const recovered = await openUserPrivateKeyBackup({
      encryptedPrivateKeyBackup: identity.encryptedPrivateKeyBackup,
      recoveryPhrase: firstRecoveryPhrase,
      publicKey: identity.publicKey,
    });
    expect(recovered.type).toBe("private");
  });

  it("does not let another valid 12-word phrase open the private key", async () => {
    const identity = await createUserEncryptionIdentity({
      recoveryPhrase: firstRecoveryPhrase,
      keyVersion: 1,
    });

    await expect(
      openUserPrivateKeyBackup({
        encryptedPrivateKeyBackup: identity.encryptedPrivateKeyBackup,
        recoveryPhrase: secondRecoveryPhrase,
        publicKey: identity.publicKey,
      }),
    ).rejects.toMatchObject({ code: "RECOVERY_PHRASE_MISMATCH" });
  });

  it("detects a backup paired with another directory public key", async () => {
    const first = await createUserEncryptionIdentity({
      recoveryPhrase: firstRecoveryPhrase,
      keyVersion: 1,
    });
    const second = await createUserEncryptionIdentity({
      recoveryPhrase: secondRecoveryPhrase,
      keyVersion: 1,
    });

    await expect(
      openUserPrivateKeyBackup({
        encryptedPrivateKeyBackup: first.encryptedPrivateKeyBackup,
        recoveryPhrase: firstRecoveryPhrase,
        publicKey: second.publicKey,
      }),
    ).rejects.toMatchObject({ code: "PUBLIC_KEY_MISMATCH" });
  });
});

describe("HPKE workbook-key envelopes", () => {
  it("lets the intended recipient recover the exact random workbook key", async () => {
    const identity = await createUserEncryptionIdentity({
      recoveryPhrase: firstRecoveryPhrase,
      keyVersion: 3,
    });
    const workbookKey = generateWorkbookKeyBytes();

    try {
      const envelope = await sealWorkbookKeyForRecipient({
        workbookId: "workbook-test-01",
        workbookKeyVersion: 7,
        workbookKeyBytes: workbookKey,
        recipient: identity.publicKey,
      });
      const recoveredPrivateKey = await openUserPrivateKeyBackup({
        encryptedPrivateKeyBackup: identity.encryptedPrivateKeyBackup,
        recoveryPhrase: firstRecoveryPhrase,
        publicKey: identity.publicKey,
      });
      const opened = await openWorkbookKeyEnvelope({
        workbookId: "workbook-test-01",
        envelope,
        recipientPublicKey: identity.publicKey,
        recipientPrivateKey: recoveredPrivateKey,
      });

      try {
        expect(opened).toEqual(workbookKey);
        expect(envelope.recipientFingerprint).toBe(
          identity.publicKey.fingerprint,
        );
        expect(JSON.stringify(envelope)).not.toContain(
          Array.from(workbookKey).join(","),
        );
      } finally {
        opened.fill(0);
      }
    } finally {
      workbookKey.fill(0);
    }
  });

  it("authenticates workbook context and rejects another recipient", async () => {
    const intended = await createUserEncryptionIdentity({
      recoveryPhrase: firstRecoveryPhrase,
      keyVersion: 1,
    });
    const stranger = await createUserEncryptionIdentity({
      recoveryPhrase: secondRecoveryPhrase,
      keyVersion: 1,
    });
    const workbookKey = generateWorkbookKeyBytes();

    try {
      const envelope = await sealWorkbookKeyForRecipient({
        workbookId: "workbook-test-01",
        workbookKeyVersion: 1,
        workbookKeyBytes: workbookKey,
        recipient: intended.publicKey,
      });
      const intendedPrivateKey = await openUserPrivateKeyBackup({
        encryptedPrivateKeyBackup: intended.encryptedPrivateKeyBackup,
        recoveryPhrase: firstRecoveryPhrase,
        publicKey: intended.publicKey,
      });
      const strangerPrivateKey = await openUserPrivateKeyBackup({
        encryptedPrivateKeyBackup: stranger.encryptedPrivateKeyBackup,
        recoveryPhrase: secondRecoveryPhrase,
        publicKey: stranger.publicKey,
      });

      await expect(
        openWorkbookKeyEnvelope({
          workbookId: "another-workbook",
          envelope,
          recipientPublicKey: intended.publicKey,
          recipientPrivateKey: intendedPrivateKey,
        }),
      ).rejects.toMatchObject({ code: "HPKE_OPEN_FAILED" });
      await expect(
        openWorkbookKeyEnvelope({
          workbookId: "workbook-test-01",
          envelope,
          recipientPublicKey: intended.publicKey,
          recipientPrivateKey: strangerPrivateKey,
        }),
      ).rejects.toMatchObject({ code: "HPKE_OPEN_FAILED" });
    } finally {
      workbookKey.fill(0);
    }
  });
});
