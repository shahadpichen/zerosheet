import { LANDING_SECTIONS } from "./components/landing-page/content.js";
import { Faq } from "./components/landing-page/faq.js";
import { LandingFooter } from "./components/landing-page/footer.js";
import { GoogleAuth } from "./components/landing-page/google-auth.js";
import { LandingHeader } from "./components/landing-page/header.js";
import { RecoveryPhrase } from "./components/landing-page/recovery-phrase.js";

/**
 * The public page intentionally mirrors ZeroDrive's hierarchy and responsive
 * classes. ZeroSheet-specific wording is the only meaningful difference: it
 * describes selective cells, workbook keys, HPKE recipients, and enterprise
 * authorization instead of whole-file encryption.
 */
export function LandingPage(): React.JSX.Element {
  return (
    <section
      className="container relative mx-auto w-full"
      itemScope
      itemType="https://schema.org/WebSite"
    >
      <meta itemProp="name" content="ZeroSheet" />
      <LandingHeader />

      <div
        className="mx-auto mt-20 max-w-screen-xl px-5 sm:px-6 lg:px-[12vw]"
        itemScope
        itemType="https://schema.org/SoftwareApplication"
      >
        <meta itemProp="name" content="ZeroSheet" />
        <meta itemProp="applicationCategory" content="SecurityApplication" />
        <meta itemProp="operatingSystem" content="Modern web browsers" />

        <div className="text-center">
          <h1 className="mx-auto text-2xl md:w-[70%] md:text-3xl">
            End-to-End Encrypted Spreadsheets on{" "}
            <span aria-label="Google">
              <span className="text-[#4285F4]">G</span>
              <span className="text-[#EA4335]">o</span>
              <span className="text-[#FBBC05]">o</span>
              <span className="text-[#4285F4]">g</span>
              <span className="text-[#34A853]">l</span>
              <span className="text-[#EA4335]">e</span>
            </span>{" "}
            Sheets
          </h1>

          <ul className="mt-6 inline-block list-decimal pl-6 text-left font-light leading-relaxed md:mt-10">
            <li>
              A <strong className="font-medium text-foreground">simple</strong>,{" "}
              <strong className="font-medium text-foreground">
                privacy-focused
              </strong>{" "}
              way to protect sensitive spreadsheet cells
            </li>
            <li>Encrypt selected cells or entire columns in your browser</li>
            <li>Keep encrypted workbook data in your own Google account</li>
            <li>Share securely with organization members, teams, and guests</li>
          </ul>

          <div className="mt-8 flex flex-col items-center">
            <GoogleAuth />
            <p className="mt-4 text-sm text-muted-foreground">
              Sign in and connect Google Drive in one step
            </p>
          </div>
        </div>
      </div>

      {/* These repeated text sections intentionally match ZeroDrive's quiet,
          documentation-like landing page instead of introducing sales cards. */}
      <div className="mt-[5vh] flex flex-col gap-6 px-5 pb-[2vh] text-center lg:px-[12vw]">
        {LANDING_SECTIONS.map((section, index) => (
          <section
            key={section.id}
            id={section.id}
            className="mb-5 scroll-mt-8"
          >
            {section.heading && (
              <h2 className="mb-5 text-center text-2xl">{section.heading}</h2>
            )}
            <div className="inline-block text-left text-base font-light leading-relaxed md:w-[85%]">
              {section.description}
            </div>
            {index === 2 && <RecoveryPhrase />}
          </section>
        ))}
      </div>

      <div className="mt-[10vh] px-5 pb-[2vh] lg:px-[12vw]">
        <Faq />
      </div>

      <LandingFooter />
    </section>
  );
}
