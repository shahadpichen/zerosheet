import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { GoogleOnboardingNotice } from "./google-onboarding-notice.js";
import { GoogleAuth } from "./landing-page/google-auth.js";
import { Faq } from "./landing-page/faq.js";

/** Server rendering checks user-facing copy without an account or a browser. */
describe("combined Google onboarding UI", () => {
  it("shows one Continue with Google action and describes combined consent", () => {
    const markup = renderToStaticMarkup(<GoogleAuth />);
    expect(markup).toContain("Continue with Google");
    const faq = renderToStaticMarkup(<Faq />);
    expect(faq).toContain("One Google consent flow signs you in");
    expect(faq).not.toContain("Why are sign-in and Drive access separate?");
  });

  it("shows a safe retry only when setup failed", () => {
    expect(
      renderToStaticMarkup(<GoogleOnboardingNotice failed={false} />),
    ).toBe("");
    const markup = renderToStaticMarkup(<GoogleOnboardingNotice failed />);
    expect(markup).toContain('role="alert"');
    expect(markup).toContain('href="/api/auth/login/google"');
    expect(markup).toContain("No new sign-in session was created");
  });
});
