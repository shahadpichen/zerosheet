import { GoogleStorageError } from "./errors.js";
import type { AuthorizedGoogleRequest } from "./request.js";
import type {
  GoogleCellScalar,
  GoogleDrivePermission,
  GoogleReadRange,
  GoogleSheetTab,
  GoogleSpreadsheetFile,
  GoogleValueRange,
} from "./types.js";

const GOOGLE_SHEETS_MIME_TYPE = "application/vnd.google-apps.spreadsheet";
const PRIVATE_KEY_BACKUP_MIME_TYPE =
  "application/vnd.zerosheet.encrypted-private-key";
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const MAX_VALUE_RANGES = 100;
const MAX_CELLS_PER_WRITE = 10_000;
const MAX_PRIVATE_KEY_BACKUP_BYTES = 256 * 1024;

/**
 * One adapter owns every Google Drive and Sheets endpoint ZeroSheet may call.
 * The editor supplies already encrypted protected cells; this class performs no
 * cryptography and never receives a recovery phrase, private key, or workbook
 * key. Unprotected cells are intentionally visible to Google.
 */
export class GoogleWorkspaceStorage {
  public constructor(private readonly request: AuthorizedGoogleRequest) {}

  /** Create a Google-owned spreadsheet that the current OAuth user owns. */
  public async createSpreadsheet(input: {
    readonly title: string;
    readonly zerosheetWorkbookId: string;
  }): Promise<GoogleSpreadsheetFile> {
    const title = assertTitle(input.title);
    assertUuid(input.zerosheetWorkbookId);

    const query = new URLSearchParams({
      fields: "id,name,mimeType,version,modifiedTime,webViewLink",
    });
    const response = await this.request.send({
      api: "drive",
      path: "/drive/v3/files",
      method: "POST",
      query,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: title,
        mimeType: GOOGLE_SHEETS_MIME_TYPE,
        appProperties: {
          zerosheetWorkbookId: input.zerosheetWorkbookId,
          zerosheetFormatVersion: "1",
        },
      }),
    });

    return parseSpreadsheetFile(await readBoundedJson(response));
  }

  /** Read only the metadata needed for synchronization and user navigation. */
  public async getSpreadsheet(
    spreadsheetId: string,
  ): Promise<GoogleSpreadsheetFile> {
    assertGoogleResourceId(spreadsheetId);
    const query = new URLSearchParams({
      fields: "id,name,mimeType,version,modifiedTime,webViewLink,trashed",
    });
    const response = await this.request.send({
      api: "drive",
      path: `/drive/v3/files/${encodeURIComponent(spreadsheetId)}`,
      query,
    });
    const value = await readBoundedJson(response);

    if (isRecord(value) && value.trashed === true) {
      throw new GoogleStorageError("GOOGLE_RESOURCE_NOT_FOUND");
    }
    return parseSpreadsheetFile(value);
  }

  /**
   * AAD uses Google's stable numeric tab ID, while A1 requests need the human
   * title. Reading both from Google prevents a caller from inventing either
   * value when binding a new ZeroSheet workbook.
   */
  public async listSpreadsheetTabs(
    spreadsheetId: string,
  ): Promise<GoogleSheetTab[]> {
    assertGoogleResourceId(spreadsheetId);
    const response = await this.request.send({
      api: "sheets",
      path: `/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}`,
      query: new URLSearchParams({
        fields:
          "sheets.properties(sheetId,title,gridProperties(rowCount,columnCount))",
      }),
    });
    return parseSpreadsheetTabs(await readBoundedJson(response));
  }

  /**
   * Google Drive permission and ZeroSheet/OpenFGA access are intentionally
   * independent. The browser creates this permission first, then submits its
   * opaque ID together with the HPKE envelope to the ZeroSheet API.
   */
  public async createUserPermission(input: {
    readonly spreadsheetId: string;
    readonly email: string;
    readonly role: "reader" | "writer";
  }): Promise<GoogleDrivePermission> {
    assertGoogleResourceId(input.spreadsheetId);
    const email = assertEmail(input.email);
    const response = await this.request.send({
      api: "drive",
      path: `/drive/v3/files/${encodeURIComponent(input.spreadsheetId)}/permissions`,
      method: "POST",
      query: new URLSearchParams({
        fields: "id",
        sendNotificationEmail: "false",
        supportsAllDrives: "true",
      }),
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "user",
        role: input.role,
        emailAddress: email,
      }),
    });
    return parseDrivePermission(await readBoundedJson(response));
  }

  /**
   * Delete only the exact opaque permission returned by Google. Revocation
   * also rotates the workbook key because a removed user may have retained the
   * old key or an earlier Google revision.
   */
  public async deletePermission(
    spreadsheetId: string,
    permissionId: string,
  ): Promise<void> {
    assertGoogleResourceId(spreadsheetId);
    assertGoogleResourceId(permissionId);
    try {
      await this.request.send({
        api: "drive",
        path: `/drive/v3/files/${encodeURIComponent(spreadsheetId)}/permissions/${encodeURIComponent(permissionId)}`,
        method: "DELETE",
        query: new URLSearchParams({ supportsAllDrives: "true" }),
      });
    } catch (error) {
      // A retried rotation may have deleted the permission before an API commit
      // failed. Google's 404 is therefore the same safe end state: that exact
      // permission no longer grants access.
      if (
        error instanceof GoogleStorageError &&
        error.code === "GOOGLE_RESOURCE_NOT_FOUND"
      ) {
        return;
      }
      throw error;
    }
  }

  /**
   * Read formulas as formulas rather than Google's calculated display text.
   * Ciphertext cells remain ordinary strings, while numbers and booleans retain
   * their JSON types for the local spreadsheet engine.
   */
  public async batchReadValues(
    spreadsheetId: string,
    ranges: readonly string[],
  ): Promise<GoogleReadRange[]> {
    assertGoogleResourceId(spreadsheetId);
    assertRanges(ranges);
    const query = new URLSearchParams({
      majorDimension: "ROWS",
      valueRenderOption: "FORMULA",
      dateTimeRenderOption: "SERIAL_NUMBER",
    });
    for (const range of ranges) query.append("ranges", range);

    const response = await this.request.send({
      api: "sheets",
      path: `/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values:batchGet`,
      query,
    });
    return parseReadRanges(await readBoundedJson(response));
  }

  /**
   * RAW is a security boundary: Google must store `zs1` ciphertext and local
   * formulas literally rather than interpreting attacker-controlled strings as
   * Sheets formulas during transport.
   */
  public async batchWriteValues(
    spreadsheetId: string,
    ranges: readonly GoogleValueRange[],
  ): Promise<number> {
    assertGoogleResourceId(spreadsheetId);
    const cellCount = assertValueRanges(ranges);
    const response = await this.request.send({
      api: "sheets",
      path: `/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values:batchUpdate`,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        valueInputOption: "RAW",
        includeValuesInResponse: false,
        data: ranges,
      }),
    });
    const value = await readBoundedJson(response);

    if (
      !isRecord(value) ||
      typeof value.totalUpdatedCells !== "number" ||
      !Number.isSafeInteger(value.totalUpdatedCells) ||
      value.totalUpdatedCells < 0 ||
      value.totalUpdatedCells > cellCount
    ) {
      throw new GoogleStorageError("GOOGLE_INVALID_RESPONSE");
    }
    return value.totalUpdatedCells;
  }

  public async batchClearValues(
    spreadsheetId: string,
    ranges: readonly string[],
  ): Promise<void> {
    assertGoogleResourceId(spreadsheetId);
    assertRanges(ranges);
    await this.request.send({
      api: "sheets",
      path: `/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values:batchClear`,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ranges }),
    });
  }

  /**
   * Store only the Capsule-encrypted user private key in appDataFolder. Google
   * hides this file from normal Drive UI, but that is organization—not an
   * encryption control. The 12-word phrase is still required to open it.
   */
  public async putEncryptedPrivateKeyBackup(
    keyVersion: number,
    encryptedBackup: Uint8Array,
  ): Promise<{ id: string; version: string }> {
    assertPositiveUint32(keyVersion);
    if (
      encryptedBackup.byteLength < 1 ||
      encryptedBackup.byteLength > MAX_PRIVATE_KEY_BACKUP_BYTES
    ) {
      throw new GoogleStorageError("GOOGLE_INVALID_INPUT");
    }

    const name = privateKeyBackupName(keyVersion);
    const existing = await this.findAppDataFile(name);
    const boundary = `zerosheet_${globalThis.crypto.randomUUID().replaceAll("-", "")}`;
    const metadata = {
      name,
      mimeType: PRIVATE_KEY_BACKUP_MIME_TYPE,
      appProperties: {
        zerosheetObjectKind: "encrypted-user-private-key",
        zerosheetKeyVersion: String(keyVersion),
      },
      ...(existing === undefined ? { parents: ["appDataFolder"] } : {}),
    };
    const body = multipartRelatedBody(boundary, metadata, encryptedBackup);
    const path = existing
      ? `/upload/drive/v3/files/${encodeURIComponent(existing.id)}`
      : "/upload/drive/v3/files";
    const response = await this.request.send({
      api: "drive",
      path,
      method: existing ? "PATCH" : "POST",
      query: new URLSearchParams({
        uploadType: "multipart",
        fields: "id,version",
      }),
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
      body,
    });

    return parseFileVersion(await readBoundedJson(response));
  }

  public async getEncryptedPrivateKeyBackup(
    keyVersion: number,
  ): Promise<Uint8Array | null> {
    assertPositiveUint32(keyVersion);
    const file = await this.findAppDataFile(privateKeyBackupName(keyVersion));
    if (!file) return null;

    const response = await this.request.send({
      api: "drive",
      path: `/drive/v3/files/${encodeURIComponent(file.id)}`,
      query: new URLSearchParams({ alt: "media" }),
    });
    const declaredLength = Number(response.headers.get("Content-Length"));
    if (
      Number.isFinite(declaredLength) &&
      declaredLength > MAX_PRIVATE_KEY_BACKUP_BYTES
    ) {
      throw new GoogleStorageError("GOOGLE_INVALID_RESPONSE");
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (
      bytes.byteLength < 1 ||
      bytes.byteLength > MAX_PRIVATE_KEY_BACKUP_BYTES
    ) {
      bytes.fill(0);
      throw new GoogleStorageError("GOOGLE_INVALID_RESPONSE");
    }
    return bytes;
  }

  private async findAppDataFile(
    name: string,
  ): Promise<{ id: string; version: string } | undefined> {
    const query = new URLSearchParams({
      spaces: "appDataFolder",
      q: `name='${name}' and trashed=false`,
      pageSize: "2",
      fields: "files(id,version)",
    });
    const response = await this.request.send({
      api: "drive",
      path: "/drive/v3/files",
      query,
    });
    const value = await readBoundedJson(response);

    if (!isRecord(value) || !Array.isArray(value.files)) {
      throw new GoogleStorageError("GOOGLE_INVALID_RESPONSE");
    }
    if (value.files.length > 1) {
      // A duplicate backup name is ambiguous. Guessing which private key to
      // use could make a user believe recovery is safe when it is not.
      throw new GoogleStorageError("GOOGLE_INVALID_RESPONSE");
    }
    return value.files.length === 0
      ? undefined
      : parseFileVersion(value.files[0]);
  }
}

