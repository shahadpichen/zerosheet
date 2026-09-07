import type { AuthenticatedUser } from "@zerosheet/contracts";
import { LogOut, Sheet, UserRound } from "lucide-react";
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
 * this component never receives a Keycloak token or browser session value.
 */
export function AppHeader({
  user,
}: {
  // App always passes this property. Explicit `undefined` works with the
  // repository's exactOptionalPropertyTypes rule and means "no active user".
  user: AuthenticatedUser | undefined;
}): React.JSX.Element {
  return (
    <header className="border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
      <div className="mx-auto flex h-16 max-w-[1480px] items-center justify-between px-4 sm:px-6 lg:px-8">
        <a
          href="/"
          className="flex items-center gap-2 text-foreground no-underline"
          aria-label="ZeroSheet home"
        >
          <span className="flex h-9 w-9 items-center justify-center border bg-foreground text-background">
            <Sheet className="h-4 w-4" aria-hidden="true" />
          </span>
          <span className="font-semibold tracking-tight">ZeroSheet</span>
          <span className="hidden text-xs text-muted-foreground sm:inline">
            private sheets
          </span>
        </a>

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
                  <Avatar>
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
                {/* A normal POST form lets the browser follow Keycloak's
                    redirect and end both product and SSO sessions. Fetching
                    here would follow that navigation invisibly in JavaScript. */}
                <form action="/api/auth/logout" method="post">
                  <DropdownMenuItem asChild>
                    <button type="submit" className="w-full">
                      <LogOut />
                      Sign out everywhere
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
