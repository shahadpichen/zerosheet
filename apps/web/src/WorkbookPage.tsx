import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import type { WorkspaceWorkbook } from "@zerosheet/contracts";
import { ArrowLeft, LoaderCircle, Share2 } from "lucide-react";
import { WorkbookSharingDialog } from "./components/workbook-sharing-dialog.js";
import { Button } from "./components/ui/button.js";
import type { RecoverySession } from "./WorkbookHome.js";
import {
  loadWorkbook,
  workspaceError,
  workspaceNeedsSignIn,
} from "./workspace-client.js";
import {
  initializeEncryptedWorkbook,
  recoverEncryptionIdentity,
  SecureWorkbookClientError,
} from "./secure-workbook.js";
import {
  openSavedWorkbook,
  type LoadedWorkbook,
} from "./workbook-editor-session.js";

const Editor = lazy(async () => ({
  default: (await import("./EncryptedSheetEditor.js")).EncryptedSheetEditor,
}));

/** A bookmarkable editor route, mounted only after the shared recovery page
 * unlocks access. Opening still verifies the stored key envelope and policy. */
export function WorkbookPage({
  id,
  recovery,
  navigate,
  onDirtyChange,
  backPath = "/workbooks",
}: {
  id: string;
  recovery: RecoverySession;
  navigate: (path: string) => void;
  onDirtyChange: (dirty: boolean) => void;
  backPath?: string;
}) {
  const [file, setFile] = useState<WorkspaceWorkbook | null>(null);
  const [loaded, setLoaded] = useState<LoadedWorkbook | null>(null);
  // Keep the local typed failure so recovery actions match its category. Do
  // not serialize it or render its raw message; workspaceError supplies copy.
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  const [sharing, setSharing] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [sharingBusy, setSharingBusy] = useState(false);
  const [sharingChanged, setSharingChanged] = useState(false);
  const editorDirty = useCallback((value: boolean) => setDirty(value), []);
  useEffect(() => {
    onDirtyChange(dirty || sharingBusy);
    return () => onDirtyChange(false);
  }, [dirty, sharingBusy, onDirtyChange]);
  useEffect(() => {
    let active = true;
    setFile(null);
    setLoaded(null);
    setError(null);
    setBusy(true);
    void (async () => {
      const metadata = await loadWorkbook(id);
      if (!active) return;
      setFile(metadata);
      if (recovery.unlocked && metadata.ready) {
        const opened = await recovery.use((phrase) =>
          openSavedWorkbook(id, phrase),
        );
        if (active) setLoaded(opened);
      }
    })()
      .catch((cause: unknown) => {
        if (active) setError(cause);
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [id, recovery, retry]);
  async function finishSetup() {
    if (!file || busy) return;
    setBusy(true);
    setError(null);
    try {
      await recovery.use(async (phrase) => {
        // Recheck readiness: a lost response may hide a successful prior commit.
        const current = await loadWorkbook(id);
        if (!current.ready) {
          const identity = await recoverEncryptionIdentity(phrase);
          await initializeEncryptedWorkbook({
            workbookId: id,
            title: current.name,
            creatorPublicKey: identity.publicKey,
          });
        }
      });
      setRetry((value) => value + 1);
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="mx-auto max-w-[1480px] px-4 py-7 sm:px-6 lg:px-8">
      <Button
        variant="ghost"
        size="sm"
        className="mb-5"
        onClick={() => navigate(backPath)}
      >
        <ArrowLeft />
        Workbooks
      </Button>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="truncate text-2xl tracking-tight">
          {file?.name ?? "Workbook"}
        </h1>
        {file?.ready && file.canShare && (
          <div className="flex items-center gap-3">
            {dirty && (
              <span className="text-xs text-muted-foreground">
                Save changes before sharing
              </span>
            )}
            <Button
              disabled={busy || dirty || saving}
              onClick={() => setSharing(true)}
            >
              <Share2 /> Share
            </Button>
          </div>
        )}
      </div>
      {sharing && file && (
        <WorkbookSharingDialog
          workbookId={id}
          name={file.name}
          recovery={recovery}
          onBusyChange={setSharingBusy}
          onChanged={() => setSharingChanged(true)}
          onClose={() => {
            setSharing(false);
            // Permissions themselves advance Google file versions. Reopen the
            // saved sheet after any mutation rather than keep a stale sync base.
            if (sharingChanged) {
              setLoaded(null);
              setRetry((value) => value + 1);
              setSharingChanged(false);
            }
          }}
        />
      )}
      {error !== null && (
        <div
          role="alert"
          className="my-6 space-y-3 border border-destructive p-4 text-sm"
        >
          <p>
            {error instanceof SecureWorkbookClientError
              ? error.message
              : workspaceError(error)}
          </p>
          <Button variant="outline" onClick={() => setRetry(retry + 1)}>
            Retry loading
          </Button>
          {workspaceNeedsSignIn(error) && (
            <a className="ml-4 underline" href="/api/auth/login/google">
              Sign in again
            </a>
          )}
        </div>
      )}
      {busy && (
        <p
          role="status"
          className="flex items-center gap-2 py-8 text-sm text-muted-foreground"
        >
          <LoaderCircle className="h-4 w-4 animate-spin" />
          Opening workbook…
        </p>
      )}
      {file && recovery.unlocked && !file.ready && !busy && (
        <section className="my-8 max-w-xl border p-6">
          <h2 className="text-lg">Finish workbook setup</h2>
          <p className="my-4 text-sm leading-6 text-muted-foreground">
            The workbook exists, but its Google file and encrypted key have not
            finished linking. No cell data has been saved. Retrying may leave an
            empty Google file from an earlier attempt; it will not replace saved
            encrypted data.
          </p>
          {file.canShare ? (
            <Button onClick={() => void finishSetup()}>Finish setup</Button>
          ) : (
            <p className="text-sm">Ask the owner to finish setup.</p>
          )}
        </section>
      )}
      {loaded && (
        <Suspense
          fallback={<p className="py-8 text-sm">Loading spreadsheet editor…</p>}
        >
          <Editor
            workbook={loaded}
            onDirtyChange={editorDirty}
            onBusyChange={setSaving}
            interactionBlocked={sharing}
          />
        </Suspense>
      )}
    </main>
  );
}