function privateKeyBackupName(keyVersion: number): string {
  return `zerosheet-private-key-v${keyVersion}.capsule`;
}

function multipartRelatedBody(
  boundary: string,
  metadata: object,
  bytes: Uint8Array,
): Blob {
  const newline = "\r\n";
  const binaryCopy = Uint8Array.from(bytes);
  try {
    // Copy into a concrete ArrayBuffer because BlobPart deliberately rejects a
    // SharedArrayBuffer-backed view. Blob snapshots the bytes synchronously,
    // allowing this temporary source array to be cleared immediately.
    return new Blob(
      [
        `--${boundary}${newline}`,
        `Content-Type: application/json; charset=UTF-8${newline}${newline}`,
        JSON.stringify(metadata),
        newline,
        `--${boundary}${newline}`,
        `Content-Type: ${PRIVATE_KEY_BACKUP_MIME_TYPE}${newline}${newline}`,
        binaryCopy.buffer,
        newline,
        `--${boundary}--${newline}`,
      ],
      { type: `multipart/related; boundary=${boundary}` },
    );
  } finally {
    binaryCopy.fill(0);
  }
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new GoogleStorageError("GOOGLE_INVALID_RESPONSE");
  }
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) {
    throw new GoogleStorageError("GOOGLE_INVALID_RESPONSE");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new GoogleStorageError("GOOGLE_INVALID_RESPONSE", { cause: error });
  }
}

