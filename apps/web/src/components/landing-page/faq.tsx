import type { ReactNode } from "react";

const FAQS: readonly {
  readonly question: string;
  readonly answer: ReactNode;
}[] = [
  {
    question: "Can Google or ZeroSheet read protected cells?",
    answer:
      "Not from stored data. Protected values are encrypted in the browser before sync. Google and the ZeroSheet API receive ciphertext, not the protected plaintext or raw workbook key.",
  },
  {
    question: "Does encrypting cells break the rest of the spreadsheet?",
    answer:
      "Only selected cells or columns are protected. Ordinary cells remain normal Google Sheets values, so teams can keep familiar spreadsheet workflows around the sensitive fields.",
  },
  {
    question: "What happens if I lose my recovery phrase?",
    answer:
      "ZeroSheet cannot reset it or bypass the encryption. You may permanently lose the ability to open your encrypted private-key backup and the workbook keys shared with that identity.",
  },
  {
    question: "Why does signing in request Google Drive access?",
    answer:
      "One Google consent flow signs you in and connects your spreadsheet storage. ZeroSheet requests access to app-created or selected files and its hidden encrypted-backup folder, not every file in your Drive. These permissions do not reveal your recovery phrase or decrypt protected cells.",
  },
  {
    question: "Where do roles live without Keycloak?",
    answer:
      "Organization and team records live in PostgreSQL, relationship permissions live in OpenFGA, and OPA evaluates contextual rules. Google authenticates the person; it does not decide ZeroSheet workbook roles.",
  },
  {
    question: "How does encrypted sharing work?",
    answer:
      "A share coordinates the product role, Google Drive permission, and an HPKE envelope containing the workbook key for that exact recipient. Recipients never receive the creator's recovery phrase.",
  },
  {
    question: "Is ZeroSheet open source?",
    answer:
      "Yes. The application, authorization model, policy, cryptographic formats, and infrastructure are available for review and self-hosting.",
  },
];

/** FAQ markup preserves ZeroDrive's flat bordered rows and schema metadata. */
export function Faq(): React.JSX.Element {
  return (
    <section
      id="faq"
      className="text-center"
      itemScope
      itemType="https://schema.org/FAQPage"
    >
      <h2 className="mb-5 text-center text-2xl">Frequently asked</h2>
      <div className="mx-auto border text-left md:w-[85%]">
        {FAQS.map((item) => (
          <div
            key={item.question}
            className="border-b px-4 py-4 last:border-b-0"
            itemScope
            itemProp="mainEntity"
            itemType="https://schema.org/Question"
          >
            <div className="flex gap-2.5 text-[0.92rem] font-medium">
              <span className="text-[hsl(var(--link))]">+</span>
              <span itemProp="name">{item.question}</span>
            </div>
            <div
              itemScope
              itemProp="acceptedAnswer"
              itemType="https://schema.org/Answer"
            >
              <p
                className="mt-2 pl-[22px] text-sm font-light leading-relaxed"
                itemProp="text"
              >
                {item.answer}
              </p>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
