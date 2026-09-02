import {
  AuthSessionResponseSchema,
  type AuthenticatedUser,
} from "@zerosheet/contracts";
import { useEffect, useState } from "react";

type SessionState =
  | { status: "loading" }
  | { status: "anonymous" }
  | { status: "authenticated"; user: AuthenticatedUser }
  | { status: "unavailable" };

/**
 * The browser asks only whether its opaque session is valid. It never reads a
 * Keycloak token and cannot inspect the HttpOnly session cookie. This is the
 * defining browser-facing-backend boundary: browser JavaScript receives a
 * narrow product user projection while protocol credentials remain on the
 * server.
 */
export function App() {
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

        if (body.authenticated) {
          setSession({ status: "authenticated", user: body.user });
        } else {
          setSession({ status: "anonymous" });
        }
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          setSession({ status: "unavailable" });
        }
      }
    }

    void loadSession();

    // React development StrictMode intentionally mounts effects twice. Aborting
    // the first request prevents an obsolete response from overwriting newer
    // state and also handles navigation away from the page.
    return () => cancellation.abort();
  }, []);

  return (
    <main>
      <p className="eyebrow">Milestone 6 · Contextual authorization</p>
      <h1>Relationships and current context must agree.</h1>
      <p className="intro">
        Keycloak establishes your ZeroSheet identity. OpenFGA decides durable
        organization, team, and workbook relationships. OPA separately checks
        current account and tenant policy before ZeroSheet permits an action.
      </p>

      <section className="session-card" aria-live="polite">
        {session.status === "loading" && (
          <p className="status">Checking your ZeroSheet session…</p>
        )}

        {session.status === "anonymous" && (
          <>
            <p className="status">You are not signed in.</p>
            <div className="login-actions">
              <a className="primary-action" href="/api/auth/login/google">
                Continue with Google
              </a>
              <a className="secondary-action" href="/api/auth/login">
                Use a local Keycloak account
              </a>
            </div>
          </>
        )}

        {session.status === "authenticated" && (
          <>
            <p className="status">Authenticated ZeroSheet user</p>
            <strong>{session.user.displayName}</strong>
            <span>{session.user.email}</span>
            <p className="authorization-note">
              Your session proves who you are. Every protected action requires
              the relevant OpenFGA relationship and current OPA policy to allow.
            </p>

            {/* A normal form navigation follows Keycloak's logout redirect.
                JavaScript fetch would follow it internally and hide the
                provider logout page from the browser. */}
            <form action="/api/auth/logout" method="post">
              <button className="secondary-action" type="submit">
                Sign out everywhere
              </button>
            </form>
          </>
        )}

        {session.status === "unavailable" && (
          <>
            <p className="status">The identity service is unavailable.</p>
            <button
              className="secondary-action"
              type="button"
              onClick={() => window.location.reload()}
            >
              Try again
            </button>
          </>
        )}
      </section>

      <p className="boundary-note">
        Browser: opaque HttpOnly cookie · API: session and policy enforcement ·
        Keycloak: authentication · OpenFGA: relationships · OPA: context
      </p>
    </main>
  );
}
