import { Moon, Sun } from "lucide-react";
import { useTheme } from "./theme-provider.js";
import { Button } from "./ui/button.js";

/**
 * The visible icon describes the theme the user can switch to. The control is
 * deliberately a real shadcn Button so hover, focus, disabled, and theme states
 * remain consistent with every product action.
 */
export function ModeToggle(): React.JSX.Element {
  const { resolvedTheme, setPreference } = useTheme();
  const nextTheme = resolvedTheme === "light" ? "dark" : "light";

  return (
    <Button
      type="button"
      variant="outline"
      size="icon"
      onClick={() => setPreference(nextTheme)}
      aria-label={`Switch to ${nextTheme} theme`}
      title={`Switch to ${nextTheme} theme`}
    >
      {resolvedTheme === "light" ? <Moon /> : <Sun />}
    </Button>
  );
}
