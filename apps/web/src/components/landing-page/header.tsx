import { Menu } from "lucide-react";

import { ModeToggle } from "../mode-toggle.js";
import { Button } from "../ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu.js";

const REPOSITORY_URL = "https://github.com/shahadpichen/zerosheet";

/**
 * This intentionally follows ZeroDrive's public header instead of the denser
 * authenticated application header. A small brand, two text links, and one
 * theme control keep the first screen focused on understanding the product and
 * signing in. Anchor links are used because ZeroSheet does not yet ship a
 * separate public documentation router.
 */
export function LandingHeader(): React.JSX.Element {
  return (
    <header className="flex h-[10vh] min-h-16 items-center justify-between border-b px-4 sm:px-6 lg:px-10">
      <a
        href="/"
        className="flex items-center space-x-1 border-none bg-transparent p-0 text-foreground no-underline"
        aria-label="ZeroSheet home"
      >
        <span className="text-lg font-semibold">ZeroSheet</span>
      </a>

      {/* The desktop navigation reproduces ZeroDrive's visual rhythm. */}
      <nav className="hidden items-center gap-5 md:flex" aria-label="Primary">
        <a
          href="#how-it-works"
          className="text-sm font-medium text-foreground hover:underline"
        >
          How it works
        </a>
        <a
          href={REPOSITORY_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm font-medium text-foreground hover:underline"
        >
          Star on GitHub
        </a>
        <ModeToggle />
      </nav>

      {/* Mobile keeps the theme action visible and moves text links into the
          same shadcn dropdown pattern used by ZeroDrive. */}
      <div className="flex items-center gap-3 md:hidden">
        <ModeToggle />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" className="gap-2" aria-label="Open menu">
              <Menu />
              Menu
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuItem asChild>
              <a href="#how-it-works">How it works</a>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <a
                href={REPOSITORY_URL}
                target="_blank"
                rel="noopener noreferrer"
              >
                Star on GitHub
              </a>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
