import { useCallback, useEffect, useRef, useState } from "react";
import type {
  RecipientEncryptionKeyResponse,
  WorkbookSharingDetails,
} from "@zerosheet/contracts";
import {
  Copy,
  LoaderCircle,
  LockKeyhole,
  RefreshCw,
  UserPlus,
} from "lucide-react";
import type { RecoverySession } from "../WorkbookHome.js";
import {
  loadWorkbookSharing,
  lookupWorkbookRecipient,
  removeWorkbookAccess,
} from "../sharing-client.js";
import {
  auditWorkbookGooglePermissions,
  shareEncryptedWorkbookWithUser,
  SecureWorkbookClientError,
} from "../secure-workbook.js";
import { workspaceError, WorkspaceRequestError } from "../workspace-client.js";
import { Button } from "./ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog.js";

/** One reviewed recipient at a time follows ZeroDrive's compose -> review ->
 * share pattern. The recovery phrase is borrowed only inside the operation;
 * React state contains public metadata, never plaintext keys or recovery words.
 * Native Radix focus trapping/Escape behavior is retained except during writes.
 */
export function WorkbookSharingDialog({
  workbookId,
  name,
  recovery,
  onClose,
  onChanged,
  onBusyChange,
}: {
  workbookId: string;
  name: string;
  recovery: RecoverySession;
  onClose: () => void;
  onChanged: () => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const [details, setDetails] = useState<WorkbookSharingDetails | null>(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"viewer" | "editor">("viewer");
  const [recipient, setRecipient] =
    useState<RecipientEncryptionKeyResponse | null>(null);
  const [removing, setRemoving] = useState<{
    userId: string;
    email: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const alive = useRef(true);
  const inFlight = useRef(false);
  const refresh = useCallback(async () => {
    const value = await loadWorkbookSharing(workbookId);
    if (alive.current) setDetails(value);
    return value;
  }, [workbookId]);

  useEffect(() => {
    alive.current = true;
    void refresh()
      .catch((cause) => {
        if (alive.current) setError(sharingError(cause));
      })
      .finally(() => {
        if (alive.current) setLoading(false);
      });
    return () => {
      alive.current = false;
    };
  }, [refresh]);

  // A ref closes the double-click gap before React renders disabled controls.
  // The parent also guards browser navigation while a provider mutation runs.
  async function run(action: () => Promise<void>, mutates = false) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    onBusyChange(true);
    try {
      await action();
    } catch (cause) {
      if (alive.current) setError(sharingError(cause));
      if (mutates) await refresh().catch(() => undefined);
    } finally {
      if (mutates) onChanged(); // Google versions can change even after a failed/compensated operation.
      inFlight.current = false;
      onBusyChange(false);
      if (alive.current) setBusy(false);
    }
  }

  async function review(address = email, requestedRole = role) {
    await run(async () => {
      const value = await lookupWorkbookRecipient(workbookId, address);
      if (value.userId === details?.owner.userId) {
        setError("The owner already has full access.");
        return;
      }
      setRecipient(value);
      setRole(requestedRole);
      setRemoving(null);
    });
  }

  const blocked =
    busy ||
    loading ||
    !details ||
    !!details.rotation ||
    details.shares.some((share) => share.state !== "active");
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !inFlight.current) onClose();
      }}
    >
      <DialogContent
        className="max-h-[85dvh] overflow-y-auto sm:max-w-xl"
        onEscapeKeyDown={(event) => {
          if (busy) event.preventDefault();
        }}
        onPointerDownOutside={(event) => {
          if (busy) event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle className="break-words pr-6">Share {name}</DialogTitle>
          <DialogDescription>
            Give someone access to this same workbook. Their own recovery key
            unlocks protected cells.
          </DialogDescription>
        </DialogHeader>
        {loading && (
          <p role="status" className="text-sm text-muted-foreground">
            Loading access…
          </p>
        )}
        {error && (
          <p role="alert" className="border border-destructive p-3 text-sm">
            {error}
          </p>
        )}
        {message && (
          <p role="status" className="border p-3 text-sm">
            {message}
          </p>
        )}
        {busy && (
          <p role="status" className="flex items-center gap-2 text-sm">
            <LoaderCircle className="size-4 animate-spin" /> Updating access.
            Keep this page open…
          </p>
        )}
        {details?.rotation && (
          <section className="space-y-3 border p-4">
            <h3 className="text-sm font-medium">Finish removing access</h3>
            <p className="text-sm text-muted-foreground">
              A previous removal has not finished. Resume it using the saved
              encrypted key; do not start another share.
            </p>
            <Button
              disabled={busy}
              onClick={() =>
                setRemoving({
                  userId: details.rotation!.revokedUserId,
                  email:
                    details.shares.find(
                      (share) =>
                        share.userId === details.rotation!.revokedUserId,
                    )?.email ?? "the selected recipient",
                })
              }
            >
              Resume removal
            </Button>
          </section>
        )}
        {removing ? (
          <section
            className="space-y-4 border p-4"
            aria-label="Confirm removal"
          >
            <h3 className="text-sm font-medium break-words">
              Remove {removing.email}?
            </h3>
            <p className="text-sm text-muted-foreground">
              This rewrites protected cells with a new workbook key, removes
              their Google permission, and removes their ZeroSheet access. It
              cannot erase copies or keys they already saved.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="destructive"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await recovery.use((phrase) =>
                      removeWorkbookAccess({
                        workbookId,
                        revokedUserId: removing.userId,
                        recoveryPhrase: phrase,
                      }),
                    );
                    const current = await refresh();
                    if (
                      current.shares.some(
                        (share) => share.userId === removing.userId,
                      )
                    )
                      throw new SecureWorkbookClientError(
                        "SHARING_REQUIRES_REVIEW",
                      );
                    setRemoving(null);
                    setMessage(
                      "Access removed. Remaining collaborators can reopen the updated workbook.",
                    );
                  }, true)
                }
              >
                Remove access and rotate key
              </Button>
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => setRemoving(null)}
              >
                Cancel removal
              </Button>
            </div>
          </section>
        ) : recipient ? (
          <section
            className="space-y-4 border p-4"
            aria-label="Review recipient"
          >
            <h3 className="text-sm font-medium">Review before sharing</h3>
            <p className="break-all text-sm">{recipient.email}</p>
            <label className="block space-y-2 text-sm">
              Access
              <select
                aria-label="Recipient access"
                className="h-10 w-full border bg-background px-3"
                disabled={blocked}
                value={role}
                onChange={(event) =>
                  setRole(event.target.value as "viewer" | "editor")
                }
              >
                <option value="viewer">Viewer</option>
                <option value="editor">Editor</option>
              </select>
            </label>
            <p className="text-xs text-muted-foreground">
              {role === "viewer"
                ? "Can read the workbook, including protected cells. Cannot save changes."
                : "Can read protected cells and save changes to this workbook."}
            </p>
            <details className="text-xs text-muted-foreground">
              <summary className="cursor-pointer">
                Public-key fingerprint
              </summary>
              <p className="mt-2 break-all">
                {recipient.publicKey.fingerprint}
              </p>
              <p className="mt-2">
                Compare through another trusted channel if needed. A fingerprint
                identifies a key; it does not independently verify this person.
              </p>
            </details>
            <p className="text-xs text-muted-foreground">
              Confirm this is their Google account. They must already have
              signed in and completed recovery setup. No recovery words or
              private key are shared, and no email notification is sent.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                disabled={blocked}
                onClick={() =>
                  void run(async () => {
                    await recovery.use((phrase) =>
                      shareEncryptedWorkbookWithUser({
                        workbookId,
                        recipientUserId: recipient.userId,
                        role,
                        recoveryPhrase: phrase,
                        reviewedRecipient: {
                          email: recipient.email,
                          fingerprint: recipient.publicKey.fingerprint,
                        },
                      }),
                    );
                    await refresh();
                    setMessage(
                      `Access saved for ${recipient.email}. Send them the workbook link.`,
                    );
                    setRecipient(null);
                    setEmail("");
                  }, true)
                }
              >
                <LockKeyhole /> Confirm access
              </Button>
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => setRecipient(null)}
              >
                Back
              </Button>
            </div>
          </section>
        ) : (
          <form
            className="space-y-3 border-b pb-5"
            onSubmit={(event) => {
              event.preventDefault();
              void review();
            }}
          >
            <label htmlFor="share-recipient-email" className="text-sm">
              Google email address
            </label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                id="share-recipient-email"
                type="email"
                required
                maxLength={254}
                autoComplete="off"
                placeholder="person@example.com"
                className="h-10 min-w-0 flex-1 border bg-background px-3 text-sm"
                disabled={blocked}
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
              <Button type="submit" disabled={blocked || !email.trim()}>
                <UserPlus /> Review access
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Recipients need a ZeroSheet account with recovery setup completed.
              Sharing applies to this workbook, not its folder.
            </p>
          </form>
        )}
        {details && (
          <section className="space-y-3" aria-label="People with access">
            <h3 className="text-sm font-medium">People with access</h3>
            <div className="flex items-center justify-between gap-3 border-b py-2 text-sm">
              <span className="min-w-0 break-all">{details.owner.email}</span>
              <span className="text-muted-foreground">Owner</span>
            </div>
            {details.shares.map((share) => (
              <div
                key={share.userId}
                className="flex flex-wrap items-center justify-between gap-2 border-b py-2 text-sm"
              >
                <div className="min-w-0 flex-1">
                  <p className="break-all">{share.email}</p>
                  <p className="text-xs text-muted-foreground">
                    {share.state === "active" &&
                    share.hasEnvelope &&
                    share.googlePermissionId
                      ? share.role === "editor"
                        ? "Editor"
                        : "Viewer"
                      : "Access synchronization incomplete — refresh to check"}
                  </p>
                </div>
                <div className="flex gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={
                      blocked || !share.hasEnvelope || !share.googlePermissionId
                    }
                    onClick={() => void review(share.email, share.role)}
                  >
                    Change access
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={blocked || !share.googlePermissionId}
                    onClick={() => {
                      setRecipient(null);
                      setRemoving(share);
                    }}
                  >
                    Remove
                  </Button>
                </div>
              </div>
            ))}
            {!details.shares.length && (
              <p className="text-sm text-muted-foreground">
                Only the owner has a direct ZeroSheet share.
              </p>
            )}
          </section>
        )}
        <div className="flex flex-wrap gap-2 border-t pt-4">
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await refresh();
                setLoading(false);
              })
            }
          >
            <RefreshCw /> Refresh access
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || !details}
            onClick={() =>
              void run(async () => {
                await navigator.clipboard.writeText(
                  new URL(`/workbooks/${workbookId}`, window.location.origin)
                    .href,
                );
                setMessage(
                  "Workbook link copied. The link alone does not grant access.",
                );
              })
            }
          >
            <Copy /> Copy link
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy || !details}
            onClick={() =>
              void run(async () => {
                const audit = await auditWorkbookGooglePermissions(workbookId);
                setMessage(
                  `${audit.missingExpectedPermissions.length} missing Google permission(s); ${audit.unmanagedGooglePermissions.length} permission(s) managed outside ZeroSheet. Nothing was changed.`,
                );
              })
            }
          >
            Check Google permissions
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Known error codes have deliberately safe copy. Never show raw Google/SQL
 * response bodies or cryptographic causes inside a sharing dialog. */
export function sharingError(error: unknown): string {
  if (error instanceof SecureWorkbookClientError) return error.message;
  if (error instanceof WorkspaceRequestError && error.status === 404)
    return "No unambiguous, ready account was found. Ask them to sign in and complete recovery setup, then confirm the exact Google address.";
  return workspaceError(error);
}
