import {
  AuthSessionResponseSchema,
  GoogleStorageConnectionStatusSchema,
  type AuthenticatedUser,
  type GoogleStorageConnectionStatus,
} from "@zerosheet/contracts";
import { ENCRYPTED_CELL_PREFIX } from "@zerosheet/crypto";
import {
  ArrowRight,
  Check,
  Cloud,
  CloudOff,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  RefreshCw,
  ShieldCheck,
  TableProperties,
} from "lucide-react";
import { lazy, Suspense, useEffect, useState } from "react";
import { AppHeader } from "./components/app-header.js";
import { Badge } from "./components/ui/badge.js";
import { Button } from "./components/ui/button.js";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "./components/ui/card.js";
import { Separator } from "./components/ui/separator.js";
import { clearGoogleStorageAccess } from "./google-storage.js";

const EncryptedSheetEditor = lazy(async () => {
  const module = await import("./EncryptedSheetEditor.js");
  return { default: module.EncryptedSheetEditor };
});

type SessionState =
  | { status: "loading" }
  | { status: "anonymous" }
  | { status: "authenticated"; user: AuthenticatedUser }
  | { status: "unavailable" };

type StorageState =
  // Keep each status as its own union member. TypeScript can then prove that
  // only the ready state carries a connection before UI reads that property.
  | { status: "idle" }
  | { status: "loading" }
  | { status: "unavailable" }
  | { status: "ready"; connection: GoogleStorageConnectionStatus };

/**
 * The browser asks only whether its opaque session is valid. It never reads a
 * Keycloak token and cannot inspect the HttpOnly session cookie. The visual
 * redesign therefore changes presentation only; the BFF remains the sole
 * authority that turns a cookie into a safe product-user projection.
 */
export function App(): React.JSX.Element {
  const [session, setSession] = useState<SessionState>({ status: "loading" });
  const [storage, setStorage] = useState<StorageState>({ status: "idle" });

  useEffect(() => {
    const cancellation = new AbortController();

    async function loadSession(): Promise<void> {
      try {
        const response = await fetch("/api/auth/me", {
          method: "GET",
          credentials: "same-origin",
          headers: { Accept: "application/json" },
          signal: cancellation.signal,
        });
        const body = AuthSessionResponseSchema.parse(await response.json());

        setSession(
          body.authenticated
            ? { status: "authenticated", user: body.user }
            : { status: "anonymous" },
        );
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          setSession({ status: "unavailable" });
        }
      }
    }

    void loadSession();

    // React development StrictMode intentionally mounts effects twice. Aborting
    // the first request prevents an obsolete response from winning the race.
    return () => cancellation.abort();
  }, []);

  useEffect(() => {
    if (session.status !== "authenticated") {
      setStorage({ status: "idle" });
      clearGoogleStorageAccess();
      return;
    }

    const cancellation = new AbortController();
    setStorage({ status: "loading" });

    async function loadStorageConnection(): Promise<void> {
      try {
        const response = await fetch("/api/google/storage/status", {
          method: "GET",
          credentials: "same-origin",
          headers: { Accept: "application/json" },
          signal: cancellation.signal,
        });
        if (!response.ok) throw new Error("storage status unavailable");
        setStorage({
          status: "ready",
          connection: GoogleStorageConnectionStatusSchema.parse(
            await response.json(),
          ),
        });
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          setStorage({ status: "unavailable" });
        }
      }
    }

    void loadStorageConnection();
    return () => cancellation.abort();
  }, [session.status]);

  async function disconnectGoogleStorage(): Promise<void> {
    const response = await fetch("/api/google/storage/disconnect", {
      method: "POST",
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      setStorage({ status: "unavailable" });
      return;
    }
    clearGoogleStorageAccess();
    setStorage({
      status: "ready",
      connection: {
        configured: true,
        connected: false,
        requiredScopes: [
          "https://www.googleapis.com/auth/drive.file",
          "https://www.googleapis.com/auth/drive.appdata",
        ],
      },
    });
  }

  const user = session.status === "authenticated" ? session.user : undefined;

  return (
    <div className="min-h-screen bg-background text-foreground">
      <AppHeader user={user} />

      {session.status === "loading" && <LoadingScreen />}
      {session.status === "anonymous" && <AnonymousHome />}
      {session.status === "unavailable" && <UnavailableScreen />}
      {session.status === "authenticated" && (
        <AuthenticatedWorkspace
          user={session.user}
          storage={storage}
          disconnectGoogleStorage={disconnectGoogleStorage}
        />
      )}
    </div>
  );
}

