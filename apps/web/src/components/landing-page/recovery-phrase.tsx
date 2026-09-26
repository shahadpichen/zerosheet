import type { ReactNode } from "react";

// This valid-looking sample exists only to explain ordering and is never used
// as a real account secret. New identities generate fresh browser entropy.
const EXAMPLE_PHRASE = [
  "witch",
  "collapse",
  "practice",
  "feed",
  "shame",
  "open",
  "despair",
  "creek",
  "road",
  "again",
  "ice",
  "least",
] as const;

const RECOVERY_FACTS: readonly ReactNode[] = [
  <>
    Generated on your device as a checksummed <strong>BIP39</strong> phrase.
  </>,
  <>
    It opens your <strong>encrypted HPKE private-key backup</strong>; it does
    not directly encrypt every workbook or cell.
  </>,
  <>
    Your private key opens your <strong>per-workbook key envelopes</strong>, and
    each random workbook key protects selected cells with AES-256-GCM.
  </>,
  <>
    <strong>Order matters.</strong> A missing, changed, or reordered word cannot
    reproduce the same recovery secret.
  </>,
  <>
    The phrase stays in browser memory only while unlocked and is{" "}
    <strong>never sent to ZeroSheet or Google</strong>. Save it offline.
  </>,
];

/** Reproduces ZeroDrive's numbered phrase panel with ZeroSheet's key hierarchy. */
export function RecoveryPhrase(): React.JSX.Element {
  return (
    <div id="recovery" className="mx-auto mt-10 border text-left md:w-[85%]">
      <div className="flex items-center justify-between border-b px-4 py-3 text-sm">
        <span className="font-medium">Your 12-word recovery phrase</span>
        <span className="text-xs text-muted-foreground">BIP39 standard</span>
      </div>

      <div className="grid grid-cols-2 gap-px bg-border sm:grid-cols-4">
        {EXAMPLE_PHRASE.map((word, index) => (
          <div
            key={word}
            className="flex items-baseline gap-2 bg-background px-4 py-3"
          >
            <span className="w-5 text-xs text-muted-foreground">
              {String(index + 1).padStart(2, "0")}
            </span>
            <span className="text-[0.95rem]">{word}</span>
          </div>
        ))}
      </div>

      <div className="border-t px-4 py-4">
        <ul className="space-y-2">
          {RECOVERY_FACTS.map((fact, index) => (
            <li
              // The explanation order is stable and has no separate identity.
              key={index}
              className="relative pl-6 text-sm font-light leading-relaxed"
            >
              <span className="absolute left-0 text-[hsl(var(--link))]">→</span>
              {fact}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
