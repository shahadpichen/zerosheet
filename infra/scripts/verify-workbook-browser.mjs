import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Run the real React/Univer/crypto code in a clean browser. Only the API and
// Google transport are fixtures: no personal account, consent, or Drive writes.
// Supply a bundled Playwright module path if it is not installed locally.
const { chromium } = await import(
  process.env.ZEROSHEET_PLAYWRIGHT_MODULE ?? "playwright"
);
const browser = await chromium.launch({
  headless: true,
  ...(process.env.ZEROSHEET_BROWSER_CHANNEL
    ? { channel: process.env.ZEROSHEET_BROWSER_CHANNEL }
    : {}),
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 1100 },
});
const page = await context.newPage();
const base = process.env.ZEROSHEET_BROWSER_URL ?? "http://localhost:5173";
const artifacts = await mkdtemp(join(tmpdir(), "zerosheet-browser-"));
const user = {
  id: "b1000000-0000-4000-8000-000000000001",
  email: "browser@example.invalid",
  displayName: "Browser Test",
};
const organization = {
  id: "b1000000-0000-4000-8000-000000000002",
  name: "Personal",
};
const workbookId = "b1000000-0000-4000-8000-000000000003";
const fileId = "spreadsheet-browser-fixture";
let identity, workbook, encryption;
const folders = [];
let workspaceReads = 0;
let version = 1;
let values = [];
let googleWrites = 0;
let failNextWrite = false;
let readFailure = null;
let identityWrites = 0;
let failIdentityLookup = true;
let loseIdentityResponse = true;
const failures = [];
page.on("pageerror", (error) => failures.push(error.message));
const json = (route, body, status = 200) =>
  route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });

await page.route(`${base}/api/**`, async (route) => {
  const request = route.request();
  const path = new URL(request.url()).pathname.replace(/^\/api/u, "");
  const method = request.method();
  if (path === "/auth/me") return json(route, { authenticated: true, user });
  if (path === "/workspace") {
    workspaceReads += 1;
    return json(route, {
      workbooks: workbook ? [workbook] : [],
      folders,
      organizations: [organization],
      nextCursor: null,
    });
  }
  if (path === "/workspace/folders" && method === "POST") {
    const folder = {
      id: `b1000000-0000-4000-8000-${String(10 + folders.length).padStart(12, "0")}`,
      ...request.postDataJSON(),
    };
    folders.push(folder);
    return json(route, folder, 201);
  }
  if (
    path === `/workspace/workbooks/${workbookId}/folder` &&
    method === "PUT"
  ) {
    workbook.folderId = request.postDataJSON().folderId;
    return route.fulfill({ status: 204 });
  }
  if (path === `/workspace/workbooks/${workbookId}`)
    return json(route, workbook);
  if (
    path === "/encryption/identities/me" ||
    path === "/encryption/identities/me/1"
  ) {
    if (failIdentityLookup) return json(route, { error: "unavailable" }, 503);
    return json(route, identity ?? { error: "conflict" }, identity ? 200 : 409);
  }
  if (path === "/encryption/identities" && method === "POST") {
    identityWrites += 1;
    identity = { userId: user.id, ...request.postDataJSON() };
    if (loseIdentityResponse) {
      loseIdentityResponse = false;
      return json(route, { error: "response_lost" }, 503);
    }
    return json(route, identity, 201);
  }
  if (
    path === `/organizations/${organization.id}/workbooks` &&
    method === "POST"
  ) {
    workbook = {
      id: workbookId,
      organizationId: organization.id,
      name: request.postDataJSON().name,
      createdBy: user.id,
      createdAt: new Date().toISOString(),
      ready: false,
      folderId: null,
      canEdit: true,
      canShare: true,
    };
    return json(route, workbook, 201);
  }
  if (path === `/workbooks/${workbookId}/encryption`) {
    if (method === "POST") {
      const input = request.postDataJSON();
      encryption = {
        workbookId,
        ...input,
        activeKeyVersion: 1,
        envelope: input.creatorEnvelope,
        pendingRotation: null,
      };
      workbook.ready = true;
      return json(
        route,
        { ...encryption, rotationState: "active", pendingKeyVersion: null },
        201,
      );
    }
    return json(route, encryption);
  }
  if (path === "/google/storage/access-token")
    return json(route, {
      accessToken: "fixture-only-token",
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    });
  throw new Error(`Unexpected fixture API operation: ${method} ${path}`);
});
await page.route(
  /^https:\/\/(www|sheets)\.googleapis\.com\//u,
  async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (url.searchParams.get("spaces") === "appDataFolder")
      return json(route, { files: [] });
    if (url.pathname.startsWith("/upload/"))
      return json(route, { id: "fixture-encrypted-backup", version: "1" });
    if (url.pathname.startsWith("/drive/v3/files"))
      return json(route, {
        id: fileId,
        name: "Budget",
        mimeType: "application/vnd.google-apps.spreadsheet",
        version: String(version),
        modifiedTime: new Date().toISOString(),
        webViewLink: `https://docs.google.com/spreadsheets/d/${fileId}/edit`,
      });
    if (url.pathname.endsWith("/values:batchGet")) {
      if (readFailure === "expired")
        return json(route, { error: "fixture_expired" }, 401);
      if (readFailure === "unavailable")
        return json(route, { error: "fixture_unavailable" }, 503);
      if (readFailure === "malformed")
        return json(route, {
          valueRanges: [{ range: "Sheet1!A1:Z100", values: null }],
        });
      return json(route, {
        // Real Google responses omit `values` for a new, empty spreadsheet.
        // Keeping that shape here prevents the browser fixture from masking a
        // parser bug that would break the very first workbook opening.
        valueRanges: [
          {
            range: "Sheet1!A1:Z100",
            majorDimension: "ROWS",
            ...(values.length ? { values } : {}),
          },
        ],
      });
    }
    if (url.pathname.endsWith("/values:batchUpdate")) {
      if (failNextWrite) {
        failNextWrite = false;
        return json(route, { error: "fixture_unavailable" }, 503);
      }
      values = request.postDataJSON().data[0].values;
      version += 1;
      googleWrites += 1;
      return json(route, { totalUpdatedCells: 2600 });
    }
    return json(route, {
      sheets: [
        {
          properties: {
            sheetId: 0,
            title: "Sheet1",
            gridProperties: { rowCount: 1000, columnCount: 26 },
          },
        },
      ],
    });
  },
);

