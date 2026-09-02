import { describe, expect, it } from "vitest";

import {
  assertValidSpiffeId,
  authorizeExactPeerSpiffeId,
  createSpiffeCheckServerIdentity,
  extractUriSubjectAlternativeNames,
} from "./peer-authorization.js";

describe("SPIFFE peer authorization", () => {
  it("extracts URI SANs without treating DNS SANs as workload identities", () => {
    expect(
      extractUriSubjectAlternativeNames(
        "DNS:api.internal, URI:spiffe://zerosheet.internal/workload/api",
      ),
    ).toEqual(["spiffe://zerosheet.internal/workload/api"]);
  });

  it("allows exactly the configured peer identity", () => {
    expect(
      authorizeExactPeerSpiffeId(
        {
          subjectaltname: "URI:spiffe://zerosheet.internal/workload/worker",
        },
        "spiffe://zerosheet.internal/workload/worker",
      ),
    ).toBe("spiffe://zerosheet.internal/workload/worker");
  });

  it("denies another valid identity from the same trust domain", () => {
    expect(() =>
      authorizeExactPeerSpiffeId(
        { subjectaltname: "URI:spiffe://zerosheet.internal/workload/api" },
        "spiffe://zerosheet.internal/workload/worker",
      ),
    ).toThrow("required SPIFFE identity");
  });

  it("denies ambiguous certificates containing more than one URI SAN", () => {
    expect(() =>
      authorizeExactPeerSpiffeId(
        {
          subjectaltname:
            "URI:spiffe://zerosheet.internal/workload/worker, URI:spiffe://zerosheet.internal/workload/api",
        },
        "spiffe://zerosheet.internal/workload/worker",
      ),
    ).toThrow("required SPIFFE identity");
  });

  it("rejects malformed configured identities before any connection", () => {
    expect(() => assertValidSpiffeId("https://zerosheet.internal/api")).toThrow(
      "valid SPIFFE ID",
    );
  });

  it("returns a generic TLS error instead of certificate details", () => {
    const checkServerIdentity = createSpiffeCheckServerIdentity(
      "spiffe://zerosheet.internal/workload/api",
    );
    const result = checkServerIdentity("mtls-api", {
      subjectaltname: "URI:spiffe://zerosheet.internal/workload/worker",
    } as never);

    expect(result?.message).toBe(
      "The TLS server has an unexpected SPIFFE identity.",
    );
  });
});
