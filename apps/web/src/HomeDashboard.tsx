import { useEffect, useState } from "react";
import type {
  AuthenticatedUser,
  WorkspaceResponse,
} from "@zerosheet/contracts";
import {
  Check,
  ChevronRight,
  HardDrive,
  Inbox,
  KeyRound,
  LoaderCircle,
  Plus,
  ShieldCheck,
} from "lucide-react";
import { loadWorkspace, workspaceError } from "./workspace-client.js";
import { WorkspaceLink } from "./components/workspace-link.js";
import { Button } from "./components/ui/button.js";

/** ZeroDrive's home is a hub, not the storage screen. We reuse that layout but
 * only show ZeroSheet capabilities that exist. No invented quota, sharing
 * wizard, or claim that every cell is encrypted appears in the dashboard. */
export function HomeDashboard({
  user,
  unlocked,
  navigate,
}: {
  user: AuthenticatedUser;
  unlocked: boolean;
  navigate: (path: string) => void;
}) {
  const [data, setData] = useState<WorkspaceResponse | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setData(null);
    setError("");
    // Home remains available while locked, but workbook metadata is not loaded
    // behind the recovery gate. There is no persistent dashboard cache.
    if (unlocked) {
      void loadWorkspace()
        .then((result) => {
          if (active) setData(result);
        })
        .catch((cause: unknown) => {
          if (active) setError(workspaceError(cause));
        });
    }
    return () => {
      active = false;
    };
  }, [unlocked, user.id, retry]);
  return (
    <HomeContent
      user={user}
      unlocked={unlocked}
      data={data}
      error={error}
      onRetry={() => setRetry((value) => value + 1)}
      navigate={navigate}
    />
  );
}

/** Rendering is separate from fetching so counts, locked states, and empty
 * states can be tested with the same markup the signed-in browser receives. */
