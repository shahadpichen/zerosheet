import type { ReactNode } from "react";

/**
 * Public claims live as structured content so the page keeps ZeroDrive's
 * repeated section layout while each sentence can be reviewed against the
 * ZeroSheet trust model. JSX is used instead of runtime Markdown because these
 * are product-owned statements, not user-authored content.
 */
export const LANDING_SECTIONS: readonly {
  readonly id: string;
  readonly heading?: string;
  readonly description: ReactNode;
}[] = [
  {
    id: "how-it-works",
    heading: "An Encryption Layer for Google Sheets",
    description: (
      <>
        ZeroSheet does not replace Google Sheets. It adds a{" "}
        <u>private encryption layer</u> for the cells you choose. Your browser
        encrypts protected values before saving, so Google stores ciphertext
        while ordinary cells keep normal spreadsheet behavior.
      </>
    ),
  },
  {
    id: "ownership",
    heading: "Your Workbooks, Your Keys, Enterprise Control",
    description: (
      <>
        Workbook keys and user HPKE keys are created in your browser. Google
        remains the storage provider, while ZeroSheet uses{" "}
        <u>
          organization membership, OpenFGA relationships, and contextual policy
        </u>{" "}
        to decide who may work with each workbook. Authorization can grant
        access, but it cannot decrypt a protected cell without the recipient's
        matching key envelope.
      </>
    ),
  },
  {
    id: "sharing",
    heading: "Encrypted Sharing for People and Teams",
    description: (
      <>
        Sharing coordinates three separate capabilities: a ZeroSheet role, a
        Google Drive permission, and an <u>HPKE-wrapped workbook key</u> for the
        exact recipient. The creator never shares their recovery phrase. Each
        collaborator receives an independently encrypted envelope their browser
        can open with its own private key.
        <br />
        <br />
        Your <u>12-word recovery phrase</u> opens the encrypted backup of your
        private HPKE key. That private key opens your workbook-key envelopes,
        and those workbook keys decrypt only the protected cells you are allowed
        to read.
      </>
    ),
  },
  {
    id: "promise",
    description: (
      <>
        Privacy through selective E2E encryption; collaboration through Google;
        enterprise authorization through open standards.
      </>
    ),
  },
];
