import type { PeerCertificate } from "node:tls";

/**
 * SPIFFE places a workload's identity in an X.509 URI Subject Alternative
 * Name (SAN). The URI is public identity data, not a secret. We parse only URI
 * SANs because DNS names, certificate subjects, and caller-supplied headers are
 * not workload identities and must not influence this authorization decision.
 */
export function extractUriSubjectAlternativeNames(
  subjectAlternativeName: string | undefined,
): string[] {
  if (subjectAlternativeName === undefined || subjectAlternativeName === "") {
    return [];
  }

  return subjectAlternativeName
    .split(/,\s*/u)
    .filter((entry) => entry.startsWith("URI:"))
    .map((entry) => entry.slice("URI:".length));
}

/**
 * Validate configuration before comparing it with a certificate. Treating an
 * arbitrary string as a SPIFFE ID would make a typo look like a runtime trust
 * failure and could accidentally broaden future matching logic.
 */
export function assertValidSpiffeId(spiffeId: string): void {
  let parsed: URL;

  try {
    parsed = new URL(spiffeId);
  } catch {
    throw new Error("The configured workload identity is not a valid URI.");
  }

  if (
    parsed.protocol !== "spiffe:" ||
    parsed.hostname === "" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.port !== "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error(
      "The configured workload identity is not a valid SPIFFE ID.",
    );
  }
}

/**
 * Authorize one already chain-validated TLS peer. An X.509-SVID is required to
 * contain exactly one URI SAN, and that URI must equal the allowlisted SPIFFE
 * ID. We intentionally do not accept prefixes such as `/workload/` because a
 * valid API identity is still not authorized to act as the worker.
 */
export function authorizeExactPeerSpiffeId(
  certificate: Pick<PeerCertificate, "subjectaltname">,
  expectedSpiffeId: string,
): string {
  assertValidSpiffeId(expectedSpiffeId);

  const uriNames = extractUriSubjectAlternativeNames(
    certificate.subjectaltname,
  );

  if (uriNames.length !== 1 || uriNames[0] !== expectedSpiffeId) {
    throw new Error("The TLS peer does not have the required SPIFFE identity.");
  }

  return expectedSpiffeId;
}

/**
 * Node performs certificate-chain verification before invoking this callback.
 * Replacing normal DNS hostname checking is necessary because an X.509-SVID is
 * identified by a URI SAN rather than a DNS SAN. Returning an Error aborts the
 * TLS handshake before any HTTP request bytes are sent.
 */
export function createSpiffeCheckServerIdentity(
  expectedServerSpiffeId: string,
): (_hostname: string, certificate: PeerCertificate) => Error | undefined {
  assertValidSpiffeId(expectedServerSpiffeId);

  return (_hostname, certificate) => {
    try {
      authorizeExactPeerSpiffeId(certificate, expectedServerSpiffeId);
      return undefined;
    } catch {
      // Do not include certificate details in the error. The caller only needs
      // to know that the pinned workload identity did not match.
      return new Error("The TLS server has an unexpected SPIFFE identity.");
    }
  };
}
