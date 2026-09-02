import {
  EncryptionIdentityResponseSchema,
  RecipientEncryptionKeyResponseSchema,
  WorkbookEncryptionAccessResponseSchema,
  WorkbookEncryptionStateResponseSchema,
  WorkbookRotationPlanResponseSchema,
  WorkbookRotationResponseSchema,
  WorkbookShareResponseSchema,
  type UserPublicEncryptionKey,
  type WorkbookKeyEnvelope,
  type WorkbookRotationPlanResponse,
} from "@zerosheet/contracts";
import {
  createUserEncryptionIdentity,
  generateWorkbookKeyBytes,
  importWorkbookKey,
  openUserPrivateKeyBackup,
  openWorkbookKeyEnvelope,
  sealWorkbookKeyForRecipient,
} from "@zerosheet/crypto";
import {
  encodeGoogleRange,
  type CellProtectionMap,
  type EditorCell,
  type GridRange,
  type SheetCipherContext,
} from "@zerosheet/sheet-core";
import { googleWorkspaceStorage } from "./google-storage.js";

export class SecureWorkbookClientError extends Error {
  public constructor(
    public readonly code:
      | "ZEROSHEET_API_FAILED"
      | "GOOGLE_PERMISSION_ROLLBACK_FAILED"
      | "GOOGLE_SHEET_CONFLICT"
      | "ROTATION_ALREADY_PENDING",
  ) {
    super(
      code === "GOOGLE_PERMISSION_ROLLBACK_FAILED"
        ? "Sharing failed and the Google Drive permission could not be rolled back. Remove it manually before retrying."
        : code === "GOOGLE_SHEET_CONFLICT"
          ? "The Google Sheet changed during key rotation. Reload before retrying."
          : code === "ROTATION_ALREADY_PENDING"
            ? "A staged workbook-key rotation must be recovered and resumed instead of generating another key."
            : "The ZeroSheet security service rejected the operation.",
    );
    this.name = "SecureWorkbookClientError";
  }
}

/**
 * The private key is generated and phrase-encrypted locally. The API receives
 * only public directory material plus the encrypted Capsule; Google appData
 * receives a second copy of that same encrypted Capsule when Drive is ready.
 */
export async function createAndRegisterEncryptionIdentity(input: {
  readonly recoveryPhrase: string;
  readonly keyVersion: number;
}): Promise<{
  readonly publicKey: UserPublicEncryptionKey;
  readonly privateKey: CryptoKey;
  readonly driveBackupStored: boolean;
}> {
  const created = await createUserEncryptionIdentity(input);
  const encodedBackup = bytesToBase64Url(created.encryptedPrivateKeyBackup);
  let driveBackupStored = false;
  try {
    await apiJson(
      "/api/encryption/identities",
      {
        method: "POST",
        body: JSON.stringify({
          publicKey: created.publicKey,
          encryptedPrivateKeyBackup: encodedBackup,
        }),
      },
      EncryptionIdentityResponseSchema,
    );
    try {
      await googleWorkspaceStorage.putEncryptedPrivateKeyBackup(
        input.keyVersion,
        created.encryptedPrivateKeyBackup,
      );
      driveBackupStored = true;
    } catch {
      // The database Capsule remains a valid recovery source. The UI should
      // state that the optional Google appData backup needs a later retry.
    }
    return {
      publicKey: created.publicKey,
      privateKey: created.privateKey,
      driveBackupStored,
    };
  } finally {
    created.encryptedPrivateKeyBackup.fill(0);
  }
}

/** Recover the current HPKE private key without returning the Capsule bytes. */
export async function recoverEncryptionIdentity(
  recoveryPhrase: string,
): Promise<{
  readonly publicKey: UserPublicEncryptionKey;
  readonly privateKey: CryptoKey;
}> {
  const identity = await apiJson(
    "/api/encryption/identities/me",
    { method: "GET" },
    EncryptionIdentityResponseSchema,
  );
  const encryptedBackup = base64UrlToBytes(identity.encryptedPrivateKeyBackup);
  try {
    return {
      publicKey: identity.publicKey,
      privateKey: await openUserPrivateKeyBackup({
        encryptedPrivateKeyBackup: encryptedBackup,
        recoveryPhrase,
        publicKey: identity.publicKey,
      }),
    };
  } finally {
    encryptedBackup.fill(0);
  }
}

/**
 * Fetch only the acting user's encrypted backup version required by each
 * envelope, open it with the phrase locally, and import the resulting workbook
 * key as non-extractable. Old identity versions remain necessary for old HPKE
 * envelopes and are never silently replaced by the current directory key.
 */