try {
  await page.goto(base);
  await page
    .getByRole("heading", { name: "Welcome back, Browser", exact: true })
    .waitFor();
  await page
    .getByRole("heading", { name: "Security & setup", exact: true })
    .waitFor();
  assert.equal(
    workspaceReads,
    0,
    "Locked Home must not fetch workbook metadata",
  );
  await page.screenshot({
    path: join(artifacts, "home-locked-light.png"),
    fullPage: true,
  });
  await page
    .getByRole("navigation", { name: "Workspace destinations" })
    .getByRole("link", { name: /^Workbooks/u })
    .click();
  await page
    .getByRole("heading", { name: "Recovery & Access", exact: true })
    .waitFor();
  await page
    .getByRole("alert")
    .filter({ hasText: "could not check" })
    .waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Create new key", exact: true })
      .count(),
    0,
  );
  assert.equal(
    await page
      .getByRole("button", { name: "New workbook", exact: true })
      .count(),
    0,
  );
  failIdentityLookup = false;
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await page
    .getByRole("button", { name: "Create new key", exact: true })
    .waitFor();
  await page.screenshot({
    path: join(artifacts, "recovery-create-light.png"),
    fullPage: true,
  });
  await page
    .getByRole("tab", { name: "Recover existing key", exact: true })
    .click();
  await page.getByText(/No ZeroSheet key backup was found/u).waitFor();
  await page.getByRole("tab", { name: "Create new key", exact: true }).click();
  await page
    .getByRole("button", { name: "Create new key", exact: true })
    .click();
  const warning = page.getByRole("dialog");
  assert.equal(
    await warning
      .getByRole("button", { name: "Create encryption key", exact: true })
      .isEnabled(),
    false,
  );
  await warning.getByRole("checkbox").nth(0).check();
  await warning.getByRole("checkbox").nth(1).check();
  await warning
    .getByRole("button", { name: "Create encryption key", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Save your recovery phrase", exact: true })
    .waitFor();
  const phrase = (await page.locator("ol li").allTextContents())
    .map((value) => value.replace(/^\d+\.\s*/u, ""))
    .join(" ");
  assert.equal(phrase.split(" ").length, 12);
  assert.equal(
    identityWrites,
    0,
    "Generation alone must not persist a new key",
  );
  assert.equal(
    await page
      .getByRole("button", { name: "Continue to workbooks", exact: true })
      .isEnabled(),
    false,
  );
  await page.screenshot({
    path: join(artifacts, "recovery-phrase-light.png"),
    fullPage: true,
    mask: [page.locator("ol")],
  });
  await page.getByRole("checkbox").check();
  await page
    .getByRole("button", { name: "Continue to workbooks", exact: true })
    .click();
  // Simulate a committed registration whose response was lost. The same words
  // remain visible, and retry must recover the backup, not generate another key.
  await page.getByRole("alert").waitFor();
  assert.equal(await page.locator("ol li").count(), 12);
  assert.equal(identityWrites, 1);
  await page
    .getByRole("button", { name: "Continue to workbooks", exact: true })
    .click();
  await page.getByText("No workbooks here yet", { exact: true }).waitFor();
  assert.equal(identityWrites, 1);
  await page.getByRole("button", { name: "New workbook", exact: true }).click();
  assert.equal(
    await page
      .getByRole("heading", { name: "Recovery & Access", exact: true })
      .count(),
    0,
  );
  await page.getByLabel("Name", { exact: true }).fill("Budget");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page.waitForURL(`**/workbooks/${workbookId}`);
  await page.locator(".univer-container canvas:visible").first().waitFor();
  assert.equal(
    googleWrites,
    0,
    "Opening must not upload an unprotected demo or blank batch",
  );

  // The values-only UI hides Univer's formatting toolbar/name box. A1 is the
  // first cell after its 46px row header and 21px column header; interact with
  // the actual canvas/keyboard, not an internal editor or crypto test hook.
  const grid = page.locator(".univer-container");
  await grid.click({ position: { x: 85, y: 32 } });
  await page.keyboard.type("private-value");
  await page.keyboard.press("Enter");
  await grid.click({ position: { x: 85, y: 32 } });
  await page
    .getByRole("button", { name: "Protect selection", exact: true })
    .click();
  // Leaving with unsaved edits is cancelled by the browser's dismissed dialog.
  await page.getByRole("button", { name: "Workbooks", exact: true }).click();
  assert.ok(page.url().endsWith(`/workbooks/${workbookId}`));
  workbook.canEdit = false;
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page
    .getByRole("alert")
    .filter({ hasText: "no longer have access" })
    .waitFor();
  assert.equal(
    googleWrites,
    0,
    "Revoked edit permission must prevent a Google write",
  );
  workbook.canEdit = true;
  failNextWrite = true;
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page
    .getByRole("alert")
    .filter({ hasText: "Your changes remain" })
    .waitFor();
  assert.equal(googleWrites, 0, "A failed save must not be marked successful");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByText("Saved to Google Drive", { exact: true }).waitFor();
  assert.ok(
    values[0][0].startsWith("zs1:"),
    "Protected value must be ciphertext on the Google wire",
  );
  assert.ok(!JSON.stringify(values).includes("private-value"));
  await page.screenshot({
    path: join(artifacts, "editor-light.png"),
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Switch to dark theme", exact: true })
    .click();
  await page.screenshot({
    path: join(artifacts, "editor-dark.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Workbooks", exact: true }).click();
  await page.getByRole("link", { name: /Budget/u }).waitFor();
  await page.getByRole("button", { name: "Grid view", exact: true }).click();
  await page.screenshot({
    path: join(artifacts, "workbooks-dark.png"),
    fullPage: true,
  });
  // Exercise the folder/file UI against the same metadata operations as the
  // real API: create, move, nested breadcrumb, table/grid, and editor return.
  await page.getByRole("button", { name: "New folder", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("Projects");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page.getByRole("link", { name: "Projects", exact: true }).waitFor();
  await page.getByRole("button", { name: "Move Budget", exact: true }).click();
  await page
    .getByLabel("Destination folder", { exact: true })
    .selectOption(folders[0].id);
  await page.getByRole("button", { name: "Move", exact: true }).click();
  await page.getByRole("link", { name: "Projects", exact: true }).click();
  await page.waitForURL(`**/workbooks/folders/${folders[0].id}`);
  await page.getByRole("link", { name: /Budget/u }).waitFor();
  await page.getByRole("button", { name: "New folder", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("Quarterly");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page.getByRole("link", { name: "Quarterly", exact: true }).click();
  await page.waitForURL(`**/workbooks/folders/${folders[1].id}`);
  assert.equal(folders[1].parentId, folders[0].id);
  await page
    .getByRole("navigation", { name: "Folder breadcrumb" })
    .getByRole("button", { name: "Projects", exact: true })
    .click();
  await page.getByRole("button", { name: "List view", exact: true }).click();
  await page.getByRole("table", { name: "Workbooks and folders" }).waitFor();
  await page.screenshot({
    path: join(artifacts, "folders-list-dark.png"),
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Switch to light theme", exact: true })
    .click();
  await page.screenshot({
    path: join(artifacts, "folders-list-light.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Grid view", exact: true }).click();
  await page.screenshot({
    path: join(artifacts, "folders-grid-light.png"),
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Sort workbooks", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Name Z–A", exact: true }).click();
  await page.getByRole("textbox", { name: "Search workbooks" }).fill("Bud");
  await page.getByRole("link", { name: /Budget/u }).waitFor();
  assert.equal(
    await page.getByRole("link", { name: "Quarterly", exact: true }).count(),
    0,
  );
  await page.getByRole("textbox", { name: "Search workbooks" }).fill("");
  await page.getByRole("link", { name: /Budget/u }).click();
  await page.locator(".univer-container canvas:visible").first().waitFor();
  await page.getByText("1 protected cells", { exact: true }).waitFor();
  // Exercise the actual alert UI, not just its message helper. Authentication
  // gets a sign-in action; outages/malformed reads get retry without a login
  // loop. Retrying these reads must never write or replace saved ciphertext.
  for (const [failure, message, needsSignIn] of [
    ["malformed", "could not safely understand", false],
    ["unavailable", "temporarily unavailable", false],
    ["expired", "authorization is missing or expired", true],
  ]) {
    await page.getByRole("button", { name: "Workbooks", exact: true }).click();
    assert.ok(
      page.url().endsWith(`/workbooks/folders/${folders[0].id}`),
      "Editor return must retain its folder",
    );
    readFailure = failure;
    await page.getByRole("link", { name: /Budget/u }).click();
    await page.getByRole("alert").filter({ hasText: message }).waitFor();
    assert.equal(
      await page
        .getByRole("link", { name: "Sign in again", exact: true })
        .count(),
      needsSignIn ? 1 : 0,
    );
    readFailure = null;
    await page
      .getByRole("button", { name: "Retry loading", exact: true })
      .click();
    await page.locator(".univer-container canvas:visible").first().waitFor();
    await page.getByText("1 protected cells", { exact: true }).waitFor();
    assert.equal(googleWrites, 1, "Load retries must not overwrite saved data");
  }
  await page.getByRole("button", { name: "Home", exact: true }).click();
  await page
    .getByRole("heading", { name: "Recent workbooks", exact: true })
    .waitFor();
  await page.getByRole("link", { name: /Budget/u }).waitFor();
  assert.equal(
    await page
      .getByRole("link", { name: "Set up access", exact: true })
      .count(),
    0,
  );
  await page.screenshot({
    path: join(artifacts, "home-unlocked-light.png"),
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Switch to dark theme", exact: true })
    .click();
  await page.screenshot({
    path: join(artifacts, "home-unlocked-dark.png"),
    fullPage: true,
    animations: "disabled",
  });
  await page
    .getByRole("navigation", { name: "Workspace destinations" })
    .getByRole("link", { name: /^Shared with me/u })
    .click();
  await page.getByText("No shared workbooks yet", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Home", exact: true }).click();
  await page
    .getByRole("navigation", { name: "Workspace destinations" })
    .getByRole("link", { name: /^Recovery & Access/u })
    .click();
  await page
    .getByRole("heading", { name: "This browser tab is unlocked", exact: true })
    .waitFor();
  assert.equal(
    await page.getByLabel("Recovery phrase", { exact: true }).count(),
    0,
    "Reviewing unlocked recovery access must not expose the phrase",
  );
  await page.getByRole("button", { name: "Home", exact: true }).click();
  await page
    .getByRole("navigation", { name: "Workspace destinations" })
    .getByRole("link", { name: /^New workbook/u })
    .click();
  await page.getByRole("dialog").waitFor();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.waitForURL("**/workbooks");
  await page.getByRole("button", { name: "Home", exact: true }).click();
  await page.getByRole("link", { name: /Budget/u }).click();
  await page.locator(".univer-container canvas:visible").first().waitFor();
  // A hard reload locks the memory-only recovery session, then the same saved
  // encrypted backup and envelope must open the Google ciphertext again.
  await page.reload();
  await page
    .getByRole("heading", { name: "Recovery & Access", exact: true })
    .waitFor();
  await page.getByRole("tab", { name: "Create new key", exact: true }).click();
  await page.getByText(/This account already has an encryption key/u).waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Create new key", exact: true })
      .count(),
    0,
  );
  await page
    .getByRole("tab", { name: "Recover existing key", exact: true })
    .click();
  await page.screenshot({
    path: join(artifacts, "recovery-existing-dark.png"),
    fullPage: true,
  });
  await page
    .getByLabel("Recovery phrase", { exact: true })
    .fill(
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    );
  await page
    .getByRole("button", { name: "Recover and continue", exact: true })
    .click();
  await page
    .getByRole("alert")
    .filter({ hasText: "cannot open the encrypted private key" })
    .waitFor();
  assert.equal(
    googleWrites,
    1,
    "A wrong phrase must not write or replace keys",
  );
  await page.getByLabel("Recovery phrase", { exact: true }).fill(phrase);
  await page
    .getByRole("button", { name: "Recover and continue", exact: true })
    .click();
  assert.ok(
    page.url().endsWith(`/workbooks/${workbookId}`),
    "Recovery must retain a bookmarked editor route",
  );
  await page.locator(".univer-container canvas:visible").first().waitFor();
  await page.getByText("1 protected cells", { exact: true }).waitFor();
  assert.equal(googleWrites, 1, "Reopening must not write anything");
  // The grid scrolls inside its own canvas; controls and the file browser must
  // still fit a narrow phone viewport without making the whole page overflow.
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(
      () =>
        globalThis.document.documentElement.scrollWidth <=
        globalThis.innerWidth,
    ),
    true,
    "The editor shell must fit a mobile viewport",
  );
  await page.screenshot({
    path: join(artifacts, "editor-mobile.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Workbooks", exact: true }).click();
  await page.getByRole("link", { name: "Projects", exact: true }).waitFor();
  assert.equal(
    await page.evaluate(
      () =>
        globalThis.document.documentElement.scrollWidth <=
        globalThis.innerWidth,
    ),
    true,
    "The workbook browser must fit a mobile viewport",
  );
  await page.screenshot({
    path: join(artifacts, "workbooks-mobile.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Home", exact: true }).click();
  await page.getByRole("link", { name: /Budget/u }).waitFor();
  assert.equal(
    await page.evaluate(
      () =>
        globalThis.document.documentElement.scrollWidth <=
        globalThis.innerWidth,
    ),
    true,
    "Home must fit a narrow viewport",
  );
  await page.screenshot({
    path: join(artifacts, "home-mobile.png"),
    fullPage: true,
  });
  await page
    .getByRole("navigation", { name: "Workspace destinations" })
    .getByRole("link", { name: /^Workbooks/u })
    .click();
  await page
    .getByRole("button", { name: "Lock recovery access", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Recovery & Access", exact: true })
    .waitFor();
  await page.getByLabel("Recovery phrase", { exact: true }).waitFor();
  await page.screenshot({
    path: join(artifacts, "recovery-existing-mobile.png"),
    fullPage: true,
  });
  assert.equal(
    await page.evaluate(
      () =>
        globalThis.document.documentElement.scrollWidth <=
        globalThis.innerWidth,
    ),
    true,
  );
  assert.equal(
    identityWrites,
    1,
    "Recovery/locking must never replace the key",
  );
  assert.deepEqual(failures, []);
  console.log(
    `PASS: Home hub, folder creation/move/breadcrumbs, grid/table/search/sort, retained editor return, shared inbox, create shortcut, encryption/save/reopen, failed loads/saves, recovery, and desktop/mobile themes. Screenshots: ${artifacts}`,
  );
} catch (error) {
  await page.screenshot({
    path: join(artifacts, "failure.png"),
    fullPage: true,
    mask: [page.locator("ol"), page.locator("textarea")],
  });
  console.error("Browser page errors:", failures);
  console.error("Failure screenshot:", join(artifacts, "failure.png"));
  throw error;
} finally {
  await browser.close();
}
