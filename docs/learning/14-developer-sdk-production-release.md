# Milestone 14: developer SDK, reconciliation, and single-node release

This milestone turns the encryption/storage primitives into something another
developer can actually use and turns the local IAM lab into an auditable VPS
deployment template. It does **not** declare ZeroSheet generally available or
highly available.

## What the SDK is—and is not

`@zerosheet/sdk` is a browser/headless TypeScript record layer over one Google
spreadsheet. It is not an identity provider, policy engine, database server, or
new encryption algorithm. Authentication, OpenFGA/OPA authorization, Google
consent, recovery, and workbook-key envelopes happen before the SDK receives:

- the reviewed Google storage adapter;
- workbook and spreadsheet IDs;
- stable numeric tab ID and title;
- current workbook-key version; and
- a recovered, non-extractable AES-GCM `CryptoKey`.

One collection maps to one fixed tab:

```text
Google row 0:  _id          name          email          status
Google row 1:  cus_ab12     zs1:...       zs1:...        lead
SDK record:    cus_ab12     Maya          m@example      lead
protection:    public       protected     protected      explicit public
```

The `_id` and headers are public metadata. Fields default to protected. A
caller must write `protection: "public"` to expose a field intentionally.
Protected cells use the same `zs1` AES-GCM/AAD format as the Univer editor.

## Record operations and honest limits

- `insert(record, { id? })` creates or accepts a stable public ID.
- `get(id)` returns one decrypted record or `null`.
- `update(id, patch)` preserves ID/coordinates and rewrites one row.
- `delete(id)` clears a row; shifting rows would invalidate coordinate-bound
  authentication data.
- `all()`, `filter(predicate)`, and `page()` operate locally after bounded
  reads/decryption.
- `exportPlaintext()` makes the confidentiality transition explicit in code.

The cap is 10,000 records and 99 fields. There is no remote protected-field
index, join, transaction, arbitrary query language, or atomic Google
compare-and-swap. `get(id)` currently scans the bounded collection. A Drive
version check catches many concurrent edits, but a narrow check/write race
remains. These are product constraints, not details to hide behind a database-
looking API.

Start with the [five-minute quickstart](../quickstart/typescript-sdk.md), then
compare [the encrypted CRM](../../examples/encrypted-crm/README.md) with its raw
Google rows. The [backend example](../../examples/mvp-backend/README.md) is
architecturally valid but explains why giving a hosted backend the workbook key
changes the end-to-end trust claim.

The SDK remains a private workspace package until ZeroSheet's own source and
commercial licensing decision is explicit. Univer's Apache-2.0 license permits
its use; it does not automatically choose a license for ZeroSheet code.

## Why reconciliation has two parts

Database drift and Google-only drift have different visibility:

1. PostgreSQL can detect an active share missing an envelope/permission,
   leftover material without an active share, a stale pending rotation, or a
   committed revocation whose product share is still active.
2. A browser crash immediately after `permissions.create` leaves no ZeroSheet
   record. Only Google knows that permission exists.

Migration 007 creates `inspect_sharing_drift(stale_before)`, a `SECURITY
DEFINER` function returning four counts. The production auditor can execute
that one function but cannot select tables. The one-shot worker logs only
aggregate counts and exits `2` when remediation is required.

For provider state, an authorized workbook manager requests the exact expected
permission IDs, then the owner's browser lists Drive permissions and compares
them locally. Unknown permissions are shown as “unmanaged,” never deleted
automatically: a collaborator added intentionally in Google may be legitimate.
The provider list is not uploaded to ZeroSheet. Missing expected grants should
be recreated through the secure sharing flow; unknown grants require the owner
to decide whether to retain or remove them in Drive.

## Single-node trust and traffic layout

```text
Internet
  |
  | 80/443 only
  v
Caddy ---------------------------------------------------+
  | app.example /api -> Fastify :3001                    |
  | identity.example -> Keycloak :8080                   |
  +-------------------------------------------------------+
                           private Docker networks
       +---------------- shared network namespace ----------------+
       | API :3001   OpenFGA 127.0.0.1:8080   OPA 127.0.0.1:8181 |
       +----------------------------------------------------------+
                            |
                   PostgreSQL private network
            zerosheet | keycloak | openfga databases
```

Same-origin `/api` routing is essential: `__Host-` session cookies are Secure,
host-only, and Path `/`. Caddy strips `/api` before Fastify while public OIDC,
SCIM, and Google callback URLs preserve it. Keycloak uses a separate public
hostname because it is the issuer and interactive login server.

OpenFGA and OPA use loopback HTTP only because they share the API's network
namespace on this one host. Moving either service elsewhere without TLS is a
security regression. The SPIFFE/mTLS milestone remains the model for separated
workloads.

## Preparing a new VPS

Use a supported 64-bit Linux distribution, create a non-root deployment user,
install Docker Engine with Compose, and allow inbound TCP 22 (restricted where
possible), 80, and 443 plus UDP 443. Do not publish PostgreSQL, Keycloak,
OpenFGA, OPA, or API ports. Point two DNS A/AAAA records at the VPS:

```text
sheets.example.com    -> VPS
identity.example.com  -> VPS
```

Clone the repository and create operator state outside it:

```bash
sudo install -d -m 0700 /etc/zerosheet
sudo infra/scripts/generate-production-secrets.sh /etc/zerosheet/secrets
sudo install -d -m 0700 -o 1000 -g 1000 /var/lib/zerosheet/state
sudo install -m 0600 infra/production/environment.example /etc/zerosheet/environment
```

Edit only domains, email, usernames, OAuth client IDs, and later OpenFGA IDs in
`/etc/zerosheet/environment`. Credential values stay in individual files. The
generator refuses to overwrite existing files, so rotation is always an
explicit service-aware operation.

The secret directory is root-owned mode `0700`, so another VPS user cannot even
traverse it. Its files are intentionally mode `0444`: Compose bind-mounts a file
without remapping root ownership, while ZeroSheet services use several distinct
non-root UIDs. Each process therefore gets read-only access only to the files
listed for its service. When replacing a Google sentinel, preserve mode `0444`
and never relax the parent directory.

## Bootstrap order

Define a shorthand for readability:

```bash
export ZS_COMPOSE='docker compose --env-file /etc/zerosheet/environment --file infra/production/compose.yaml'
```

Run the durable stores and private policy namespace first:

```bash
$ZS_COMPOSE up --detach --build postgres zerosheet-migrate keycloak policy-namespace openfga-migrate openfga opa caddy
$ZS_COMPOSE --profile bootstrap run --rm openfga-provision
sudo cat /var/lib/zerosheet/state/openfga.env
```

Copy the two **non-secret** IDs into `/etc/zerosheet/environment`, replacing the
documented placeholders. Then start/reconcile the complete stack:

```bash
$ZS_COMPOSE up --detach --build
$ZS_COMPOSE ps
curl --fail https://sheets.example.com/api/health
curl --fail https://identity.example.com/realms/zerosheet/.well-known/openid-configuration
```

The Keycloak master admin surface is blocked by Caddy. Use `kcadm.sh` through
an SSH session/container exec for deliberate administration rather than
publishing `/admin` to the internet.

## Google production setup

Create separate Google OAuth clients:

- Keycloak sign-in redirect:
  `https://identity.example.com/realms/zerosheet/broker/google/endpoint`
- ZeroSheet Drive/Sheets callback:
  `https://sheets.example.com/api/google/storage/callback`

Enable Drive and Sheets APIs only for the storage client, replace the two
sentinel secret files, set real client IDs, configure/enable the Keycloak Google
provider, then set `GOOGLE_STORAGE_OAUTH_ENABLED=true` only after its consent
screen and exact callback are verified. Restart affected services after secret
rotation. Google identity federation and delegated storage remain separate
consents with different scopes and secrets.

## Operations and recovery

Run the read-only drift job from a systemd timer or cron wrapper:

```bash
$ZS_COMPOSE --profile operations run --rm sharing-drift-audit
```

Exit `0` means no aggregate finding, `2` means review is required, and `1`
means the audit itself failed. Logs contain counts, not IDs/emails/envelopes.

Database volumes are persistence, not backups. Install `age`, keep its private
identity off the VPS, and create an encrypted backup:

```bash
sudo infra/scripts/backup-production-databases.sh \
  /etc/zerosheet/environment \
  /var/backups/zerosheet \
  age1example_public_recipient
```

Copy the timestamped directory off-site. On a separate trusted machine, prove
all three archives restore without touching a live volume:

```bash
infra/scripts/drill-production-restore.sh \
  /absolute/path/to/backup/timestamp \
  /absolute/path/to/age-identity.txt
```

Back up the secret directory separately in an encrypted secrets manager. Losing
database dumps loses accounts/metadata; losing internal secret files can also
make refresh tokens or service databases unavailable. Neither location ever
contains a user's 12-word recovery phrase or decrypted workbook key.

## Release verification

With the local IAM database running:

```bash
pnpm infra:release:verify
```

The command checks Node/pnpm versions, formatting, lint, all tests and policy
vectors, all builds/examples, real sharing SQL, aggregate drift, all production
Compose profiles, plain-Node deploy artifacts, web bundle budgets, and patch
whitespace. It also builds every Linux image, asserts non-root runtime users,
proves mounted-secret access, and validates Caddy with its production capability
set. CI can add image signing/SBOM publishing when a registry is selected.

## What remains before a serious production claim

- independent security review and penetration testing;
- monitored off-site backup schedule with repeated restore evidence;
- alert routing, incident response, retention policy, and privacy terms;
- dependency/SBOM/container scanning and signed registry releases;
- high-availability PostgreSQL/Keycloak and a multi-node SPIFFE topology;
- browser release integrity controls and a reviewed extension/offline strategy;
- load tests based on real traffic and a move beyond 2 GB before an SLA.

This milestone makes limits executable and visible. It does not erase them.