function parseSpreadsheetFile(value: unknown): GoogleSpreadsheetFile {
  if (
    !isRecord(value) ||
    value.mimeType !== GOOGLE_SHEETS_MIME_TYPE ||
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    typeof value.version !== "string" ||
    typeof value.modifiedTime !== "string" ||
    typeof value.webViewLink !== "string"
  ) {
    throw new GoogleStorageError("GOOGLE_INVALID_RESPONSE");
  }
  assertGoogleResourceId(value.id, "GOOGLE_INVALID_RESPONSE");
  if (
    value.name.length < 1 ||
    value.name.length > 1_000 ||
    !isRfc3339(value.modifiedTime) ||
    !isHttpsUrl(value.webViewLink)
  ) {
    throw new GoogleStorageError("GOOGLE_INVALID_RESPONSE");
  }
  return {
    id: value.id,
    name: value.name,
    version: value.version,
    modifiedTime: value.modifiedTime,
    webViewLink: value.webViewLink,
  };
}

function parseSpreadsheetTabs(value: unknown): GoogleSheetTab[] {
  if (!isRecord(value) || !Array.isArray(value.sheets)) {
    throw new GoogleStorageError("GOOGLE_INVALID_RESPONSE");
  }
  return value.sheets.map((sheet) => {
    if (!isRecord(sheet) || !isRecord(sheet.properties)) {
      throw new GoogleStorageError("GOOGLE_INVALID_RESPONSE");
    }
    const properties = sheet.properties;
    const grid = properties.gridProperties;
    if (
      !isRecord(grid) ||
      typeof properties.sheetId !== "number" ||
      !Number.isSafeInteger(properties.sheetId) ||
      properties.sheetId < 0 ||
      typeof properties.title !== "string" ||
      properties.title.length < 1 ||
      properties.title.length > 100 ||
      typeof grid.rowCount !== "number" ||
      !Number.isSafeInteger(grid.rowCount) ||
      grid.rowCount < 1 ||
      typeof grid.columnCount !== "number" ||
      !Number.isSafeInteger(grid.columnCount) ||
      grid.columnCount < 1
    ) {
      throw new GoogleStorageError("GOOGLE_INVALID_RESPONSE");
    }
    return {
      id: properties.sheetId,
      title: properties.title,
      rowCount: grid.rowCount,
      columnCount: grid.columnCount,
    };
  });
}