export async function recoverWorkbookEncryptionAccess(input: {
  readonly workbookId: string;
  readonly recoveryPhrase: string;
}): Promise<{
  readonly spreadsheetId: string;
  readonly sheetId: string;
  readonly sheetTitle: string;
  readonly active: { readonly keyVersion: number; readonly key: CryptoKey };
  readonly pending: {
    readonly keyVersion: number;
    readonly key: CryptoKey;
  } | null;
}> {
  const access = await apiJson(
    `/api/workbooks/${input.workbookId}/encryption`,
    { method: "GET" },
    WorkbookEncryptionAccessResponseSchema,
  );
  const activeKey = await importEnvelopeWithRecoveryPhrase(
    input.workbookId,
    access.envelope,
    input.recoveryPhrase,
  );
  const pending = access.pendingRotation
    ? {
        keyVersion: access.pendingRotation.toKeyVersion,
        key: await importEnvelopeWithRecoveryPhrase(
          input.workbookId,
          access.pendingRotation.envelope,
          input.recoveryPhrase,
        ),
      }
    : null;
  return {
    spreadsheetId: access.googleSpreadsheetId,
    sheetId: String(access.googleSheetId),
    sheetTitle: access.googleSheetTitle,
    active: { keyVersion: access.activeKeyVersion, key: activeKey },
    pending,
  };
}

/**
 * Create the Google file, discover its stable tab identity, then durably store
 * the creator envelope before any encrypted cell is uploaded. An orphaned
 * empty Google file is recoverable; orphaned ciphertext with no envelope is not.
 */
export async function initializeEncryptedWorkbook(input: {
  readonly workbookId: string;
  readonly title: string;
  readonly creatorPublicKey: UserPublicEncryptionKey;
}): Promise<{
  readonly spreadsheetId: string;
  readonly sheetId: string;
  readonly sheetTitle: string;
  readonly keyVersion: 1;
  readonly key: CryptoKey;
}> {
  const rawKey = generateWorkbookKeyBytes();
  try {
    const [key, file] = await Promise.all([
      importWorkbookKey(rawKey),
      googleWorkspaceStorage.createSpreadsheet({
        title: input.title,
        zerosheetWorkbookId: input.workbookId,
      }),
    ]);
    const tabs = await googleWorkspaceStorage.listSpreadsheetTabs(file.id);
    const firstTab = tabs[0];
    if (!firstTab) {
      throw new SecureWorkbookClientError("ZEROSHEET_API_FAILED");
    }
    const creatorEnvelope = await sealWorkbookKeyForRecipient({
      workbookId: input.workbookId,
      workbookKeyVersion: 1,
      workbookKeyBytes: rawKey,
      recipient: input.creatorPublicKey,
    });
    const state = await apiJson(
      `/api/workbooks/${input.workbookId}/encryption`,
      {
        method: "POST",
        body: JSON.stringify({
          googleSpreadsheetId: file.id,
          googleSheetId: firstTab.id,
          googleSheetTitle: firstTab.title,
          creatorEnvelope,
        }),
      },
      WorkbookEncryptionStateResponseSchema,
    );
    return {
      spreadsheetId: state.googleSpreadsheetId,
      sheetId: String(state.googleSheetId),
      sheetTitle: state.googleSheetTitle,
      keyVersion: 1,
      key,
    };
  } finally {
    rawKey.fill(0);
  }
}

/**
 * Google permission is created before the API activates OpenFGA access. On an
 * API failure it is removed immediately; even a failed rollback exposes only
 * ciphertext because the recipient envelope never became authorized.
 */
