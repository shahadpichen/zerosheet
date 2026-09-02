/**
 * Keep all direct dependency on the Node SPIFFE adapter behind this package.
 * API and worker code import these reviewed ZeroSheet concepts rather than
 * depending on generated gRPC messages throughout the application.
 */
export {
  assertValidSpiffeId,
  authorizeExactPeerSpiffeId,
  createSpiffeCheckServerIdentity,
  extractUriSubjectAlternativeNames,
} from "./peer-authorization.js";
export {
  decodeX509Update,
  SpiffeX509Source,
  type SpiffeX509SourceOptions,
  type WorkloadX509Credentials,
  type X509Update,
  type X509UpdateDecoder,
  type X509UpdateStreamFactory,
} from "./x509-source.js";
