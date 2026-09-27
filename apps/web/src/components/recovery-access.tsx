import { useEffect, useRef, useState } from "react";
import {
  generateRecoveryPhrase,
  normalizeAndValidateRecoveryPhrase,
} from "@zerosheet/crypto";
import {
  AlertCircle,
  AlertTriangle,
  Check,
  Clipboard,
  Download,
  FileKey,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  MonitorSmartphone,
  ShieldCheck,
} from "lucide-react";
import { recoverEncryptionIdentity } from "../secure-workbook.js";
import { hasEncryptionIdentity, workspaceError } from "../workspace-client.js";
import { saveRecoverySetup } from "../recovery-setup.js";
import { Button } from "./ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog.js";

type IdentityState = "loading" | "missing" | "existing" | "error";
type Mode = "recover" | "generate";

/** The first authenticated page follows ZeroDrive's Recovery & Access layout.
 * It gates the workspace, not just a create-file modal. Only presentation is
 * shared: ZeroSheet keeps HPKE, the encrypted backup, and memory-only access. */
export function RecoveryAccess({
  onUnlocked,
  continueLabel = "Continue to workbooks",
}: {
  onUnlocked: (phrase: string) => void;
  continueLabel?: string;
}) {
  const [identity, setIdentity] = useState<IdentityState>("loading");
  const [mode, setMode] = useState<Mode>("recover");
  const [inputPhrase, setInputPhrase] = useState("");
  const [generatedPhrase, setGeneratedPhrase] = useState("");
  const [saved, setSaved] = useState(false);
  const [warning, setWarning] = useState(false);
  const [understandLoss, setUnderstandLoss] = useState(false);
  const [readyToSave, setReadyToSave] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [retry, setRetry] = useState(0);
  const running = useRef(false);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    let active = true;
    setIdentity("loading");
    setError("");
    void hasEncryptionIdentity()
      .then((exists) => {
        if (!active) return;
        setIdentity(exists ? "existing" : "missing");
        setMode(exists ? "recover" : "generate");
      })
      .catch(() => {
        if (!active) return;
        // A failed check is never evidence that an account needs a new key.
        setIdentity("error");
        setError(
          "We could not check your encryption setup. Retry before creating or recovering a key.",
        );
      });
    return () => {
      active = false;
    };
  }, [retry]);

  useEffect(() => {
    if (!generatedPhrase) return;
    // Keep the phrase visible after failed/ambiguous registration and warn on
    // reload or sign-out. A newly generated replacement cannot recover it.
    const leaving = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", leaving);
    return () => window.removeEventListener("beforeunload", leaving);
  }, [generatedPhrase]);

  function switchMode(next: Mode) {
    if (busy || generatedPhrase) return;
    setMode(next);
    setError("");
    setNotice("");
    setInputPhrase("");
  }

  async function generate() {
    if (
      running.current ||
      identity !== "missing" ||
      !understandLoss ||
      !readyToSave
    )
      return;
    running.current = true;
    setBusy(true);
    setError("");
    try {
      if (await hasEncryptionIdentity()) {
        setIdentity("existing");
        setMode("recover");
        setWarning(false);
        return;
      }
      if (!mounted.current) return;
      // No server write yet. The user must back up these words before the HPKE
      // private-key backup is created and registered by saveRecoverySetup.
      setGeneratedPhrase(generateRecoveryPhrase());
      setSaved(false);
      setWarning(false);
    } catch {
      if (mounted.current) {
        setWarning(false);
        setError(
          "We could not confirm that this account needs a new key. Nothing was created. Please retry.",
        );
      }
    } finally {
      running.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  async function continueWithKey() {
    if (running.current || (generatedPhrase ? !saved : identity !== "existing"))
      return;
    running.current = true;
    setBusy(true);
    setError("");
    try {
      const phrase = generatedPhrase
        ? await saveRecoverySetup(generatedPhrase)
        : normalizeAndValidateRecoveryPhrase(inputPhrase);
      if (!generatedPhrase) await recoverEncryptionIdentity(phrase);
      if (!mounted.current) return;
      onUnlocked(phrase);
      setInputPhrase("");
      setGeneratedPhrase("");
    } catch (cause) {
      if (mounted.current) setError(workspaceError(cause));
    } finally {
      running.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  async function copyPhrase() {
    try {
      await navigator.clipboard.writeText(generatedPhrase);
      setNotice(
        "Phrase copied. Clipboard history or sync may retain it; keep your backup somewhere private.",
      );
    } catch {
      setNotice(
        "Copy was unavailable. Write down the words or download a private backup.",
      );
    }
  }

  function downloadPhrase() {
    // Export is explicit and local, not an upload. Warn that this deliberately
    // creates an unencrypted secret file which the user must keep private.
    const url = URL.createObjectURL(
      new Blob([generatedPhrase], { type: "text/plain" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "zerosheet-recovery-phrase.txt";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setNotice(
      "Phrase downloaded as an unencrypted text file. Store it privately; do not share it.",
    );
  }

  const errorPanel = error && (
    <div
      role="alert"
      className="flex items-start gap-2 border border-destructive/50 bg-destructive/5 px-4 py-3 text-sm"
    >
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
      <span>{error}</span>
    </div>
  );
  return (
    <main className="mx-auto max-w-6xl space-y-6 px-6 pb-20 pt-6">
      <div>
        <h1 className="text-2xl tracking-tight">Recovery &amp; Access</h1>
        <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted-foreground">
          Set up or recover the key that protects your encrypted workbooks.
          Recovery happens locally; your recovery phrase is never sent to the
          ZeroSheet server.
        </p>
      </div>

      {identity === "loading" || identity === "error" ? (
        <section className="max-w-2xl space-y-4 border p-5 sm:p-6">
          {identity === "loading" ? (
            <p
              role="status"
              className="flex items-center gap-2 text-sm text-muted-foreground"
            >
              <LoaderCircle className="h-4 w-4 animate-spin" /> Checking
              encryption setup…
            </p>
          ) : (
            <>
              {errorPanel}
              <Button onClick={() => setRetry((value) => value + 1)}>
                Retry
              </Button>
              <a
                href="/api/auth/login/google"
                className="ml-4 text-sm underline"
              >
                Sign in again
              </a>
            </>
          )}
        </section>
      ) : (
        <>
          {!generatedPhrase && (
            <div
              className="grid grid-cols-2 border"
              role="tablist"
              aria-label="Key management mode"
            >
              {(["recover", "generate"] as const).map((item) => (
                <button
                  key={item}
                  type="button"
                  role="tab"
                  id={"recovery-tab-" + item}
                  aria-controls="recovery-panel"
                  aria-selected={mode === item}
                  tabIndex={mode === item ? 0 : -1}
                  disabled={busy}
                  onClick={() => switchMode(item)}
                  onKeyDown={(event) => {
                    if (
                      ["ArrowLeft", "ArrowRight", "Home", "End"].includes(
                        event.key,
                      )
                    ) {
                      event.preventDefault();
                      const next =
                        event.key === "Home"
                          ? "recover"
                          : event.key === "End"
                            ? "generate"
                            : mode === "recover"
                              ? "generate"
                              : "recover";
                      switchMode(next);
                      document.getElementById("recovery-tab-" + next)?.focus();
                    }
                  }}
                  className={
                    "flex items-center justify-center gap-2 px-3 py-3 text-sm font-medium first:border-r " +
                    (mode === item ? "bg-muted/60" : "hover:bg-muted/30")
                  }
                >
                  {item === "recover" ? (
                    <KeyRound className="h-4 w-4 shrink-0" />
                  ) : (
                    <FileKey className="h-4 w-4 shrink-0" />
                  )}
                  {item === "recover"
                    ? "Recover existing key"
                    : "Create new key"}
                </button>
              ))}
            </div>
          )}

          <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1.5fr)_minmax(280px,0.75fr)]">
            <section
              className="border"
              id="recovery-panel"
              role={generatedPhrase ? undefined : "tabpanel"}
              aria-labelledby={
                generatedPhrase ? "generated-title" : "recovery-tab-" + mode
              }
            >
              <div className="border-b p-5 sm:p-6">
                <div
                  className={
                    "flex h-9 w-9 items-center justify-center border " +
                    (generatedPhrase ? "bg-foreground text-background" : "")
                  }
                >
                  {generatedPhrase ? (
                    <Check className="h-4 w-4" />
                  ) : (
                    <KeyRound className="h-4 w-4" />
                  )}
                </div>
                <h2
                  id="generated-title"
                  className="mt-4 text-base font-semibold"
                >
                  {generatedPhrase
                    ? "Save your recovery phrase"
                    : mode === "recover"
                      ? "Recover your key"
                      : "Create a new encryption key"}
                </h2>
                <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                  {generatedPhrase
                    ? "Keep all 12 words in this exact order. Once you have saved them, continue to your workbooks."
                    : mode === "recover"
                      ? "Enter the ZeroSheet recovery phrase you saved when you created your encryption key."
                      : "Use this for a new ZeroSheet account. A new key cannot open workbooks protected by an older one."}
                </p>
              </div>
              <div className="space-y-5 p-5 sm:p-6">
                {generatedPhrase ? (
                  <>
                    <ol
                      className="grid grid-cols-2 border sm:grid-cols-3"
                      aria-label="Your recovery phrase"
                    >
                      {generatedPhrase.split(" ").map((word, index) => (
                        <li
                          key={index}
                          className="flex items-center gap-2 border-b border-r px-3 py-3 text-sm"
                        >
                          <span className="w-5 text-[10px] text-muted-foreground">
                            {index + 1}.
                          </span>
                          <span className="font-medium">{word}</span>
                        </li>
                      ))}
                    </ol>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void copyPhrase()}
                      >
                        <Clipboard /> Copy phrase
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={downloadPhrase}
                      >
                        <Download /> Download phrase
                      </Button>
                    </div>
                    {notice && (
                      <p
                        role="status"
                        className="text-xs leading-relaxed text-muted-foreground"
                      >
                        {notice}
                      </p>
                    )}
                    <div className="flex items-start gap-2 border border-destructive/40 bg-destructive/5 px-4 py-3 text-xs leading-relaxed">
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                      <span>
                        Keep this phrase secret. Anyone with it and your
                        encrypted key backup can unlock protected cells.
                        ZeroSheet cannot recover it if you lose it.
                      </span>
                    </div>
                    <label className="flex items-start gap-2 text-sm">
                      <input
                        type="checkbox"
                        className="mt-1 accent-foreground"
                        checked={saved}
                        disabled={busy}
                        onChange={(event) => setSaved(event.target.checked)}
                      />
                      I saved all 12 words somewhere safe.
                    </label>
                    {errorPanel}
                    <Button
                      className="w-full sm:w-auto"
                      disabled={!saved || busy}
                      onClick={() => void continueWithKey()}
                    >
                      {busy ? (
                        <>
                          <LoaderCircle className="animate-spin" /> Saving and
                          verifying key…
                        </>
                      ) : (
                        continueLabel
                      )}
                    </Button>
                  </>
                ) : mode === "recover" ? (
                  identity === "existing" ? (
                    <form
                      className="space-y-5"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void continueWithKey();
                      }}
                    >
                      <div className="space-y-2">
                        <label
                          htmlFor="recovery-phrase"
                          className="text-sm font-medium"
                        >
                          Recovery phrase
                        </label>
                        <textarea
                          id="recovery-phrase"
                          className="min-h-28 w-full border bg-background p-3 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                          value={inputPhrase}
                          onChange={(event) => {
                            setInputPhrase(event.target.value);
                            setError("");
                          }}
                          onKeyDown={(event) => {
                            if (
                              (event.metaKey || event.ctrlKey) &&
                              event.key === "Enter"
                            ) {
                              event.preventDefault();
                              void continueWithKey();
                            }
                          }}
                          placeholder="Enter your 12-word recovery phrase"
                          rows={4}
                          autoComplete="off"
                          autoCorrect="off"
                          spellCheck={false}
                          disabled={busy}
                          required
                        />
                        <p className="flex items-start gap-2 text-xs text-muted-foreground">
                          <ShieldCheck className="h-3.5 w-3.5 shrink-0" />{" "}
                          Processed only in this browser tab and never sent to
                          the server.
                        </p>
                      </div>
                      {errorPanel}
                      <Button
                        type="submit"
                        disabled={!inputPhrase.trim() || busy}
                        className="w-full sm:w-auto"
                      >
                        {busy ? (
                          <LoaderCircle className="animate-spin" />
                        ) : (
                          <KeyRound />
                        )}
                        {busy ? "Recovering key…" : "Recover and continue"}
                      </Button>
                    </form>
                  ) : (
                    <>
                      <p className="text-sm leading-relaxed text-muted-foreground">
                        No ZeroSheet key backup was found for this signed-in
                        account. If you used another account before, sign in
                        with that account. A ZeroDrive phrase alone cannot
                        restore a ZeroSheet key.
                      </p>
                      <Button onClick={() => switchMode("generate")}>
                        Set up a new key
                      </Button>
                    </>
                  )
                ) : identity === "existing" ? (
                  <>
                    <p className="text-sm leading-relaxed text-muted-foreground">
                      This account already has an encryption key. Recover it
                      with your existing phrase; creating another key would not
                      restore access to your workbooks.
                    </p>
                    <Button onClick={() => switchMode("recover")}>
                      <KeyRound /> Recover existing key
                    </Button>
                  </>
                ) : (
                  <>
                    <div className="grid gap-3 text-sm sm:grid-cols-3">
                      {[
                        "Generated locally",
                        "12-word recovery",
                        "No server copy of phrase",
                      ].map((text) => (
                        <div key={text} className="flex items-start gap-2">
                          <Check className="mt-0.5 h-4 w-4 shrink-0 text-green-600 dark:text-green-400" />
                          <span>{text}</span>
                        </div>
                      ))}
                    </div>
                    {errorPanel}
                    <Button
                      disabled={busy}
                      onClick={() => {
                        setUnderstandLoss(false);
                        setReadyToSave(false);
                        setWarning(true);
                      }}
                    >
                      <KeyRound /> Create new key
                    </Button>
                  </>
                )}
              </div>
            </section>
            <aside className="border">
              <div className="border-b p-5">
                <h2 className="flex items-center gap-2 text-sm font-semibold">
                  <MonitorSmartphone className="h-4 w-4" /> This browser tab
                </h2>
                <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                  Access stays in this page's memory. Reloading, signing out, or
                  locking access requires your recovery phrase again.
                </p>
              </div>
              <div className="space-y-5 p-5">
                <div className="flex items-start gap-3">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center border">
                    <LockKeyhole className="h-4 w-4" />
                  </span>
                  <div>
                    <p className="text-sm font-medium">
                      {identity === "existing"
                        ? "Recovery access is locked"
                        : "Encryption setup is not complete"}
                    </p>
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                      Your Google sign-in is ready.{" "}
                      {identity === "existing"
                        ? "Recover your key to open your workbooks."
                        : "Save your recovery phrase to finish setup."}
                    </p>
                  </div>
                </div>
                <div className="space-y-3 border-t pt-4 text-xs leading-relaxed">
                  <p className="flex items-start gap-2">
                    <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" /> Your
                    private key is backed up only in encrypted form.
                  </p>
                  <p className="flex items-start gap-2">
                    <KeyRound className="mt-0.5 h-4 w-4 shrink-0" /> Use your
                    ZeroSheet phrase with the same account on another device to
                    recover access.
                  </p>
                </div>
              </div>
            </aside>
          </div>
        </>
      )}

      <Dialog
        open={warning}
        onOpenChange={(open) => {
          if (!busy) setWarning(open);
        }}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-destructive" /> Before you
              create a new key
            </DialogTitle>
            <DialogDescription>
              ZeroSheet cannot reset or retrieve your recovery phrase.
            </DialogDescription>
          </DialogHeader>
          <div className="border border-destructive/40 bg-destructive/5 p-4 text-sm leading-relaxed">
            Without this phrase, you can lose access to the cells protected by
            your encryption keys. Google sign-in alone cannot unlock them.
          </div>
          <div className="space-y-3 border-t pt-4 text-sm">
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                className="mt-1 accent-foreground"
                checked={understandLoss}
                disabled={busy}
                onChange={(event) => setUnderstandLoss(event.target.checked)}
              />{" "}
              I understand that losing this phrase can permanently lock me out
              of my protected cells.
            </label>
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                className="mt-1 accent-foreground"
                checked={readyToSave}
                disabled={busy}
                onChange={(event) => setReadyToSave(event.target.checked)}
              />{" "}
              I am ready to save the recovery phrase now.
            </label>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setWarning(false)}
            >
              Cancel
            </Button>
            <Button
              disabled={!understandLoss || !readyToSave || busy}
              onClick={() => void generate()}
            >
              {busy ? (
                <>
                  <LoaderCircle className="animate-spin" /> Checking setup…
                </>
              ) : (
                "Create encryption key"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  );
}
