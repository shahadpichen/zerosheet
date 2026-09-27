import { LoaderCircle } from "lucide-react";
import { useState } from "react";

import { Button } from "../ui/button.js";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog.js";

/** Google's four-color mark is inline so the sign-in button does not depend on
 * a remote image, a tracker, or an asset that can fail before authentication. */
function GoogleMark(): React.JSX.Element {
  return (
    <svg viewBox="0 0 18 18" className="h-4 w-4" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M17.64 9.205c0-.638-.057-1.252-.164-1.841H9v3.481h4.844c-.209 1.125-.843 2.078-1.797 2.716v2.258h2.909c1.702-1.567 2.684-3.874 2.684-6.614Z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.909-2.259c-.806.54-1.835.86-3.047.86-2.344 0-4.328-1.585-5.037-3.714H.956v2.332A9 9 0 0 0 9 18Z"
      />
      <path
        fill="#FBBC05"
        d="M3.963 10.707A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.281-1.707V4.961H.956A9 9 0 0 0 0 9c0 1.45.347 2.824.956 4.039l3.007-2.332Z"
      />
      <path
        fill="#EA4335"
        d="M9 3.579c1.321 0 2.507.454 3.44 1.345l2.582-2.582C13.463.891 11.426 0 9 0A9 9 0 0 0 .956 4.961l3.007 2.332C4.672 5.164 6.656 3.579 9 3.579Z"
      />
    </svg>
  );
}

/**
 * ZeroDrive explains Google access before leaving the application. ZeroSheet
 * keeps that explanation, but one Google consent flow now signs the person in
 * and connects storage. File access still does not grant decryption keys or
 * ZeroSheet roles; those remain separate security controls behind the simple UX.
 */
export function GoogleAuth(): React.JSX.Element {
  const [isOpen, setIsOpen] = useState(false);
  const [isRedirecting, setIsRedirecting] = useState(false);

  function continueWithGoogle(): void {
    setIsRedirecting(true);
    window.location.assign("/api/auth/login/google");
  }

  return (
    <>
      <Button
        type="button"
        className="px-8 py-2 h-12 text-base font-medium w-fit shadow-md"
        onClick={() => setIsOpen(true)}
        disabled={isRedirecting}
      >
        {isRedirecting ? (
          <>
            <LoaderCircle className="animate-spin" />
            Redirecting to Google…
          </>
        ) : (
          <>
            <GoogleMark />
            Continue with Google
          </>
        )}
      </Button>

      <Dialog open={isOpen} onOpenChange={setIsOpen}>
        <DialogContent className="sm:max-w-[560px]">
          <DialogHeader>
            <DialogTitle>Sign in and connect your Google Drive</DialogTitle>
            <DialogDescription>
              Google verifies who you are. ZeroSheet manages its own workspace
              membership, roles, and workbook permissions.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 text-sm font-light leading-relaxed text-muted-foreground">
            <p>
              Continue once to sign in and connect storage with the same Google
              account. Your Google password is entered on Google and never
              reaches ZeroSheet.
            </p>
            <p>
              Allow access to files you create or select with ZeroSheet and its
              hidden app-data folder for your encrypted key backup. This does
              not request unrestricted access to every file in your Drive.
            </p>
            <p>
              Protected cells are encrypted in your browser. Recovery phrases,
              opened private keys, workbook keys, and plaintext protected cells
              are not sent to Google or the ZeroSheet API.
            </p>
          </div>

          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={isRedirecting}>
                Cancel
              </Button>
            </DialogClose>
            <Button
              type="button"
              onClick={continueWithGoogle}
              disabled={isRedirecting}
            >
              {isRedirecting ? (
                <>
                  <LoaderCircle className="animate-spin" />
                  Redirecting…
                </>
              ) : (
                <>
                  <GoogleMark />
                  Continue with Google
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
