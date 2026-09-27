import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AuthenticatedWorkspace } from "./App.js";

// The grid requires a browser canvas. This layout regression only needs its
// boundary, so do not load Univer or make any real Google requests in the test.
vi.mock("./EncryptedSheetEditor.js", () => ({
  EncryptedSheetEditor: () => <div>Spreadsheet editor</div>,
}));
vi.mock("./components/mode-toggle.js", () => ({
  ModeToggle: () => <button>Theme</button>,
}));

describe("authenticated workspace", () => {
  it("opens a Home hub with recovery guidance, not the file browser or a demo", () => {
    const markup = renderToStaticMarkup(
      <AuthenticatedWorkspace
        user={{
          id: "d19b70b8-d531-43ac-a734-12270ca484d3",
          displayName: "ZeroSheet Learner",
          email: "learner@zerosheet.local",
        }}
      />,
    );

    expect(markup).toContain("Welcome back");
    expect(markup).toContain("Recovery &amp; Access");
    expect(markup).toContain("Set up access");
    expect(markup).toContain("Recent workbooks");
    expect(markup).toContain("Security &amp; setup");
    expect(markup).toContain('href="/workbooks"');
    expect(markup).not.toContain("Recovery phrase</label>");
    expect(markup).not.toContain("Grid view");
    expect(markup).not.toContain("Encrypted workbook lab");
    expect(markup).not.toContain("Acme Corp");
    for (const removedControl of [
      "Checking Google Drive",
      "Drive status unavailable",
      "Drive OAuth is not configured",
      "Reconnect Google Drive",
      "Drive connected",
      "Disconnect",
      "/api/google/storage/connect",
    ]) {
      expect(markup).not.toContain(removedControl);
    }
  });
});
