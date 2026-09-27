import type { AuthenticatedUser } from "@zerosheet/contracts";
import { LogOut, UserRound } from "lucide-react";
import { ModeToggle } from "./mode-toggle.js";
import { Avatar, AvatarFallback } from "./ui/avatar.js";
import { Button } from "./ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu.js";
import { WorkspaceLink } from "./workspace-link.js";

function initials(user: AuthenticatedUser): string {
  const parts = user.displayName.trim().split(/\s+/u).filter(Boolean);
  if (parts.length > 1) {
    return `${parts[0]?.[0] ?? ""}${parts[1]?.[0] ?? ""}`.toUpperCase();
  }
  return (parts[0]?.[0] ?? user.email[0] ?? "?").toUpperCase();
}

/**
 * ZeroDrive's sparse top navigation becomes the shared ZeroSheet application
 * chrome. Authentication data is restricted to the safe product projection;
 * this component never receives a Google token or browser session value.
 */
export function AppHeader({
  user,
  navigate,
}: {
  // App always passes this property. Explicit `undefined` works with the
  // repository's exactOptionalPropertyTypes rule and means "no active user".
  user: AuthenticatedUser | undefined;
  navigate?: (path: string) => void;
}): React.JSX.Element {
  return (
    <header className="container mx-auto border-b bg-background">
      <div className="flex min-h-20 items-center justify-between gap-4 px-6 pb-4 pt-5 sm:px-10">
        {navigate ? (
          <WorkspaceLink
            href="/home"
            navigate={navigate}
            className="text-lg font-semibold"
            aria-label="ZeroSheet home"
          >
            ZeroSheet
          </WorkspaceLink>
        ) : (
          <a
            href="/"
            className="text-lg font-semibold"
            aria-label="ZeroSheet home"
          >
            ZeroSheet
          </a>
        )}

        <div className="flex items-center gap-2">
          <ModeToggle />

          {user && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={`Open account menu for ${user.displayName}`}
                >
                  <Avatar className="h-9 w-9 rounded-full">
                    <AvatarFallback>{initials(user)}</AvatarFallback>
                  </Avatar>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-72">
                <DropdownMenuLabel className="font-normal">
                  <span className="flex items-start gap-3">
                    <UserRound className="mt-0.5 h-4 w-4 text-muted-foreground" />
                    <span className="min-w-0">
                      <span className="block truncate font-medium">
                        {user.displayName}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {user.email}
                      </span>
                    </span>
                  </span>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                {/* A normal POST form clears the server-side ZeroSheet session
                    without exposing the opaque cookie to JavaScript. */}
                <form action="/api/auth/logout" method="post">
                  <DropdownMenuItem asChild>
                    <button type="submit" className="w-full">
                      <LogOut />
                      Sign out
                    </button>
                  </DropdownMenuItem>
                </form>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>
    </header>
  );
}
