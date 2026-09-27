import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkbookSharingDetails } from "@zerosheet/contracts";

const cryptoMocks = vi.hoisted(() => ({
  openUserPrivateKeyBackup: vi.fn(),
  openWorkbookKeyEnvelope: vi.fn(),
  sealWorkbookKeyForRecipient: vi.fn(),
}));

const googleMocks = vi.hoisted(() => ({
  createUserPermission: vi.fn(),
  deletePermission: vi.fn(),
  listPermissions: vi.fn(),
  updateUserPermission: vi.fn(),
}));

// The coordinator test deliberately replaces cryptographic primitives with
// deterministic fakes. The real algorithms have their own vector/tamper tests;
// here we need to observe ordering, byte clearing, and exact provider rollback.
vi.mock("@zerosheet/crypto", () => ({
  createUserEncryptionIdentity: vi.fn(),
  generateWorkbookKeyBytes: vi.fn(),
  importWorkbookKey: vi.fn(),
  openUserPrivateKeyBackup: cryptoMocks.openUserPrivateKeyBackup,
  openWorkbookKeyEnvelope: cryptoMocks.openWorkbookKeyEnvelope,
  sealWorkbookKeyForRecipient: cryptoMocks.sealWorkbookKeyForRecipient,
}));

vi.mock("./google-storage.js", () => ({
  googleWorkspaceStorage: {
    createUserPermission: googleMocks.createUserPermission,
    deletePermission: googleMocks.deletePermission,
    listPermissions: googleMocks.listPermissions,
    updateUserPermission: googleMocks.updateUserPermission,
  },
}));

import {
  auditWorkbookGooglePermissions,
  SecureWorkbookClientError,
  shareEncryptedWorkbookWithUser,
} from "./secure-workbook.js";

const OWNER_ID = "00000000-0000-4000-8000-000000000131";
const RECIPIENT_ID = "00000000-0000-4000-8000-000000000132";
const WORKBOOK_ID = "00000000-0000-4000-8000-000000000133";
const SUITE = "DHKEM_P256_HKDF_SHA256_HKDF_SHA256_AES_256_GCM" as const;

const ownerPublicKey = {
  formatVersion: 1 as const,
  keyVersion: 2,
  suite: SUITE,
  publicKey: "A".repeat(87),
  fingerprint: "a".repeat(64),
};

const recipientPublicKey = {
  formatVersion: 1 as const,
  keyVersion: 4,
  suite: SUITE,
  publicKey: "B".repeat(87),
  fingerprint: "b".repeat(64),
};

const ownerEnvelope = {
  formatVersion: 1 as const,
  suite: SUITE,
  workbookKeyVersion: 7,
  recipientKeyVersion: ownerPublicKey.keyVersion,
  recipientFingerprint: ownerPublicKey.fingerprint,
  encapsulatedKey: "C".repeat(87),
  ciphertext: "D".repeat(64),
};

const recipientEnvelope = {
  ...ownerEnvelope,
  recipientKeyVersion: recipientPublicKey.keyVersion,
  recipientFingerprint: recipientPublicKey.fingerprint,
  encapsulatedKey: "E".repeat(87),
  ciphertext: "F".repeat(64),
};

