import { Button } from "./ui/button.js";

/**
 * Display only our fixed recovery message, never arbitrary provider text from
 * a URL. Show it for existing sessions too: an interrupted account switch may
 * leave the old session valid, but the user still needs to see setup failed.
 */
export function GoogleOnboardingNotice({
  failed,
}: {
  failed: boolean;
}): React.JSX.Element | null {
  if (!failed) return null;
  return (
    <div
      role="alert"
      className="mx-auto mt-6 max-w-2xl space-y-3 border border-destructive/40 bg-card p-5 text-sm text-foreground"
    >
      <p>
        Google Drive setup couldn’t finish. Try again and allow the requested
        Drive permissions so ZeroSheet can save your spreadsheets and encrypted
        key backup.
      </p>
      <p className="text-muted-foreground">
        If you already allowed them, setup may be temporarily unavailable. No
        new sign-in session was created.
      </p>
      <Button asChild variant="outline">
        <a href="/api/auth/login/google">Try again with Google</a>
      </Button>
    </div>
  );
}
