export const GOOGLE_DRIVE_FILE_SCOPE =
  "https://www.googleapis.com/auth/drive.file" as const;
export const GOOGLE_DRIVE_APPDATA_SCOPE =
  "https://www.googleapis.com/auth/drive.appdata" as const;

/** Only these two narrow grants are required by the first storage adapter. */
export const GOOGLE_STORAGE_REQUIRED_SCOPES = [
  GOOGLE_DRIVE_FILE_SCOPE,
  GOOGLE_DRIVE_APPDATA_SCOPE,
] as const;

export interface GoogleAccessToken {
  readonly value: string;
  readonly expiresAt: Date;
}

/**
 * The BFF owns offline refresh credentials. The browser adapter receives only
 * a short-lived bearer token and may explicitly request one refresh after a
 * 401. Implementations must keep the value in memory and never persist it.
 */
export interface GoogleAccessTokenProvider {
  getAccessToken(options?: {
    readonly forceRefresh?: boolean;
  }): Promise<GoogleAccessToken>;
  clear(): void;
}

export type GoogleCellScalar = string | number | boolean | null;

export interface GoogleValueRange {
  readonly range: string;
  readonly values: readonly (readonly GoogleCellScalar[])[];
}

export interface GoogleSpreadsheetFile {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly modifiedTime: string;
  readonly webViewLink: string;
}

export interface GoogleReadRange {
  readonly range: string;
  readonly values: GoogleCellScalar[][];
}

export interface GoogleSheetTab {
  readonly id: number;
  readonly title: string;
  readonly rowCount: number;
  readonly columnCount: number;
}

export interface GoogleDrivePermission {
  readonly id: string;
}

/**
 * Read-only provider metadata used for owner-assisted drift review. It carries
 * no access token or workbook content. Email is optional because Drive omits it
 * for domain/anyone grants and some deleted identities.
 */
export interface GoogleDrivePermissionDetails {
  readonly id: string;
  readonly type: "user" | "group" | "domain" | "anyone";
  readonly role:
    "owner" | "organizer" | "fileOrganizer" | "writer" | "commenter" | "reader";
  readonly emailAddress?: string;
  readonly deleted: boolean;
}
