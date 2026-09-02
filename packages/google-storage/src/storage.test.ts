import { describe, expect, it, vi } from "vitest";
import { AuthorizedGoogleRequest } from "./request.js";
import { GoogleWorkspaceStorage } from "./storage.js";
import type { GoogleAccessTokenProvider } from "./types.js";

const workbookId = "3d9a575e-aed9-4634-b9ea-3f00334df680";
const spreadsheetId = "1Spreadsheet_Resource_Id_123";

class StaticTokenProvider implements GoogleAccessTokenProvider {
  public getAccessToken() {
    return Promise.resolve({
      value: "test-access-token",
      expiresAt: new Date("2026-09-03T02:00:00.000Z"),
    });
  }

  public clear(): void {}
}

function storageWithResponses(...responses: Response[]) {
  const fetchMock = vi.fn<typeof fetch>();
  for (const response of responses) fetchMock.mockResolvedValueOnce(response);
  const request = new AuthorizedGoogleRequest({
    tokens: new StaticTokenProvider(),
    fetch: fetchMock,
  });
  return { storage: new GoogleWorkspaceStorage(request), fetchMock };
}

function spreadsheetResponse(): Response {
  return Response.json({
    id: spreadsheetId,
    name: "Encrypted budget",
    mimeType: "application/vnd.google-apps.spreadsheet",
    version: "7",
    modifiedTime: "2026-09-03T01:00:00.000Z",
    webViewLink: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
  });
}

/** Tests fail clearly if production code stops using a JSON string body. */
function jsonRequestBody(init: RequestInit): string {
  if (typeof init.body !== "string") {
    throw new Error("Expected the Google request body to be a JSON string");
  }
  return init.body;
}