beforeEach(() => {
  vi.resetAllMocks();
  googleMocks.listPermissions.mockResolvedValue([]);
  cryptoMocks.openUserPrivateKeyBackup.mockResolvedValue({});
  cryptoMocks.openWorkbookKeyEnvelope.mockResolvedValue(new Uint8Array(32));
  cryptoMocks.sealWorkbookKeyForRecipient.mockResolvedValue(recipientEnvelope);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("secure workbook sharing coordinator", () => {
  const existingShare: WorkbookSharingDetails["shares"][number] = {
    userId: RECIPIENT_ID,
    email: "recipient@example.test",
    role: "viewer",
    state: "active",
    googlePermissionId: "permission_13",
    hasEnvelope: true,
  };

  it("updates a managed Google role without allocating or deleting a permission", async () => {
    googleMocks.listPermissions.mockResolvedValue([
      {
        id: "permission_13",
        emailAddress: existingShare.email,
        type: "user",
        role: "reader",
        deleted: false,
      },
    ]);
    installApi({ secureShareStatus: 200, shares: [existingShare] });
    await shareEncryptedWorkbookWithUser({
      workbookId: WORKBOOK_ID,
      recipientUserId: RECIPIENT_ID,
      role: "editor",
      recoveryPhrase: "fixture",
    });
    expect(googleMocks.updateUserPermission).toHaveBeenCalledWith({
      spreadsheetId: "google_sheet_13",
      permissionId: "permission_13",
      role: "writer",
    });
    expect(googleMocks.createUserPermission).not.toHaveBeenCalled();
    expect(googleMocks.deletePermission).not.toHaveBeenCalled();
  });

  it("never adopts or deletes an unmanaged pre-existing permission", async () => {
    googleMocks.listPermissions.mockResolvedValue([
      {
        id: "external_permission",
        emailAddress: existingShare.email,
        type: "user",
        role: "reader",
        deleted: false,
      },
    ]);
    installApi({ secureShareStatus: 200 });
    await expect(
      shareEncryptedWorkbookWithUser({
        workbookId: WORKBOOK_ID,
        recipientUserId: RECIPIENT_ID,
        role: "viewer",
        recoveryPhrase: "fixture",
      }),
    ).rejects.toMatchObject({ code: "GOOGLE_EXISTING_PERMISSION" });
    expect(googleMocks.createUserPermission).not.toHaveBeenCalled();
    expect(googleMocks.deletePermission).not.toHaveBeenCalled();
  });

  it("requires another review if the public key changes after email lookup", async () => {
    installApi({ secureShareStatus: 200 });
    await expect(
      shareEncryptedWorkbookWithUser({
        workbookId: WORKBOOK_ID,
        recipientUserId: RECIPIENT_ID,
        role: "viewer",
        recoveryPhrase: "fixture",
        reviewedRecipient: {
          email: existingShare.email,
          fingerprint: "old-fingerprint",
        },
      }),
    ).rejects.toMatchObject({ code: "RECIPIENT_CHANGED" });
    expect(cryptoMocks.openWorkbookKeyEnvelope).not.toHaveBeenCalled();
    expect(googleMocks.createUserPermission).not.toHaveBeenCalled();
  });

  it("keeps the Google grant when the successful API response is lost", async () => {
    googleMocks.createUserPermission.mockResolvedValue({ id: "permission_13" });
    installApi({ secureShareStatus: 503, confirmedShares: [existingShare] });
    await expect(
      shareEncryptedWorkbookWithUser({
        workbookId: WORKBOOK_ID,
        recipientUserId: RECIPIENT_ID,
        role: "viewer",
        recoveryPhrase: "fixture",
      }),
    ).resolves.toMatchObject({ role: "viewer" });
    expect(googleMocks.deletePermission).not.toHaveBeenCalled();
  });

  it("does not guess a rollback while a relationship is pending", async () => {
    googleMocks.createUserPermission.mockResolvedValue({ id: "permission_13" });
    installApi({
      secureShareStatus: 503,
      confirmedShares: [{ ...existingShare, state: "pending" }],
    });
    await expect(
      shareEncryptedWorkbookWithUser({
        workbookId: WORKBOOK_ID,
        recipientUserId: RECIPIENT_ID,
        role: "viewer",
        recoveryPhrase: "fixture",
      }),
    ).rejects.toMatchObject({ code: "SHARING_REQUIRES_REVIEW" });
    expect(googleMocks.deletePermission).not.toHaveBeenCalled();
  });

  it("restores a previous role rather than deleting its permission on failure", async () => {
    googleMocks.listPermissions.mockResolvedValue([
      {
        id: "permission_13",
        emailAddress: existingShare.email,
        type: "user",
        role: "reader",
        deleted: false,
      },
    ]);
    installApi({ secureShareStatus: 503, shares: [existingShare] });
    await expect(
      shareEncryptedWorkbookWithUser({
        workbookId: WORKBOOK_ID,
        recipientUserId: RECIPIENT_ID,
        role: "editor",
        recoveryPhrase: "fixture",
      }),
    ).rejects.toMatchObject({ code: "ZEROSHEET_API_FAILED" });
    expect(googleMocks.updateUserPermission).toHaveBeenNthCalledWith(1, {
      spreadsheetId: "google_sheet_13",
      permissionId: "permission_13",
      role: "writer",
    });
    expect(googleMocks.updateUserPermission).toHaveBeenNthCalledWith(2, {
      spreadsheetId: "google_sheet_13",
      permissionId: "permission_13",
      role: "reader",
    });
    expect(googleMocks.deletePermission).not.toHaveBeenCalled();
  });
  it("recovers after reload, seals the active key, and clears raw bytes", async () => {
    const rawWorkbookKey = Uint8Array.from({ length: 32 }, (_, index) => index);
    let bytesObservedBySeal: number[] | undefined;
    cryptoMocks.openUserPrivateKeyBackup.mockResolvedValue({});
    cryptoMocks.openWorkbookKeyEnvelope.mockResolvedValue(rawWorkbookKey);
    cryptoMocks.sealWorkbookKeyForRecipient.mockImplementation(
      (input: { workbookKeyBytes: Uint8Array }) => {
        bytesObservedBySeal = [...input.workbookKeyBytes];
        return Promise.resolve(recipientEnvelope);
      },
    );
    googleMocks.createUserPermission.mockResolvedValue({ id: "permission_13" });
    installApi({ secureShareStatus: 200 });

    const result = await shareEncryptedWorkbookWithUser({
      workbookId: WORKBOOK_ID,
      recipientUserId: RECIPIENT_ID,
      role: "editor",
      recoveryPhrase: "phrase stays in this browser",
    });

    expect(result).toEqual({
      workbookId: WORKBOOK_ID,
      principal: { type: "user", id: RECIPIENT_ID },
      role: "editor",
    });
    expect(bytesObservedBySeal).toEqual(
      Array.from({ length: 32 }, (_, index) => index),
    );
    expect([...rawWorkbookKey]).toEqual(Array.from({ length: 32 }, () => 0));
    expect(googleMocks.createUserPermission).toHaveBeenCalledWith({
      spreadsheetId: "google_sheet_13",
      email: "recipient@example.test",
      role: "writer",
    });
    expect(googleMocks.deletePermission).not.toHaveBeenCalled();
  });

  it("removes the exact new Drive permission when the API share fails", async () => {
    cryptoMocks.openUserPrivateKeyBackup.mockResolvedValue({});
    cryptoMocks.openWorkbookKeyEnvelope.mockResolvedValue(new Uint8Array(32));
    cryptoMocks.sealWorkbookKeyForRecipient.mockResolvedValue(
      recipientEnvelope,
    );
    googleMocks.createUserPermission.mockResolvedValue({ id: "permission_13" });
    googleMocks.deletePermission.mockResolvedValue(undefined);
    installApi({ secureShareStatus: 503 });

    await expect(
      shareEncryptedWorkbookWithUser({
        workbookId: WORKBOOK_ID,
        recipientUserId: RECIPIENT_ID,
        role: "viewer",
        recoveryPhrase: "phrase stays in this browser",
      }),
    ).rejects.toMatchObject({ code: "ZEROSHEET_API_FAILED" });
    expect(googleMocks.deletePermission).toHaveBeenCalledWith(
      "google_sheet_13",
      "permission_13",
    );
  });

  it("surfaces a manual-remediation error when Drive rollback also fails", async () => {
    cryptoMocks.openUserPrivateKeyBackup.mockResolvedValue({});
    cryptoMocks.openWorkbookKeyEnvelope.mockResolvedValue(new Uint8Array(32));
    cryptoMocks.sealWorkbookKeyForRecipient.mockResolvedValue(
      recipientEnvelope,
    );
    googleMocks.createUserPermission.mockResolvedValue({ id: "permission_13" });
    googleMocks.deletePermission.mockRejectedValue(new Error("provider down"));
    installApi({ secureShareStatus: 503 });

    await expect(
      shareEncryptedWorkbookWithUser({
        workbookId: WORKBOOK_ID,
        recipientUserId: RECIPIENT_ID,
        role: "viewer",
        recoveryPhrase: "phrase stays in this browser",
      }),
    ).rejects.toEqual(
      new SecureWorkbookClientError("GOOGLE_PERMISSION_ROLLBACK_FAILED"),
    );
  });

  it("reports missing and unmanaged Drive permissions without deleting them", async () => {
    installApi({ secureShareStatus: 200 });
    googleMocks.listPermissions.mockResolvedValue([
      {
        id: "owner_permission_13",
        type: "user",
        role: "owner",
        emailAddress: "owner@example.test",
        deleted: false,
      },
      {
        id: "unmanaged_permission_13",
        type: "domain",
        role: "reader",
        deleted: false,
      },
    ]);

    await expect(
      auditWorkbookGooglePermissions(WORKBOOK_ID),
    ).resolves.toMatchObject({
      matchedPermissionCount: 0,
      missingExpectedPermissions: [{ googlePermissionId: "permission_13" }],
      unmanagedGooglePermissions: [{ id: "unmanaged_permission_13" }],
    });
    expect(googleMocks.listPermissions).toHaveBeenCalledWith("google_sheet_13");
    expect(googleMocks.deletePermission).not.toHaveBeenCalled();
  });
});

/**
 * Return fully schema-valid API projections. Matching on pathname rather than
 * call order keeps the test stable even though safe independent lookups run in
 * parallel before the browser opens the workbook key.
 */
function installApi(input: {
  readonly secureShareStatus: number;
  shares?: WorkbookSharingDetails["shares"];
  confirmedShares?: WorkbookSharingDetails["shares"];
}): void {
  let shared = false;
  vi.stubGlobal(
    "fetch",
    vi.fn((request: string | URL | Request, init?: RequestInit) => {
      const path =
        typeof request === "string"
          ? request
          : request instanceof URL
            ? request.href
            : request.url;
      if (path.endsWith(`/workbooks/${WORKBOOK_ID}/secure-shares`)) {
        return Promise.resolve(
          jsonResponse({
            workbookId: WORKBOOK_ID,
            googleSpreadsheetId: "google_sheet_13",
            activeKeyVersion: 7,
            owner: { userId: OWNER_ID, email: "owner@example.test" },
            rotation: null,
            shares: shared
              ? (input.confirmedShares ?? input.shares ?? [])
              : (input.shares ?? []),
          }),
        );
      }
      if (path.endsWith(`/encryption/recipients/${RECIPIENT_ID}/key`)) {
        return Promise.resolve(
          jsonResponse({
            userId: RECIPIENT_ID,
            email: "recipient@example.test",
            publicKey: recipientPublicKey,
          }),
        );
      }
      if (path.endsWith(`/workbooks/${WORKBOOK_ID}/encryption`)) {
        return Promise.resolve(
          jsonResponse({
            workbookId: WORKBOOK_ID,
            googleSpreadsheetId: "google_sheet_13",
            googleSheetId: 0,
            googleSheetTitle: "Sheet1",
            activeKeyVersion: 7,
            envelope: ownerEnvelope,
            pendingRotation: null,
            rotationPending: false,
          }),
        );
      }
      if (
        path.endsWith(
          `/workbooks/${WORKBOOK_ID}/secure-shares/audit-expectation`,
        )
      ) {
        return Promise.resolve(
          jsonResponse({
            workbookId: WORKBOOK_ID,
            googleSpreadsheetId: "google_sheet_13",
            expectedPermissions: [
              {
                userId: RECIPIENT_ID,
                email: "recipient@example.test",
                role: "viewer",
                googlePermissionId: "permission_13",
              },
            ],
          }),
        );
      }
      if (path.endsWith("/encryption/identities/me/2")) {
        return Promise.resolve(
          jsonResponse({
            userId: OWNER_ID,
            publicKey: ownerPublicKey,
            encryptedPrivateKeyBackup: "AQ",
          }),
        );
      }
      if (
        path.endsWith(
          `/workbooks/${WORKBOOK_ID}/secure-shares/users/${RECIPIENT_ID}`,
        ) &&
        init?.method === "PUT"
      ) {
        shared = true;
        return Promise.resolve(
          jsonResponse(
            {
              workbookId: WORKBOOK_ID,
              principal: { type: "user", id: RECIPIENT_ID },
              role: "editor",
            },
            input.secureShareStatus,
          ),
        );
      }
      return Promise.reject(new Error(`Unexpected API request: ${path}`));
    }),
  );
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