export function HomeContent({
  user,
  unlocked,
  data,
  error,
  onRetry,
  navigate,
}: {
  user: AuthenticatedUser;
  unlocked: boolean;
  data: WorkspaceResponse | null;
  error: string;
  onRetry: () => void;
  navigate: (path: string) => void;
}) {
  const firstName = user.displayName.trim().split(/\s+/u)[0];
  const recent = [...(data?.workbooks ?? [])]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 5);
  const cards = [
    {
      title: "Workbooks",
      subtitle: data
        ? `${data.workbooks.length}${data.nextCursor ? "+" : ""} workbooks · ${data.folders.length} folders`
        : "Your sheets and folders",
      icon: HardDrive,
      path: "/workbooks",
    },
    {
      title: "New workbook",
      subtitle: "Create a sheet in your Google Drive",
      icon: Plus,
      path: "/workbooks/new",
    },
    {
      title: "Shared with me",
      subtitle: "Workbooks you can access from others",
      icon: Inbox,
      path: "/shared-with-me",
    },
    {
      title: "Recovery & Access",
      subtitle: "Your encryption key and recovery phrase",
      icon: KeyRound,
      path: "/recovery-access",
    },
  ];
  return (
    <main className="mx-auto mt-12 max-w-5xl px-6 pb-20 sm:mt-20 sm:px-8">
      <div className="text-center">
        <h1 className="mx-auto break-words text-xl sm:text-2xl md:w-[70%] md:text-3xl">
          Welcome back{firstName ? `, ${firstName}` : ""}
        </h1>
        <p className="mx-auto mt-4 max-w-2xl font-light leading-relaxed text-muted-foreground">
          Your private spreadsheets, in one place. Create, organize, and open
          your workbooks.
        </p>
      </div>
      {!unlocked && (
        <section
          aria-label="Recovery guidance"
          className="mt-8 flex flex-col gap-5 border px-5 py-5 sm:flex-row sm:items-center sm:justify-between"
        >
          <div>
            <span className="inline-flex border px-2.5 py-1 text-xs font-semibold">
              Recovery access required
            </span>
            <h2 className="mt-4 text-xl tracking-tight">
              Set up or recover your key
            </h2>
            <p className="mt-2 max-w-xl text-sm font-light leading-relaxed text-muted-foreground">
              Create a key for a new account, or enter your saved 12 words. Your
              key stays in this browser tab.
            </p>
          </div>
          <WorkspaceLink
            href="/recovery-access"
            navigate={navigate}
            className="shrink-0 border bg-foreground px-4 py-2 text-center text-sm font-semibold text-background hover:bg-foreground/90"
          >
            Set up access
          </WorkspaceLink>
        </section>
      )}
      <nav
        aria-label="Workspace destinations"
        className="mt-8 grid gap-4 sm:grid-cols-2"
      >
        {cards.map(({ title, subtitle, icon: Icon, path }) => (
          <WorkspaceLink
            key={path}
            href={path}
            navigate={navigate}
            className="flex items-center gap-4 border p-5 text-left transition-colors hover:bg-muted/50"
          >
            <Icon
              className="h-6 w-6 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
            <span className="min-w-0 flex-1">
              <span className="block text-[15px] font-semibold">{title}</span>
              <span className="mt-1 block text-xs font-light leading-5 text-muted-foreground">
                {subtitle}
              </span>
            </span>
            <ChevronRight
              className="h-4 w-4 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
          </WorkspaceLink>
        ))}
      </nav>
      <div className="mt-10 grid items-start gap-4 lg:grid-cols-2">
        <section
          className="min-w-0 border"
          aria-labelledby="recent-workbooks-heading"
        >
          <div className="flex items-center justify-between gap-3 border-b px-5 py-3.5 text-sm font-medium">
            <h2 id="recent-workbooks-heading">Recent workbooks</h2>
            <WorkspaceLink
              href="/workbooks"
              navigate={navigate}
              className="shrink-0 text-xs text-[hsl(var(--link))] hover:underline"
            >
              View all →
            </WorkspaceLink>
          </div>
          {!unlocked ? (
            <p className="px-5 py-8 text-center text-sm text-muted-foreground">
              Unlock recovery access to see your workbooks.
            </p>
          ) : error ? (
            <div role="alert" className="space-y-3 px-5 py-6 text-sm">
              <p>{error}</p>
              <Button size="sm" onClick={onRetry}>
                Retry
              </Button>
            </div>
          ) : !data ? (
            <p
              role="status"
              className="flex items-center justify-center gap-2 px-5 py-8 text-sm text-muted-foreground"
            >
              <LoaderCircle className="h-4 w-4 animate-spin" />
              Loading your workbooks…
            </p>
          ) : recent.length === 0 ? (
            <div className="px-5 py-8 text-center">
              <p className="text-sm font-semibold">
                Your first workbook starts here.
              </p>
              <p className="mx-auto mt-2 max-w-sm text-xs font-light leading-relaxed text-muted-foreground">
                Create a sheet, then choose which cells to protect before
                saving.
              </p>
              <WorkspaceLink
                href="/workbooks/new"
                navigate={navigate}
                className="mt-4 inline-flex border px-4 py-2 text-sm font-semibold hover:bg-muted/50"
              >
                Create first workbook
              </WorkspaceLink>
            </div>
          ) : (
            recent.map((file) => (
              <WorkspaceLink
                key={file.id}
                href={`/workbooks/${file.id}`}
                navigate={navigate}
                className="flex items-center gap-3 border-b px-5 py-3 text-left last:border-b-0 hover:bg-muted/50"
              >
                <img src="/workbook.png" alt="" className="h-5 w-5 shrink-0" />
                <span className="min-w-0 flex-1 truncate text-sm">
                  {file.name}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {new Date(file.createdAt).toLocaleDateString()}
                </span>
              </WorkspaceLink>
            ))
          )}
          {data?.nextCursor && (
            <p className="border-t px-5 py-3 text-xs text-muted-foreground">
              Newest among loaded workbooks. Open Workbooks to load more.
            </p>
          )}
        </section>
        <section className="border" aria-labelledby="security-heading">
          <h2
            id="security-heading"
            className="border-b px-5 py-3.5 text-sm font-medium"
          >
            Security &amp; setup
          </h2>
          <div className="flex items-start gap-2.5 border-b px-5 py-3.5 text-sm">
            {unlocked ? (
              <Check className="mt-0.5 h-4 w-4 shrink-0 text-green-600 dark:text-green-400" />
            ) : (
              <KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            )}
            <div>
              {unlocked ? "Recovery access unlocked" : "Recovery access locked"}
              <p className="mt-1 text-xs font-light leading-relaxed text-muted-foreground">
                {unlocked
                  ? "Your key is available only in this browser tab."
                  : "Create or recover your key before opening encrypted workbooks."}
              </p>
            </div>
          </div>
          <div className="flex items-start gap-2.5 border-b px-5 py-3.5 text-sm">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            <div>
              Choose what stays private
              <p className="mt-1 text-xs font-light leading-relaxed text-muted-foreground">
                Protected cells are encrypted before upload. Unprotected cells
                and file names remain visible to Google.
              </p>
            </div>
          </div>
          <WorkspaceLink
            href="/recovery-access"
            navigate={navigate}
            className="flex items-start gap-2.5 px-5 py-3.5 text-sm hover:bg-muted/50"
          >
            <KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            <span>
              Recovery phrase reminder
              <span className="mt-1 block text-xs font-light leading-relaxed text-muted-foreground">
                Keep your 12 words safe offline. ZeroSheet cannot reset them.
              </span>
              <span className="mt-1 block text-xs text-[hsl(var(--link))]">
                Manage access →
              </span>
            </span>
          </WorkspaceLink>
        </section>
      </div>
    </main>
  );
}
