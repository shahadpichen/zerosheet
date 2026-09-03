/**
 * The worker package now owns read-only sharing-drift inspection in addition to
 * the SPIFFE/mTLS probes. The literal is intentionally non-operational: merely
 * importing the package never starts a timer or opens a database connection.
 */
export const workerStatus = "security-audit-ready" as const;

export {
  PostgresSharingDriftRepository,
  type SharingDriftReport,
} from "./sharing-drift-repository.js";
