import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AuthenticatedUser } from "@zerosheet/contracts";
import { RecoveryPhraseMemory } from "@zerosheet/crypto";
import { ArrowLeft, Check, LockKeyhole } from "lucide-react";
import { WorkbookHome, type RecoverySession } from "./WorkbookHome.js";
import { WorkbookPage } from "./WorkbookPage.js";
import { Button } from "./components/ui/button.js";
import { RecoveryAccess } from "./components/recovery-access.js";
import { AppHeader } from "./components/app-header.js";
import { ModeToggle } from "./components/mode-toggle.js";
import { HomeDashboard } from "./HomeDashboard.js";
import { workspaceRoute } from "./workspace-routes.js";

/** Home is the signed-in hub; a shared recovery gate protects workbook routes.
 * Links stay bookmarkable;
 * same-tab navigation preserves the memory-only recovery session. Reloading,
 * signing out, or explicitly locking drops access; nothing goes in storage. */
export function WorkspaceApp({ user }: { user: AuthenticatedUser }) {
  const [path, setPath] = useState(() =>
    typeof window === "undefined" ? "/" : window.location.pathname,
  );
  const currentPath = useRef(path);
  const editorBackPath = useRef("/workbooks");
  const memory = useRef(new RecoveryPhraseMemory());
  const dirty = useRef(false);
  const [generation, setGeneration] = useState(0);
  const onDirtyChange = useCallback((value: boolean) => {
    dirty.current = value;
  }, []);
  const mayLeave = useCallback(
    () =>
      !dirty.current ||
      window.confirm(
        "This workbook has unsaved changes. Leave without saving?",
      ),
    [],
  );
  const navigate = useCallback(
    (next: string) => {
      if (!mayLeave()) return;
      if (
        workspaceRoute(next).kind === "editor" &&
        workspaceRoute(currentPath.current).kind === "collection"
      ) {
        editorBackPath.current =
          currentPath.current === "/workbooks/new"
            ? "/workbooks"
            : currentPath.current;
      }
      dirty.current = false;
      currentPath.current = next;
      window.history.pushState(null, "", next);
      setPath(next);
    },
    [mayLeave],
  );
  useEffect(() => {
    const vault = memory.current;
    const back = () => {
      if (!mayLeave()) {
        window.history.pushState(null, "", currentPath.current);
        return;
      }
      dirty.current = false;
      currentPath.current = window.location.pathname;
      setPath(currentPath.current);
    };
    const leaving = (event: BeforeUnloadEvent) => {
      if (dirty.current) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    const lock = () => {
      vault.clear();
    };
    const restored = () => {
      setGeneration((value) => value + 1);
    };
    window.addEventListener("popstate", back);
    window.addEventListener("beforeunload", leaving);
    window.addEventListener("pagehide", lock);
    window.addEventListener("pageshow", restored);
    return () => {
      vault.clear();
      window.removeEventListener("popstate", back);
      window.removeEventListener("beforeunload", leaving);
      window.removeEventListener("pagehide", lock);
      window.removeEventListener("pageshow", restored);
    };
  }, [mayLeave, user.id]);
  const recovery = useMemo<RecoverySession>(
    () => ({
      unlocked: memory.current.isUnlockedFor(user.id),
      unlock: (phrase) => {
        memory.current.unlock(user.id, phrase);
        setGeneration((value) => value + 1);
      },
      use: (operation) => memory.current.use(user.id, operation),
      // Generation changes after unlock/lock; the secret itself never becomes UI state.
    }),
    [user.id, generation],
  );
  const route = workspaceRoute(path);
  function lockRecovery() {
    if (!mayLeave()) return;
    dirty.current = false;
    memory.current.clear();
    setGeneration((value) => value + 1);
  }

  // Home is useful even on a fresh login. Only workbook/recovery destinations
  // mount key setup; their original route survives unlocking, including folders.
  if (route.kind === "home")
    return (
      <>
        <AppHeader user={user} navigate={navigate} />
        <HomeDashboard
          user={user}
          unlocked={recovery.unlocked}
          navigate={navigate}
        />
      </>
    );
  const needsRecovery = !recovery.unlocked && route.kind !== "missing";
  return (
    <>
      {/* Like ZeroDrive's inner pages: a quiet Home link instead of another
          full header. Theme and lock remain reachable on narrow screens. */}
      <div
        className={`mx-auto flex items-center justify-between gap-3 px-6 pt-8 ${route.kind === "editor" && !needsRecovery ? "max-w-[1480px]" : "max-w-6xl"}`}
      >
        <Button variant="ghost" size="sm" onClick={() => navigate("/home")}>
          <ArrowLeft />
          Home
        </Button>
        <div className="flex items-center gap-2">
          {recovery.unlocked && (
            <Button
              variant="ghost"
              size="sm"
              onClick={lockRecovery}
              aria-label="Lock recovery access"
            >
              <LockKeyhole />
              <span className="hidden sm:inline">Lock recovery access</span>
              <span className="sm:hidden">Lock</span>
            </Button>
          )}
          <ModeToggle />
        </div>
      </div>
      {needsRecovery ? (
        <RecoveryAccess
          onUnlocked={(phrase) => {
            recovery.unlock(phrase);
            if (route.kind === "recovery") navigate("/home");
          }}
          continueLabel={
            route.kind === "editor"
              ? "Continue to workbook"
              : route.kind === "recovery"
                ? "Continue to home"
                : "Continue to workbooks"
          }
        />
      ) : route.kind === "collection" ? (
        <WorkbookHome
          key={`${route.shared}-${route.create}`}
          user={user}
          recovery={recovery}
          navigate={navigate}
          folderId={route.folderId}
          shared={route.shared}
          createOnOpen={route.create}
        />
      ) : route.kind === "editor" ? (
        <WorkbookPage
          key={route.id}
          id={route.id}
          backPath={editorBackPath.current}
          recovery={recovery}
          navigate={navigate}
          onDirtyChange={onDirtyChange}
        />
      ) : route.kind === "recovery" ? (
        <main className="mx-auto max-w-6xl space-y-6 px-6 pb-20 pt-6">
          <h1 className="text-2xl tracking-tight">Recovery &amp; Access</h1>
          <section className="max-w-2xl space-y-4 border p-6">
            <Check className="h-5 w-5 text-green-600 dark:text-green-400" />
            <h2 className="text-lg">This browser tab is unlocked</h2>
            <p className="text-sm leading-relaxed text-muted-foreground">
              Your recovery key stays in memory only. Locking or reloading
              requires your saved 12 words again. This page never displays or
              replaces your existing key.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => navigate("/workbooks")}>
                Open workbooks
              </Button>
            </div>
          </section>
        </main>
      ) : (
        <main className="mx-auto max-w-xl space-y-5 px-6 py-16">
          <h1 className="text-2xl">Page not found</h1>
          <Button onClick={() => navigate("/home")}>Back to home</Button>
        </main>
      )}
    </>
  );
}
