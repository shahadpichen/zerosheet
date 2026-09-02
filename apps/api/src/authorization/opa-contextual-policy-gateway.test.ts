import { describe, expect, it } from "vitest";
import type { ContextualAuthorizationConfig } from "../config.js";
import { OpaContextualPolicyGateway } from "./opa-contextual-policy-gateway.js";
import type { ContextualPolicyInput } from "./types.js";

const config: ContextualAuthorizationConfig = {
  apiUrl: new URL("http://127.0.0.1:8181"),
  allowInsecureHttp: true,
  requestTimeoutMs: 5_000,
};

const input: ContextualPolicyInput = {
  subject: { id: "user-1", status: "active" },
  organization: { id: "organization-1", status: "active" },
  resource: { type: "workbook", id: "workbook-1" },
  action: "can_view",
  relationship: { required: true, allowed: true },
};

function urlText(input: URL | RequestInfo): string {
  if (typeof input === "string") {
    return input;
  }

  return input instanceof URL ? input.href : input.url;
}

describe("OpaContextualPolicyGateway", () => {
  it("posts the decision input and requires an explicit boolean true", async () => {
    let requestedUrl = "";
    let requestedInit: RequestInit | undefined;
    const fetcher = (url: URL | RequestInfo, init?: RequestInit) => {
      requestedUrl = urlText(url);
      requestedInit = init;
      return Promise.resolve(
        new Response(JSON.stringify({ result: true }), { status: 200 }),
      );
    };
    const gateway = new OpaContextualPolicyGateway(config, fetcher);

    await expect(gateway.evaluate(input)).resolves.toBe(true);
    expect(requestedUrl).toBe(
      "http://127.0.0.1:8181/v1/data/zerosheet/authz/allow",
    );
    expect(requestedInit?.method).toBe("POST");
    if (typeof requestedInit?.body !== "string") {
      throw new Error("OPA request body was not serialized JSON.");
    }
    expect(JSON.parse(requestedInit.body)).toEqual({ input });
  });

  it.each([
    ["false", JSON.stringify({ result: false })],
    ["missing", JSON.stringify({})],
    ["wrong type", JSON.stringify({ result: "true" })],
    ["invalid JSON", "not-json"],
  ])("fails closed for a %s decision", async (_name, body) => {
    const gateway = new OpaContextualPolicyGateway(config, () =>
      Promise.resolve(new Response(body, { status: 200 })),
    );

    await expect(gateway.evaluate(input)).resolves.toBe(false);
  });

  it("surfaces a failed OPA HTTP response as dependency failure", async () => {
    const gateway = new OpaContextualPolicyGateway(config, () =>
      Promise.resolve(new Response("unavailable", { status: 503 })),
    );

    await expect(gateway.evaluate(input)).rejects.toThrow(/HTTP 503/u);
  });

  it("checks server readiness and the exact mounted policy path", async () => {
    const urls: string[] = [];
    const fetcher = (url: URL | RequestInfo) => {
      urls.push(urlText(url));
      return Promise.resolve(
        urls.length === 1
          ? new Response("{}", { status: 200 })
          : new Response(JSON.stringify({ result: true }), { status: 200 }),
      );
    };
    const gateway = new OpaContextualPolicyGateway(config, fetcher);

    await expect(gateway.assertReady()).resolves.toBeUndefined();
    expect(urls).toEqual([
      "http://127.0.0.1:8181/health",
      "http://127.0.0.1:8181/v1/data/zerosheet/authz/allow",
    ]);
  });
});
