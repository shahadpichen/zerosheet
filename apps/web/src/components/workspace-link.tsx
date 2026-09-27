import type { ComponentPropsWithoutRef } from "react";

/** Real links keep copy-link/new-tab behavior. Ordinary clicks stay in this
 * tab, so navigation never reloads the page and discards the recovery key. */
export function WorkspaceLink({
  navigate,
  href,
  children,
  ...props
}: Omit<ComponentPropsWithoutRef<"a">, "href" | "onClick"> & {
  href: string;
  navigate: (path: string) => void;
}) {
  return (
    <a
      {...props}
      href={href}
      onClick={(event) => {
        if (
          event.button === 0 &&
          !event.metaKey &&
          !event.ctrlKey &&
          !event.shiftKey &&
          !event.altKey
        ) {
          event.preventDefault();
          navigate(href);
        }
      }}
    >
      {children}
    </a>
  );
}