/**
 * Public onboarding exposes only Google federation. Development can retain a
 * local Keycloak test user for IAM exercises, but customer UI must not suggest
 * that ZeroSheet operates a second password-account system.
 */
function AnonymousHome(): React.JSX.Element {
  const guarantees = [
    {
      icon: LockKeyhole,
      title: "Cell-level privacy",
      copy: "Protect a selection or full columns before data reaches Google.",
    },
    {
      icon: KeyRound,
      title: "Keys stay with people",
      copy: "Recovery and workbook keys are created and opened in the browser.",
    },
    {
      icon: ShieldCheck,
      title: "Enterprise access",
      copy: "Keycloak, OpenFGA, and policy checks decide who may open a workbook.",
    },
  ] as const;

  return (
    <main>
      <section className="relative overflow-hidden border-b">
        <div className="sheet-grid-background pointer-events-none absolute inset-0" />
        <div className="relative mx-auto grid max-w-6xl gap-12 px-5 py-16 sm:px-6 sm:py-24 lg:grid-cols-[1fr_420px] lg:items-center lg:px-8 lg:py-28">
          <div>
            <Badge variant="accent" className="mb-6 gap-2">
              <ShieldCheck className="h-3.5 w-3.5" />
              End-to-end encrypted spreadsheets
            </Badge>
            <h1 className="max-w-3xl text-3xl font-medium leading-tight tracking-tight sm:text-5xl lg:text-6xl">
              Keep the spreadsheet. Hide the sensitive cells.
            </h1>
            <p className="mt-6 max-w-2xl text-sm font-light leading-7 text-muted-foreground sm:text-base">
              ZeroSheet adds browser-owned encryption and enterprise access
              controls to Google Sheets. Teams keep familiar collaboration;
              Google and the ZeroSheet server receive ciphertext for fields you
              mark private.
            </p>

            <div className="mt-8 grid gap-4 sm:grid-cols-3">
              {guarantees.map(({ icon: Icon, title, copy }) => (
                <div key={title} className="border bg-background/70 p-4">
                  <Icon className="mb-4 h-5 w-5" aria-hidden="true" />
                  <h2 className="text-sm font-semibold">{title}</h2>
                  <p className="mt-2 text-xs font-light leading-5 text-muted-foreground">
                    {copy}
                  </p>
                </div>
              ))}
            </div>
          </div>

          <Card className="bg-card/95 shadow-xl">
            <CardHeader>
              <div className="mb-4 flex h-11 w-11 items-center justify-center border bg-foreground text-background">
                <TableProperties className="h-5 w-5" aria-hidden="true" />
              </div>
              <CardTitle className="text-xl">Open your workspace</CardTitle>
              <CardDescription>
                Google proves your identity to Keycloak. ZeroSheet never sees
                your Google password.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button asChild size="lg" className="w-full">
                <a href="/api/auth/login/google">
                  <span
                    aria-hidden="true"
                    className="flex h-5 w-5 items-center justify-center border border-current text-xs font-bold"
                  >
                    G
                  </span>
                  Continue with Google
                  <ArrowRight />
                </a>
              </Button>
              <p className="mt-4 text-center text-xs leading-5 text-muted-foreground">
                Drive access is requested separately after sign-in, only when
                you choose to connect storage.
              </p>
            </CardContent>
            <CardFooter className="flex-col items-stretch gap-3">
              <Separator />
              <p className="text-xs font-light leading-5 text-muted-foreground">
                Your 12-word recovery phrase is never sent to Google, Keycloak,
                or the ZeroSheet API.
              </p>
            </CardFooter>
          </Card>
        </div>
      </section>

      <footer className="mx-auto flex max-w-6xl flex-col gap-2 px-5 py-8 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between sm:px-6 lg:px-8">
        <span>ZeroSheet · privacy by architecture</span>
        <span>Google stores sheets · your browser owns plaintext</span>
      </footer>
    </main>
  );
}

