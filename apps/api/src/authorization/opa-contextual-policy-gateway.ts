import type { ContextualAuthorizationConfig } from "../config.js";
import type {
  ContextualPolicyGateway,
  ContextualPolicyInput,
} from "./types.js";

interface OpaDecisionResponse {
  result?: unknown;
}

/**
 * Using the platform fetch type keeps this adapter dependency-free while
 * retaining an injectable seam for deterministic tests. Node 24 provides both
 * `fetch` and `AbortSignal.timeout` without a separate HTTP client package.
 */
type FetchPort = typeof fetch;

function endpoint(baseUrl: URL, path: string): URL {
  const normalizedBase = baseUrl.href.endsWith("/")
    ? baseUrl
    : new URL(`${baseUrl.href}/`);
  return new URL(path, normalizedBase);
}

/**
 * This adapter speaks OPA's Data API. It never treats a truthy value as an
 * allow: the response must be successful JSON whose `result` is exactly true.
 * Network, timeout, and HTTP failures are surfaced to the product layer as a
 * dependency failure; missing or malformed decisions quietly deny.
 */
export class OpaContextualPolicyGateway implements ContextualPolicyGateway {
  public constructor(
    private readonly config: ContextualAuthorizationConfig,
    private readonly fetcher: FetchPort = globalThis.fetch,
  ) {}

  public async assertReady(): Promise<void> {
    const response = await this.fetcher(
      endpoint(this.config.apiUrl, "health"),
      {
        signal: AbortSignal.timeout(this.config.requestTimeoutMs),
      },
    );

    if (!response.ok) {
      throw new Error(`OPA readiness returned HTTP ${response.status}.`);
    }

    /**
     * OPA's built-in `/health` proves the process is operational, but not that
     * our package and rule were mounted. `/health/ready` is intentionally not
     * used because OPA reserves that convention for a separately authored
     * `data.system.health.ready` policy. A harmless synthetic platform decision
     * verifies our exact decision path before the API accepts traffic.
     */
    const policyLoaded = await this.evaluate({
      subject: { id: "readiness-probe", status: "active" },
      resource: { type: "platform", id: "zerosheet" },
      action: "create_organization",
      relationship: { required: false, allowed: false },
    });

    if (!policyLoaded) {
      throw new Error("OPA did not load the ZeroSheet contextual policy.");
    }
  }

  public async evaluate(input: ContextualPolicyInput): Promise<boolean> {
    const response = await this.fetcher(
      endpoint(this.config.apiUrl, "v1/data/zerosheet/authz/allow"),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input }),
        signal: AbortSignal.timeout(this.config.requestTimeoutMs),
      },
    );

    if (!response.ok) {
      throw new Error(`OPA decision returned HTTP ${response.status}.`);
    }

    let decision: OpaDecisionResponse;
    try {
      decision = (await response.json()) as OpaDecisionResponse;
    } catch {
      // A successful status with a non-JSON body is a broken PDP response, not
      // authorization. Returning false preserves the fail-closed contract.
      return false;
    }

    return decision.result === true;
  }
}

export function createOpaContextualPolicyGateway(
  config: ContextualAuthorizationConfig,
): OpaContextualPolicyGateway {
  return new OpaContextualPolicyGateway(config);
}