function parseDrivePermission(value: unknown): GoogleDrivePermission {
  if (!isRecord(value) || typeof value.id !== "string") {
    throw new GoogleStorageError("GOOGLE_INVALID_RESPONSE");
  }
  assertGoogleResourceId(value.id, "GOOGLE_INVALID_RESPONSE");
  return { id: value.id };
}

function parseFileVersion(value: unknown): { id: string; version: string } {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.version !== "string"
  ) {
    throw new GoogleStorageError("GOOGLE_INVALID_RESPONSE");
  }
  assertGoogleResourceId(value.id, "GOOGLE_INVALID_RESPONSE");
  if (!/^[1-9][0-9]*$/u.test(value.version)) {
    throw new GoogleStorageError("GOOGLE_INVALID_RESPONSE");
  }
  return { id: value.id, version: value.version };
}

function parseReadRanges(value: unknown): GoogleReadRange[] {
  if (!isRecord(value) || !Array.isArray(value.valueRanges)) {
    throw new GoogleStorageError("GOOGLE_INVALID_RESPONSE");
  }
  return value.valueRanges.map((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.range !== "string" ||
      !Array.isArray(entry.values)
    ) {
      throw new GoogleStorageError("GOOGLE_INVALID_RESPONSE");
    }
    const values = entry.values.map((row) => {
      if (!Array.isArray(row)) {
        throw new GoogleStorageError("GOOGLE_INVALID_RESPONSE");
      }
      return row.map((cell) => {
        if (
          cell !== null &&
          typeof cell !== "string" &&
          typeof cell !== "boolean" &&
          (typeof cell !== "number" || !Number.isFinite(cell))
        ) {
          throw new GoogleStorageError("GOOGLE_INVALID_RESPONSE");
        }
        return cell as GoogleCellScalar;
      });
    });
    return { range: entry.range, values };
  });
}

