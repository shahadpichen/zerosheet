# ZeroSheet UI design system

## Decision

ZeroSheet shares ZeroDrive's visual language while keeping its own product
information architecture. Both products use the shadcn ownership model,
Fira Code typography, square surfaces, thin borders, restrained shadows, and
the same semantic light/dark color tokens.

We reuse a language rather than copying whole screens. ZeroDrive organizes a
file vault; ZeroSheet organizes organizations, workbooks, sharing policy, and a
spreadsheet editor. A permanent file-navigation sidebar would therefore copy
the wrong behavior even if it looked familiar.

## Why shadcn is source code, not a dependency

shadcn is a component recipe and registry. Components such as `Button`, `Card`,
`Avatar`, and `DropdownMenu` live in `apps/web/src/components/ui`, so ZeroSheet
can review and change their accessibility and styling like any other code.
Radix primitives supply difficult interaction behavior—keyboard navigation,
focus restoration, portal placement, and avatar fallback—without deciding the
product's appearance.

`apps/web/components.json` records the `new-york`, TypeScript, CSS-variable,
zinc-base configuration used by the shadcn CLI. Vite and TypeScript both map
`@` to `apps/web/src`, so components added from the registry later use one
consistent import convention.

## Theme architecture

Tailwind utilities refer to semantic roles such as `bg-background`,
`text-muted-foreground`, and `border-accent-border`. The actual HSL values live
in `apps/web/src/styles.css` and match ZeroDrive's light and dark palettes.

`ThemeProvider` stores only `light`, `dark`, or `system` in local storage. It
sets a corresponding class and `color-scheme` on the document root. When the
preference is `system`, it also listens for operating-system changes. No theme
choice or identity information is sent to the API.

The current Univer release exposes default and green themes but no supported
dark spreadsheet palette. ZeroSheet therefore keeps the editing canvas light
and explicitly sets `color-scheme: light`; the surrounding application chrome
still changes completely. This avoids unsupported CSS overrides that could
make cell selection, formula bars, or plugin popovers unreadable.

## Authentication UX

The public page exposes one action: **Continue with Google**. The local
Keycloak learner account remains useful for IAM development, but it is not
advertised as a customer account type. Google login still flows through
Keycloak and creates the same protected PKCE/state/nonce transaction as before.

Google Drive access remains a second, clearly labeled action after sign-in.
This preserves least privilege: proving identity does not silently authorize
the application to operate on Drive files.

## Responsive and accessibility rules

- Interactive controls use real links, buttons, and POST forms rather than
  clickable generic elements.
- Every icon-only control has an accessible label and visible focus ring.
- Radix owns account-menu keyboard and focus behavior.
- The layout stacks at narrow widths without hiding security explanations or
  the only login action.
- Reduced-motion preferences collapse decorative animation and transitions.
- Theme colors are semantic, so new components must not add unrelated
  hard-coded light/dark surfaces. The Univer canvas is the documented exception.

## Adding a component

Run the shadcn CLI from `apps/web`, review the generated source, replace any
unnecessary dependency, and retain comments that explain behavior or trust
boundaries. A generated component is not accepted merely because it renders;
it must pass formatting, lint, type checking, build verification, keyboard
inspection, and light/dark responsive review.
