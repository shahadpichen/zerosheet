const REPOSITORY_URL = "https://github.com/shahadpichen/zerosheet";

/** ZeroDrive's compact footer is retained without linking to pages ZeroSheet
 * has not built yet; architecture and security links point to real documents. */
export function LandingFooter(): React.JSX.Element {
  return (
    <footer
      className="mt-10 border-t pb-12 pt-10 text-center text-sm md:pt-14"
      itemScope
      itemType="https://schema.org/Organization"
    >
      <p>
        &copy; <span itemProp="name">ZeroSheet</span> — Selective browser
        encryption and enterprise access control for Google Sheets.
      </p>

      <div className="mt-4 flex flex-wrap justify-center gap-4">
        <a href="#how-it-works" className="text-sm hover:underline">
          How it works
        </a>
        <a href="#recovery" className="text-sm hover:underline">
          Keys and recovery
        </a>
        <a href="#faq" className="text-sm hover:underline">
          FAQ
        </a>
        <a
          href={REPOSITORY_URL + "/blob/main/docs/security/threat-model.md"}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm hover:underline"
        >
          Security model
        </a>
        <a
          href={REPOSITORY_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm hover:underline"
          itemProp="sameAs"
        >
          GitHub
        </a>
      </div>

      <p className="mt-4">Created by Shahad Pichen</p>
    </footer>
  );
}