function AuthenticatedWorkspace({
  user,
  storage,
  disconnectGoogleStorage,
}: {
  user: AuthenticatedUser;
  storage: StorageState;
  disconnectGoogleStorage: () => Promise<void>;
}): React.JSX.Element {
  return (
    <main className="mx-auto max-w-[1480px] px-4 pb-16 pt-10 sm:px-6 lg:px-8">
      <div className="flex flex-col gap-5 border-b pb-8 md:flex-row md:items-end md:justify-between">
        <div>
          <Badge variant="outline" className="mb-4 gap-2">
            <Check className="h-3.5 w-3.5" />
            Identity verified
          </Badge>
          <h1 className="text-3xl font-medium tracking-tight sm:text-4xl">
            Encrypted workbook lab
          </h1>
          <p className="mt-3 max-w-3xl text-sm font-light leading-6 text-muted-foreground">
            Welcome, {user.displayName}. Select the cells Google must not read,
            then inspect the locally verified encrypted batch.
          </p>
        </div>
        <StorageConnection
          storage={storage}
          disconnectGoogleStorage={disconnectGoogleStorage}
        />
      </div>

      <Suspense
        fallback={
          <Card className="mt-8">
            <CardContent className="flex min-h-72 items-center justify-center gap-3 p-8 text-sm text-muted-foreground">
              <LoaderCircle className="animate-spin" />
              Loading the local spreadsheet engine…
            </CardContent>
          </Card>
        }
      >
        <EncryptedSheetEditor />
      </Suspense>

      <section className="mt-8 grid gap-4 border-t pt-8 text-xs leading-5 text-muted-foreground md:grid-cols-3">
        <p>
          <strong className="block text-foreground">Browser boundary</strong>
          Plaintext, recovery phrases, Web Crypto, and workbook keys.
        </p>
        <p>
          <strong className="block text-foreground">Control boundary</strong>
          Keycloak identity plus OpenFGA and OPA authorization decisions.
        </p>
        <p>
          <strong className="block text-foreground">Storage boundary</strong>
          Google receives visible values, metadata, and protected-cell values
          beginning with <code>{ENCRYPTED_CELL_PREFIX}</code>.
        </p>
      </section>
    </main>
  );
}

/** Authentication and Drive authorization remain visibly separate grants. */
function StorageConnection({
  storage,
  disconnectGoogleStorage,
}: {
  storage: StorageState;
  disconnectGoogleStorage: () => Promise<void>;
}): React.JSX.Element {
  if (storage.status === "idle" || storage.status === "loading") {
    return (
      <div className="flex min-w-64 items-center gap-3 border bg-card px-4 py-3 text-xs text-muted-foreground">
        <LoaderCircle className="animate-spin" />
        Checking Google Drive…
      </div>
    );
  }

  if (storage.status === "unavailable") {
    return (
      <div className="flex min-w-64 items-center gap-3 border bg-card px-4 py-3 text-xs text-muted-foreground">
        <CloudOff />
        Drive status unavailable
      </div>
    );
  }

  if (!storage.connection.configured) {
    return (
      <div className="flex min-w-64 items-center gap-3 border bg-card px-4 py-3 text-xs text-muted-foreground">
        <CloudOff />
        Drive OAuth is not configured
      </div>
    );
  }

  if (!storage.connection.connected) {
    return (
      <Button asChild variant="outline">
        <a href="/api/google/storage/connect">
          <Cloud />
          Connect Google Drive
        </a>
      </Button>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <Badge variant="accent" className="h-10 gap-2 px-3">
        <Cloud className="h-4 w-4" />
        Drive connected
      </Badge>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => void disconnectGoogleStorage()}
      >
        Disconnect
      </Button>
    </div>
  );
}

function LoadingScreen(): React.JSX.Element {
  return (
    <main className="mx-auto flex min-h-[calc(100vh-4rem)] max-w-6xl items-center justify-center px-6">
      <div className="flex items-center gap-3 text-sm text-muted-foreground">
        <LoaderCircle className="animate-spin" />
        Checking your ZeroSheet session…
      </div>
    </main>
  );
}

function UnavailableScreen(): React.JSX.Element {
  return (
    <main className="mx-auto flex min-h-[calc(100vh-4rem)] max-w-lg items-center px-6">
      <Card className="w-full">
        <CardHeader>
          <CardTitle>Identity service unavailable</CardTitle>
          <CardDescription>
            ZeroSheet could not verify the browser session. Your workbook data
            was not opened or changed.
          </CardDescription>
        </CardHeader>
        <CardFooter>
          <Button type="button" onClick={() => window.location.reload()}>
            <RefreshCw />
            Try again
          </Button>
        </CardFooter>
      </Card>
    </main>
  );
}