describe("GoogleWorkspaceStorage", () => {
  it("creates an app-marked Google spreadsheet without sending a key", async () => {
    const { storage, fetchMock } = storageWithResponses(spreadsheetResponse());

    await expect(
      storage.createSpreadsheet({
        title: "  Encrypted budget  ",
        zerosheetWorkbookId: workbookId,
      }),
    ).resolves.toMatchObject({ id: spreadsheetId, version: "7" });

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.pathname).toBe("/drive/v3/files");
    expect(url.searchParams.get("fields")).toContain("webViewLink");
    const bodyText = jsonRequestBody(init);
    const body = JSON.parse(bodyText) as {
      name: string;
      mimeType: string;
      appProperties: Record<string, string>;
    };
    expect(body).toEqual({
      name: "Encrypted budget",
      mimeType: "application/vnd.google-apps.spreadsheet",
      appProperties: {
        zerosheetWorkbookId: workbookId,
        zerosheetFormatVersion: "1",
      },
    });
    expect(bodyText).not.toContain("recovery");
  });

  it("writes batched values with RAW interpretation and no echoed values", async () => {
    const { storage, fetchMock } = storageWithResponses(
      Response.json({ totalUpdatedCells: 2 }),
    );

    await expect(
      storage.batchWriteValues(spreadsheetId, [
        {
          range: "Sheet1!A1:B1",
          values: [["zs1:1:ciphertext", "=not-executed-by-google"]],
        },
      ]),
    ).resolves.toBe(2);

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(jsonRequestBody(init)) as {
      valueInputOption: string;
      includeValuesInResponse: boolean;
    };
    expect(body.valueInputOption).toBe("RAW");
    expect(body.includeValuesInResponse).toBe(false);
  });

  it("reads formulas and typed values through one batch request", async () => {
    const { storage, fetchMock } = storageWithResponses(
      Response.json({
        valueRanges: [
          {
            range: "Sheet1!A1:C1",
            values: [["zs1:1:ciphertext", 42.5, "=A1+1"]],
          },
        ],
      }),
    );

    await expect(
      storage.batchReadValues(spreadsheetId, ["Sheet1!A1:C1"]),
    ).resolves.toEqual([
      {
        range: "Sheet1!A1:C1",
        values: [["zs1:1:ciphertext", 42.5, "=A1+1"]],
      },
    ]);
    const url = fetchMock.mock.calls[0]?.[0] as URL;
    expect(url.searchParams.get("valueRenderOption")).toBe("FORMULA");
    expect(url.searchParams.getAll("ranges")).toEqual(["Sheet1!A1:C1"]);
  });

  it("reads stable Google tab IDs required by cell AAD", async () => {
    const { storage } = storageWithResponses(
      Response.json({
        sheets: [
          {
            properties: {
              sheetId: 1938472,
              title: "Customers",
              gridProperties: { rowCount: 1000, columnCount: 26 },
            },
          },
        ],
      }),
    );

    await expect(storage.listSpreadsheetTabs(spreadsheetId)).resolves.toEqual([
      { id: 1938472, title: "Customers", rowCount: 1000, columnCount: 26 },
    ]);
  });

  it("creates and removes one exact Google user permission", async () => {
    const { storage, fetchMock } = storageWithResponses(
      Response.json({ id: "1Permission_Resource_Id_123" }),
      new Response(null, { status: 204 }),
    );

    const permission = await storage.createUserPermission({
      spreadsheetId,
      email: "recipient@example.com",
      role: "writer",
    });
    expect(permission.id).toBe("1Permission_Resource_Id_123");
    const [createUrl, createInit] = fetchMock.mock.calls[0] as [
      URL,
      RequestInit,
    ];
    expect(createUrl.pathname).toContain("/permissions");
    expect(createUrl.searchParams.get("sendNotificationEmail")).toBe("false");
    expect(JSON.parse(jsonRequestBody(createInit))).toEqual({
      type: "user",
      role: "writer",
      emailAddress: "recipient@example.com",
    });

    await storage.deletePermission(spreadsheetId, permission.id);
    const [deleteUrl, deleteInit] = fetchMock.mock.calls[1] as [
      URL,
      RequestInit,
    ];
    expect(deleteInit.method).toBe("DELETE");
    expect(deleteUrl.pathname).toContain(permission.id);
  });

  it("treats an already-missing permission as an idempotent revocation", async () => {
    const { storage } = storageWithResponses(
      new Response(null, { status: 404 }),
    );

    await expect(
      storage.deletePermission(
        spreadsheetId,
        "1Permission_Already_Removed_123",
      ),
    ).resolves.toBeUndefined();
  });

  it("creates and reads only an encrypted backup in appDataFolder", async () => {
    const encryptedBackup = new Uint8Array([90, 83, 1, 222, 173, 190, 239]);
    const { storage, fetchMock } = storageWithResponses(
      Response.json({ files: [] }),
      Response.json({ id: "1Private_Key_Backup_Id", version: "3" }),
      Response.json({
        files: [{ id: "1Private_Key_Backup_Id", version: "3" }],
      }),
      new Response(encryptedBackup),
    );

    await expect(
      storage.putEncryptedPrivateKeyBackup(2, encryptedBackup),
    ).resolves.toEqual({ id: "1Private_Key_Backup_Id", version: "3" });

    const uploadUrl = fetchMock.mock.calls[1]?.[0] as URL;
    const uploadInit = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect(uploadUrl.pathname).toBe("/upload/drive/v3/files");
    expect(new Headers(uploadInit.headers).get("Content-Type")).toContain(
      "multipart/related",
    );
    const multipart = await (uploadInit.body as Blob).text();
    expect(multipart).toContain('"parents":["appDataFolder"]');
    expect(multipart).toContain("encrypted-user-private-key");

    const opened = await storage.getEncryptedPrivateKeyBackup(2);
    expect(opened).toEqual(encryptedBackup);
  });

  it("rejects malformed cells and identifiers before sending a request", async () => {
    const { storage, fetchMock } = storageWithResponses();

    await expect(
      storage.batchWriteValues(spreadsheetId, [
        { range: "Sheet1!A1", values: [[Number.NaN]] },
      ]),
    ).rejects.toMatchObject({ code: "GOOGLE_INVALID_INPUT" });
    await expect(
      storage.batchReadValues("https://attacker.example", ["Sheet1!A1"]),
    ).rejects.toMatchObject({ code: "GOOGLE_INVALID_INPUT" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed when appDataFolder contains duplicate backup names", async () => {
    const { storage } = storageWithResponses(
      Response.json({
        files: [
          { id: "1Private_Key_Backup_A", version: "1" },
          { id: "1Private_Key_Backup_B", version: "2" },
        ],
      }),
    );

    await expect(storage.getEncryptedPrivateKeyBackup(1)).rejects.toMatchObject(
      { code: "GOOGLE_INVALID_RESPONSE" },
    );
  });
});
