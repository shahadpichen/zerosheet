import {
  AuthSessionResponseSchema,
  type AuthenticatedUser,
} from "@zerosheet/contracts";
import { LoaderCircle, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { LandingPage } from "./LandingPage.js";
import { AppHeader } from "./components/app-header.js";
import { WorkspaceApp } from "./WorkspaceApp.js";
import { Button } from "./components/ui/button.js";
import {
  Card,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "./components/ui/card.js";
import { clearGoogleStorageAccess } from "./google-storage.js";
import { GoogleOnboardingNotice } from "./components/google-onboarding-notice.js";

type SessionState =
  | { status: "loading" }
  | { status: "anonymous" }
  | { status: "authenticated"; user: AuthenticatedUser }
  | { status: "unavailable" };

/**
 * The browser asks only whether its opaque session is valid. It never reads a
 * Google token and cannot inspect the HttpOnly session cookie. The visual
 * redesign therefore changes presentation only; the BFF remains the sole
 * authority that turns a cookie into a safe product-user projection.
 */
export function App(): React.JSX.Element {
  const [session, setSession] = useState<SessionState>({ status: "loading" });

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
    // Sign-in already connects Drive, so there is no second connection check
    // or setup panel here. Still discard any in-memory Google access token
    // whenever this page no longer has a verified product session.
    if (session.status !== "authenticated") {
      clearGoogleStorageAccess();
    }
  }, [session.status]);

  const user = session.status === "authenticated" ? session.user : undefined;

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* The public page owns ZeroDrive's sparse marketing header. Product
          states retain the authenticated header and account controls. */}
      {session.status !== "anonymous" && session.status !== "authenticated" && (
        <AppHeader user={user} />
      )}

      <GoogleOnboardingNotice
        failed={
          new URLSearchParams(window.location.search).get("auth_error") ===
          "google_storage_setup_required"
        }
      />

      {session.status === "loading" && <LoadingScreen />}
      {session.status === "anonymous" && <LandingPage />}
      {session.status === "unavailable" && <UnavailableScreen />}
      {session.status === "authenticated" && (
        <AuthenticatedWorkspace user={session.user} />
      )}
    </div>
  );
}

/** Home is the signed-in hub. WorkspaceApp owns navigation and the recovery
 * gate, so switching product pages never reloads the memory-only key session. */
export function AuthenticatedWorkspace({
  user,
}: {
  user: AuthenticatedUser;
}): React.JSX.Element {
  return <WorkspaceApp key={user.id} user={user} />;
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