export async function shareEncryptedWorkbookWithUser(input: {
  readonly workbookId: string;
  readonly recipientUserId: string;
  readonly role: "editor" | "viewer";
  readonly recoveryPhrase: string;
}) {
  // A non-extractable CryptoKey is excellent for cell encryption but cannot be
  // fed into HPKE after a reload. Recover the active envelope only inside this
  // operation, seal its bytes to the recipient, and clear them before making
  // the Google/API mutations. The caller never has to retain an extractable key.
  const [recipient, access] = await Promise.all([
    apiJson(
      `/api/workbooks/${input.workbookId}/encryption/recipients/${input.recipientUserId}/key`,
      { method: "GET" },
      RecipientEncryptionKeyResponseSchema,
    ),
    apiJson(
      `/api/workbooks/${input.workbookId}/encryption`,
      { method: "GET" },
      WorkbookEncryptionAccessResponseSchema,
    ),
  ]);
  const rawWorkbookKey = await openEnvelopeBytesWithRecoveryPhrase(
    input.workbookId,
    access.envelope,
    input.recoveryPhrase,
  );
  let recipientEnvelope: WorkbookKeyEnvelope;
  try {
    recipientEnvelope = await sealWorkbookKeyForRecipient({
      workbookId: input.workbookId,
      workbookKeyVersion: access.activeKeyVersion,
      workbookKeyBytes: rawWorkbookKey,
      recipient: recipient.publicKey,
    });
  } finally {
    rawWorkbookKey.fill(0);
  }
  const permission = await googleWorkspaceStorage.createUserPermission({
    spreadsheetId: access.googleSpreadsheetId,
    email: recipient.email,
    role: input.role === "editor" ? "writer" : "reader",
  });

  try {
    return await apiJson(
      `/api/workbooks/${input.workbookId}/secure-shares/users/${input.recipientUserId}`,
      {
        method: "PUT",
        body: JSON.stringify({
          role: input.role,
          googlePermissionId: permission.id,
          recipientEnvelope,
        }),
      },
      WorkbookShareResponseSchema,
    );
  } catch (error) {
    try {
      await googleWorkspaceStorage.deletePermission(
        access.googleSpreadsheetId,
        permission.id,
      );
    } catch {
      throw new SecureWorkbookClientError("GOOGLE_PERMISSION_ROLLBACK_FAILED");
    }
    throw error;
  }
}

export type RotationResult =
  | {
      readonly status: "complete";
      readonly keyVersion: number;
      readonly key: CryptoKey;
    }
  | {
      readonly status: "pending";
      readonly keyVersion: number;
      readonly key: CryptoKey;
      readonly googleReencrypted: boolean;
      readonly googlePermissionRemoved: boolean;
      readonly reason: unknown;
    };

interface RotationContentInput {
  readonly workbookId: string;
  readonly spreadsheetId: string;
  readonly revokedUserId: string;
  readonly sheetId: string;
  readonly sheetTitle: string;
  readonly range: GridRange;
  readonly cells: readonly (readonly EditorCell[])[];
  readonly protection: CellProtectionMap;
}

/**
 * Stage envelopes first, rewrite all protected values with the next key, remove
 * the old Drive permission, then commit the new active version and OpenFGA
 * revocation. A post-stage failure returns the usable new key so the UI can
 * resume; after reload the owner's pending HPKE envelope provides recovery.
 */
export async function rotateWorkbookKeyAndRevoke(
  input: RotationContentInput,
): Promise<RotationResult> {
  const plan = await apiJson(
    `/api/workbooks/${input.workbookId}/encryption/rotations/revoke/${input.revokedUserId}/plan`,
    { method: "GET" },
    WorkbookRotationPlanResponseSchema,
  );
  if (plan.rotationState === "pending") {
    throw new SecureWorkbookClientError("ROTATION_ALREADY_PENDING");
  }
  const rawKey = generateWorkbookKeyBytes();
  let key: CryptoKey;
  try {
    key = await importWorkbookKey(rawKey);
    const remainingRecipientEnvelopes = await Promise.all(
      plan.remainingRecipients.map(async (recipient) => ({
        userId: recipient.userId,
        envelope: await sealWorkbookKeyForRecipient({
          workbookId: input.workbookId,
          workbookKeyVersion: plan.toKeyVersion,
          workbookKeyBytes: rawKey,
          recipient: recipient.publicKey,
        }),
      })),
    );
    await apiJson(
      `/api/workbooks/${input.workbookId}/encryption/rotations`,
      {
        method: "POST",
        body: JSON.stringify({
          revokedUserId: input.revokedUserId,
          toKeyVersion: plan.toKeyVersion,
          remainingRecipientEnvelopes,
        }),
      },
      WorkbookRotationResponseSchema,
    );
  } finally {
    rawKey.fill(0);
  }

  return finishStagedRotation(input, plan, key);
}

/**
 * Resume after a tab close, network loss, or API outage. The caller obtains
 * `pendingKey` from `recoverWorkbookEncryptionAccess`, so this path never
 * invents a second key for an already staged version.
 */
