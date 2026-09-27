import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { WorkspaceResponse } from "@zerosheet/contracts";
import { HomeContent } from "./HomeDashboard.js";
import {
  WorkbookFolderItem,
  WorkbookItem,
} from "./components/workbook-items.js";

const user = {
  id: "a1000000-0000-4000-8000-000000000001",
  displayName: "Browser Learner",
  email: "learner@example.invalid",
};
const file = {
  id: "a1000000-0000-4000-8000-000000000002",
  organizationId: "a1000000-0000-4000-8000-000000000003",
  name: "Budget",
  createdBy: user.id,
  createdAt: "2026-09-27T00:00:00.000Z",
  folderId: null,
  ready: true,
  canEdit: true,
  canShare: true,
};
const snapshot: WorkspaceResponse = {
  folders: [],
  organizations: [],
  workbooks: [file],
  nextCursor: null,
};
function home(unlocked: boolean, data: WorkspaceResponse | null = null) {
  return renderToStaticMarkup(
    <HomeContent
      user={user}
      unlocked={unlocked}
      data={data}
      error=""
      onRetry={() => {}}
      navigate={() => {}}
    />,
  );
}
describe("ZeroDrive-style home and file presentation", () => {
  it("offers four functional destinations with a key-setup callout when locked", () => {
    const markup = home(false);
    for (const path of [
      "/workbooks",
      "/workbooks/new",
      "/shared-with-me",
      "/recovery-access",
    ])
      expect(markup).toContain(`href="${path}"`);
    expect(markup).toContain("Set up or recover your key");
    expect(markup).not.toContain("0 workbooks");
    expect(markup).not.toContain("Drive connected");
  });
  it("uses real recent items, qualifies partial counts, and never claims whole-sheet encryption", () => {
    const markup = home(true, { ...snapshot, nextCursor: file.id });
    expect(markup).toContain("1+ workbooks");
    expect(markup).toContain("Newest among loaded workbooks");
    expect(markup).toContain(`/workbooks/${file.id}`);
    expect(markup).toContain(
      "Unprotected cells and file names remain visible to Google",
    );
    expect(markup).not.toContain("Set up access");
  });
  it("gives an empty account a working first-workbook shortcut", () => {
    expect(home(true, { ...snapshot, workbooks: [] })).toContain(
      "Create first workbook",
    );
  });
  it("renders real table rows and reuses the reference app icons without fake actions", () => {
    const markup = renderToStaticMarkup(
      <table>
        <tbody>
          <WorkbookFolderItem
            folder={{ id: file.id, name: "Projects", parentId: null }}
            grid={false}
            navigate={() => {}}
          />
          <WorkbookItem
            file={file}
            userId={user.id}
            grid={false}
            onOpen={() => {}}
            onMove={() => {}}
          />
        </tbody>
      </table>,
    );
    expect(markup.match(/<tr /gu)).toHaveLength(2);
    expect(markup).toContain("/folder.png");
    expect(markup).toContain("/workbook.png");
    expect(markup).toContain("Move Budget");
    expect(markup).not.toContain("Delete");
    expect(markup).not.toContain("Rename");
  });
});