function assertValueRanges(ranges: readonly GoogleValueRange[]): number {
  assertRanges(ranges.map(({ range }) => range));
  let cellCount = 0;
  for (const item of ranges) {
    if (!Array.isArray(item.values) || item.values.length < 1) {
      throw new GoogleStorageError("GOOGLE_INVALID_INPUT");
    }
    for (const row of item.values) {
      if (!Array.isArray(row) || row.length < 1) {
        throw new GoogleStorageError("GOOGLE_INVALID_INPUT");
      }
      for (const cell of row) {
        if (
          cell !== null &&
          typeof cell !== "string" &&
          typeof cell !== "boolean" &&
          (typeof cell !== "number" || !Number.isFinite(cell))
        ) {
          throw new GoogleStorageError("GOOGLE_INVALID_INPUT");
        }
        cellCount += 1;
      }
    }
  }
  if (cellCount < 1 || cellCount > MAX_CELLS_PER_WRITE) {
    throw new GoogleStorageError("GOOGLE_INVALID_INPUT");
  }
  return cellCount;
}

function assertRanges(ranges: readonly string[]): void {
  if (ranges.length < 1 || ranges.length > MAX_VALUE_RANGES) {
    throw new GoogleStorageError("GOOGLE_INVALID_INPUT");
  }
  for (const range of ranges) {
    if (
      range.length < 1 ||
      range.length > 512 ||
      range.trim() !== range ||
      containsAsciiControlCharacter(range)
    ) {
      throw new GoogleStorageError("GOOGLE_INVALID_INPUT");
    }
  }
}

function assertTitle(title: string): string {
  const normalized = title.trim();
  if (
    normalized.length < 1 ||
    normalized.length > 200 ||
    containsAsciiControlCharacter(normalized)
  ) {
    throw new GoogleStorageError("GOOGLE_INVALID_INPUT");
  }
  return normalized;
}

function assertEmail(email: string): string {
  if (
    email.length < 3 ||
    email.length > 254 ||
    email.trim() !== email ||
    containsAsciiControlCharacter(email) ||
    !/^[^\s@]+@[^\s@]+$/u.test(email)
  ) {
    throw new GoogleStorageError("GOOGLE_INVALID_INPUT");
  }
  return email;
}

function assertUuid(value: string): void {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  ) {
    throw new GoogleStorageError("GOOGLE_INVALID_INPUT");
  }
}

function assertGoogleResourceId(
  value: string,
  code:
    "GOOGLE_INVALID_INPUT" | "GOOGLE_INVALID_RESPONSE" = "GOOGLE_INVALID_INPUT",
): void {
  if (!/^[A-Za-z0-9_-]{10,200}$/u.test(value)) {
    throw new GoogleStorageError(code);
  }
}

function assertPositiveUint32(value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > 0xffff_ffff) {
    throw new GoogleStorageError("GOOGLE_INVALID_INPUT");
  }
}

function containsAsciiControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) {
      return true;
    }
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRfc3339(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(value);
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}