export async function resumeWorkbookKeyRotation(
  input: RotationContentInput & { readonly pendingKey: CryptoKey },
): Promise<RotationResult> {
  const plan = await apiJson(
    `/api/workbooks/${input.workbookId}/encryption/rotations/revoke/${input.revokedUserId}/plan`,
    { method: "GET" },
    WorkbookRotationPlanResponseSchema,
  );
  if (plan.rotationState !== "pending") {
    throw new SecureWorkbookClientError("ZEROSHEET_API_FAILED");
  }
  return finishStagedRotation(input, plan, input.pendingKey);
}

async function finishStagedRotation(
  input: RotationContentInput,
  plan: WorkbookRotationPlanResponse,
  key: CryptoKey,
): Promise<RotationResult> {
  let googleReencrypted = false;
  let googlePermissionRemoved = false;
  try {
    const versionBefore = await googleWorkspaceStorage.getSpreadsheet(
      input.spreadsheetId,
    );
    const context: SheetCipherContext = {
      workbookId: input.workbookId,
      sheetId: input.sheetId,
      sheetTitle: input.sheetTitle,
      keyVersion: plan.toKeyVersion,
      key,
    };
    const encoded = await encodeGoogleRange({
      context,
      range: input.range,
      // Rotation can take long enough for a user to continue editing. Capture
      // the exact plaintext snapshot that belongs to this version transition.
      cells: input.cells.map((row) => row.map((cell) => ({ ...cell }))),
      protection: input.protection.clone(),
    });
    const versionImmediatelyBeforeWrite =
      await googleWorkspaceStorage.getSpreadsheet(input.spreadsheetId);
    if (versionBefore.version !== versionImmediatelyBeforeWrite.version) {
      throw new SecureWorkbookClientError("GOOGLE_SHEET_CONFLICT");
    }
    await googleWorkspaceStorage.batchWriteValues(input.spreadsheetId, [
      encoded.valueRange,
    ]);
    googleReencrypted = true;

    await googleWorkspaceStorage.deletePermission(
      input.spreadsheetId,
      plan.googlePermissionId,
    );
    googlePermissionRemoved = true;

    await apiJson(
      `/api/workbooks/${input.workbookId}/encryption/rotations/${plan.toKeyVersion}/commit`,
      { method: "POST" },
      WorkbookRotationResponseSchema,
    );
    return { status: "complete", keyVersion: plan.toKeyVersion, key };
  } catch (reason) {
    return {
      status: "pending",
      keyVersion: plan.toKeyVersion,
      key,
      googleReencrypted,
      googlePermissionRemoved,
      reason,
    };
  }
}

async function importEnvelopeWithRecoveryPhrase(
  workbookId: string,
  envelope: WorkbookKeyEnvelope,
  recoveryPhrase: string,
): Promise<CryptoKey> {
  const rawWorkbookKey = await openEnvelopeBytesWithRecoveryPhrase(
    workbookId,
    envelope,
    recoveryPhrase,
  );
  try {
    return await importWorkbookKey(rawWorkbookKey);
  } finally {
    rawWorkbookKey.fill(0);
  }
}

/**
 * Open one envelope only long enough for an operation that genuinely needs
 * bytes, such as sealing the same workbook key to a new recipient. Callers own
 * the returned array and must clear it in a `finally` block.
 */
async function openEnvelopeBytesWithRecoveryPhrase(
  workbookId: string,
  envelope: WorkbookKeyEnvelope,
  recoveryPhrase: string,
): Promise<Uint8Array> {
  const identity = await apiJson(
    `/api/encryption/identities/me/${envelope.recipientKeyVersion}`,
    { method: "GET" },
    EncryptionIdentityResponseSchema,
  );
  const encryptedBackup = base64UrlToBytes(identity.encryptedPrivateKeyBackup);
  try {
    const privateKey = await openUserPrivateKeyBackup({
      encryptedPrivateKeyBackup: encryptedBackup,
      recoveryPhrase,
      publicKey: identity.publicKey,
    });
    return await openWorkbookKeyEnvelope({
      workbookId,
      envelope,
      recipientPublicKey: identity.publicKey,
      recipientPrivateKey: privateKey,
    });
  } finally {
    encryptedBackup.fill(0);
  }
}

async function apiJson<T>(
  path: string,
  init: RequestInit,
  schema: { parse(value: unknown): T },
): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
      ...(init.body === undefined
        ? {}
        : { "Content-Type": "application/json" }),
      ...init.headers,
    },
  });
  const body = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) throw new SecureWorkbookClientError("ZEROSHEET_API_FAILED");
  return schema.parse(body);
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  const standard = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = standard.padEnd(Math.ceil(standard.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
