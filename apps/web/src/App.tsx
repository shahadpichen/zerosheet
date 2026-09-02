import {
  AuthSessionResponseSchema,
  GoogleStorageConnectionStatusSchema,
  type AuthenticatedUser,
  type GoogleStorageConnectionStatus,
} from "@zerosheet/contracts";
import { ENCRYPTED_CELL_PREFIX } from "@zerosheet/crypto";
import { lazy, Suspense, useEffect, useState } from "react";
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
  | { status: "idle" | "loading" | "unavailable" }
  | { status: "ready"; connection: GoogleStorageConnectionStatus };

/**
 * The browser asks only whether its opaque session is valid. It never reads a
 * Keycloak token and cannot inspect the HttpOnly session cookie. This is the
 * defining browser-facing-backend boundary: browser JavaScript receives a
 * narrow product user projection while protocol credentials remain on the
 * server.
 */
export function App() {
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
        const connection = GoogleStorageConnectionStatusSchema.parse(
          await response.json(),
        );
        setStorage({ status: "ready", connection });
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

  return (
    <main>
      <p className="eyebrow">Milestone 12 · Selective encrypted editor</p>
      <h1>The browser owns editing and plaintext.</h1>
      <p className="intro">
        Protected values are encrypted in the authorized browser before Google
        or the ZeroSheet API can see them. Keycloak proves who signed in;
        possession of the separately recovered workbook key determines who can
        decrypt protected cells.
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
              Your session proves who you are, but it does not decrypt a
              workbook. Recovery access and the exact recipient key envelope
              remain independent requirements.
            </p>

            <div className="storage-connection">
              <p className="status">Independent Google storage grant</p>
              {(storage.status === "idle" || storage.status === "loading") && (
                <span>Checking Drive connection…</span>
              )}
              {storage.status === "unavailable" && (
                <span>Drive connection status is temporarily unavailable.</span>
              )}
              {storage.status === "ready" && !storage.connection.configured && (
                <span>
                  Drive connection is disabled until its separate OAuth client
                  is configured.
                </span>
              )}
              {storage.status === "ready" &&
                storage.connection.configured &&
                !storage.connection.connected && (
                  <a
                    className="primary-action"
                    href="/api/google/storage/connect"
                  >
                    Connect Google Drive
                  </a>
                )}
              {storage.status === "ready" && storage.connection.connected && (
                <>
                  <span>
                    Connected with narrow file and encrypted-backup access.
                  </span>
                  <button
                    className="secondary-action"
                    type="button"
                    onClick={() => void disconnectGoogleStorage()}
                  >
                    Disconnect Google Drive
                  </button>
                </>
              )}
            </div>

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

      {session.status === "authenticated" && (
        <Suspense
          fallback={
            <section className="editor-card" aria-live="polite">
              Loading the local spreadsheet engine…
            </section>
          }
        >
          <EncryptedSheetEditor />
        </Suspense>
      )}

      <p className="boundary-note">
        Browser: plaintext, recovery, and Web Crypto · Protected cell marker:{" "}
        <code>{ENCRYPTED_CELL_PREFIX}</code> · Keycloak: human identity ·
        OpenFGA + OPA: authorization · Google: protected-cell ciphertext,
        unprotected values, and metadata · PostgreSQL: metadata, encrypted key
        envelopes, and an encrypted Google refresh token
      </p>
    </main>
  );
}
