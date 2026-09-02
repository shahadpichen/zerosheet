# Milestone 9: Workload mTLS and Zero Trust enforcement

## Learning objective

Use the API and worker identities issued in Milestone 8 to protect an actual
network connection. Both processes now prove their identities with short-lived
X.509-SVIDs, validate the other side against SPIRE's trust bundle, and enforce
an exact SPIFFE-ID allowlist before accepting work.

The main lesson is that these are separate checks:

1. **encryption** prevents an observer from reading or modifying traffic;
2. **certificate-chain authentication** proves SPIRE issued the peer SVID; and
3. **identity authorization** decides whether that exact workload may perform
   this operation.

A valid certificate is not automatically an authorization grant.

The implementation follows these primary references:

- [SPIFFE Workload API](https://spiffe.io/docs/latest/spiffe-specs/spiffe_workload_api/)
- [SPIFFE X.509-SVID specification](https://spiffe.io/docs/latest/spiffe-specs/x509-svid/)
- [SPIFFE mTLS tutorial](https://spiffe.io/docs/latest/microservices/envoy-x509/readme/)
- [Node TLS documentation](https://nodejs.org/api/tls.html)

## What runs in this milestone

```text
SPIRE server
  -> authorizes selector registrations and signs short-lived SVIDs

SPIRE agent on the Docker node
  -> attests container label org.zerosheet.workload=api
  -> streams API X.509-SVID + key + bundle over a local Unix socket
  -> attests container label org.zerosheet.workload=worker
  -> streams worker X.509-SVID + key + bundle over a local Unix socket

worker process                                      API internal listener
  spiffe://.../workload/worker                      spiffe://.../workload/api
  |                                                  |
  |-- TLS 1.3 ClientHello -------------------------->|
  |<-- API certificate + request client cert --------|
  |-- worker certificate --------------------------->|
  |                                                  |
  |  client: verify SPIRE chain + exact API ID       |
  |  server: verify SPIRE chain + exact worker ID    |
  |                                                  |
  |-- POST /internal/reconciliation-tick ---------->|
  |<-- HTTP 200 -------------------------------------|
```

The browser-facing Fastify server remains a separate process and port. A human
OIDC session cannot substitute for a workload SVID, and a workload SVID cannot
sign in a human.

## Why it is mutual TLS

Ordinary HTTPS normally authenticates only the server. The client verifies the
website certificate, while the website identifies the user later with a
password, session cookie, or token.

This internal channel has no user and no browser cookie. The API sets both:

```text
requestCert = true
rejectUnauthorized = true
```

Therefore the worker must send a client certificate chaining to the configured
SPIRE bundle during the TLS handshake. At the same time, the worker validates
the API certificate. Both peers authenticate each other: **mutual TLS**, or
**mTLS**.

No static API key, shared password, or long-lived certificate is added to the
environment. The Workload API provides current material only after locally
attesting the calling process.

## Why chain validation is not enough

SPIRE's trust-domain bundle answers:

> Was this certificate issued under `zerosheet.internal`?

It does not answer:

> Is this the worker that may trigger reconciliation?

The API and worker are both legitimate members of the same trust domain. If the
API merely accepted any bundle-valid client, a compromised API replica could
call worker-only operations. ZeroSheet therefore performs an exact equality
check:

```text
required client = spiffe://zerosheet.internal/workload/worker
actual client   = spiffe://zerosheet.internal/workload/api
decision        = deny with HTTP 403
```

There is deliberately no prefix rule such as “allow every ID below
`/workload/`.” The peer certificate must contain exactly one URI SAN and it must
equal the configured identity.

## Server identity without a DNS SAN

Website certificates usually contain a DNS SAN such as `api.example.com`.
X.509-SVIDs instead contain a URI SAN:

```text
URI:spiffe://zerosheet.internal/workload/api
```

Node still performs normal CA chain and validity verification. ZeroSheet
replaces only the DNS hostname callback with an exact SPIFFE URI-SAN check. The
worker therefore rejects a correctly signed worker certificate, another API
identity, or a typo in the configured expected API ID before sending HTTP.

## The `@zerosheet/workload-identity` boundary

The new shared package is the only ZeroSheet package that directly imports the
pinned `spiffe@0.5.1` Node adapter. That dependency is an MIT-licensed
third-party adapter, not the SPIFFE project itself or an identity server. It
uses the standardized gRPC Workload API and automatically supplies the
protocol-required workload metadata.

Keeping it behind our package gives API and worker code a narrow interface and
a review point if the adapter changes. Before publishing an update to the TLS
layer, the package validates:

1. configuration is a syntactically valid SPIFFE ID;
2. exactly one returned SVID matches the expected workload;
3. the leaf has exactly one URI SAN equal to that ID;
4. the chain and trust bundle are non-empty;
5. the PKCS#8 private key matches the leaf certificate's public key; and
6. the certificate has a valid start and end time.

The private key is converted to TLS-ready PEM only in process memory. Code must
never log the whole credential object, serialize it, place it in an environment
variable, send it in process arguments, save it to PostgreSQL, or write it to a
file.

## Rotation behavior

`FetchX509SVID` is a server-streaming call, not a one-time download. SPIRE sends
another response as SVIDs or bundles change.

The shared source:

- waits for one validated credential before declaring the process ready;
- keeps only the latest update in memory;
- notifies the HTTPS server to call `setSecureContext` on rotation;
- gives each new worker connection the current credential;
- reconnects after a stream interruption; and
- refuses to return a not-yet-valid or nearly expired credential.

Existing TLS connections may finish using the context with which they started.
New handshakes use the updated context. If SPIRE stays unavailable beyond the
five-minute SVID lifetime, clients reject the expired server certificate and
the worker source refuses to initiate a new request. Availability is lost
rather than silently falling back to an unauthenticated channel.

Unit tests inject a controlled asynchronous stream to prove initial failure,
rotation delivery, and expiry behavior. The live verifier exercises real DER
certificates and the real SPIRE socket.

## The internal reconciliation endpoint

The milestone adds one bounded teaching endpoint:

```text
POST /internal/reconciliation-tick
```

It currently returns a small acknowledgement. It does not yet process the
relationship outbox or accept caller-controlled job content. This keeps the
milestone focused on the transport and identity boundary. A production worker
will call a concrete idempotent job service or consume a protected queue, while
preserving the same workload authentication and authorization checks.

This server is separate from the public API because they have different
principals and policies:

| Listener                | Principal type | Authentication      | Reachability         |
| ----------------------- | -------------- | ------------------- | -------------------- |
| Browser-facing Fastify  | Human          | OIDC-backed session | Public reverse proxy |
| Internal reconciliation | Workload       | SPIFFE X.509 mTLS   | Private network only |

## Container boundaries

The workload image uses the exact Node 24.20.0 patch and pnpm 10.27.0. The
frozen lockfile is installed in a build stage, TypeScript is compiled there,
and the runtime process runs as the unprivileged `node` user.

Compose additionally applies:

- read-only root filesystems;
- a small temporary filesystem only where needed;
- all Linux capabilities dropped;
- `no-new-privileges`;
- memory limits and bounded logs; and
- no host port mapping for TCP 3443.

The API and credential-bearing probes mount only the agent's workload socket.
They do not receive the SPIRE server management socket, signing datastore, or a
static certificate volume. The missing-client-certificate probe receives only
the public CA bundle, which is sufficient to trust the server but cannot prove
a client identity.

The Docker label attestor remains a learning-lab compromise. Control over the
Docker daemon can create a correctly labelled container and therefore controls
workload identity on this node. Production must tightly restrict deployment
authority and use platform-appropriate stronger attestation.

## What “Zero Trust” means here

Zero Trust is not a library or a promise that the private Docker network is
safe. In this narrow boundary it means:

- network location alone grants nothing;
- each new TLS connection presents cryptographic identity;
- both sides validate the issuing trust root;
- both sides check the exact identity expected for their role; and
- failure has no plaintext or shared-secret fallback.

mTLS protects service traffic. It does not decrypt workbook cells, distribute
workbook keys, decide human workbook access, or replace OpenFGA/OPA. Those are
separate layers.

## Live verification matrix

`pnpm infra:workload-mtls:verify` provisions registrations, builds the pinned
image, starts the private API, and runs these cases:

| Client evidence               | Server expected by client | Result                                         |
| ----------------------------- | ------------------------- | ---------------------------------------------- |
| Valid worker SVID             | Exact API ID              | TLS 1.3 succeeds; endpoint returns 200         |
| Valid API SVID                | Exact API ID              | TLS succeeds; caller authorization returns 403 |
| Valid worker SVID             | Deliberately wrong ID     | Client rejects server before HTTP              |
| Public bundle, no client SVID | Exact API ID              | Server rejects mutual-TLS handshake            |
| Plain HTTP                    | None                      | Private TLS port resets/rejects connection     |

The verifier also confirms TCP 3443 has no host binding and scans captured
output/server logs for private-key markers.

## Commands

```bash
pnpm infra:workload-mtls:config
pnpm infra:workload-mtls:verify
pnpm infra:workload-mtls:logs
pnpm infra:workload-mtls:down
```

The verifier intentionally leaves the mTLS API running so its rotation and
logs can be inspected. `down` stops that application listener; the separate
Milestone 8 command stops the SPIRE control plane.

## Security invariants

1. The internal API starts only after receiving a valid SVID for its exact ID.
2. TLS 1.3 encrypts the internal connection and both peers present SVIDs.
3. Certificate-chain trust and exact peer authorization are separate checks.
4. Another valid identity in the same trust domain is denied by default.
5. An X.509-SVID must contain exactly one expected URI SAN.
6. Client and server consume streamed rotation updates without writing keys.
7. Expiry or Workload API failure never falls back to HTTP or a static secret.
8. The internal listener has no host port and is not the browser-facing API.
9. Logs contain public workload IDs and expiry times, never private key bytes.
10. Workload identity does not grant human, workbook, or decryption authority.

## Deliberately deferred

- Calling the real relationship-outbox reconciler through this boundary.
- Replacing OpenFGA's learning-lab pre-shared key and OPA's loopback HTTP path
  with workload-authenticated private endpoints.
- Production process/node attestation and deployment admission controls.
- SPIRE high availability, external signing-key protection, and CA rotation
  disaster drills.
- Using an internal job queue and defining retry/dead-letter semantics.
- Workload identity in audit actors and OPA input where a policy needs it.
