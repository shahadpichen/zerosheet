import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { ThemeProvider } from "./components/theme-provider.js";
import "./styles.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("The root element is missing");
}

createRoot(root).render(
  <StrictMode>
    {/* ZeroDrive and ZeroSheet share a class-based semantic theme. Keeping the
        provider above App ensures portals such as account menus inherit the
        same root light/dark variables as the rest of the interface. */}
    <ThemeProvider defaultTheme="system">
      <App />
    </ThemeProvider>
  </StrictMode>,
);
