# Five-minute TypeScript SDK quickstart

This quickstart starts after local ZeroSheet authentication, Google storage
consent, and an encrypted workbook have been created. Those are separate
security ceremonies; hiding them inside an SDK constructor would encourage
applications to persist a recovery phrase or OAuth credential.

## 1. Add the workspace SDK

From this monorepo:

```bash
pnpm --filter your-client add @zerosheet/sdk@workspace:*
```

The package is intentionally not published during the alpha. A public package
requires an explicit ZeroSheet license/release decision; Univer's Apache-2.0
license does not automatically license ZeroSheet's own code.

## 2. Recover access in the browser

The existing browser coordinator performs the exact key sequence:

```ts
import { recoverWorkbookEncryptionAccess } from "../../apps/web/src/secure-workbook.js";
import { googleWorkspaceStorage } from "../../apps/web/src/google-storage.js";

const access = await recoverWorkbookEncryptionAccess({
  workbookId,
  recoveryPhrase,
});
```

`recoveryPhrase` comes from a transient user input. The coordinator fetches the
acting user's phrase-encrypted historical private-key backup, opens it locally,
opens the exact HPKE workbook envelope, imports the 32-byte result as a
non-extractable AES-GCM `CryptoKey`, and clears temporary byte arrays. Do not put
the phrase in localStorage, sessionStorage, a URL, analytics, or a backend API.

If `access.pending` is non-null, a key rotation is staged. Finish/resume that
rotation before creating an SDK instance for new writes.

## 3. Define one tab as a collection

```ts
import {
  EncryptedSheetDatabase,
  type EncryptedSheetRecord,
} from "@zerosheet/sdk";

interface Customer extends EncryptedSheetRecord {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly status: string;
  readonly spend: number;
}

const db = new EncryptedSheetDatabase({
  storage: googleWorkspaceStorage,
  spreadsheetId: access.spreadsheetId,
  workbookId,
  keyVersion: access.active.keyVersion,
  key: access.active.key,
  collections: {
    customers: {
      sheetId: access.sheetId,
      sheetTitle: access.sheetTitle,
      idPrefix: "cus_",
      maxRecords: 1_000,
      fields: [
        { name: "name" },
        { name: "email" },
        { name: "status", protection: "public" },
        { name: "spend" },
      ],
    },
  },
});

const customers = db.collection<Customer>("customers");
```

`name`, `email`, and `spend` are protected because protection defaults to
`protected`. `status` is deliberately visible to Google. `_id` and the header
names are always visible metadata.

## 4. Use CRUD and local queries

```ts
const acme = await customers.insert({
  name: "Acme Corp",
  email: "owner@acme.test",
  status: "lead",
  spend: 4_200,
});

await customers.get(acme.id);
await customers.update(acme.id, { status: "customer" });

const page = await customers.filter((customer) => customer.spend >= 1_000, {
  offset: 0,
  limit: 25,
});

await customers.delete(acme.id);
```

The filter runs only after browser decryption. Google sees the bounded range
read and ciphertext, not the predicate or protected values.

## 5. Handle safe error codes

```ts
import { EncryptedSheetDatabaseError } from "@zerosheet/sdk";

try {
  await customers.update("cus_123", { spend: 5_000 });
} catch (error) {
  if (error instanceof EncryptedSheetDatabaseError) {
    showRecoveryAction(error.code);
  }
}
```

Typical recovery actions are reload on `SDK_CONFLICT`, stop and inspect on
`SDK_CORRUPT_DATA`/`SDK_SCHEMA_MISMATCH`, and reconnect Google storage on
`SDK_STORAGE_UNAVAILABLE`. Never send `error.cause` to telemetry.

## Examples

- [`examples/encrypted-crm`](../../examples/encrypted-crm/README.md) is a React
  view that shows application plaintext beside actual backing Sheet values.
- [`examples/mvp-backend`](../../examples/mvp-backend/README.md) is a repository
  layer written only against the SDK.

A hosted backend that receives the workbook key becomes a trusted plaintext
endpoint. For the normal ZeroSheet E2EE boundary, keep this code in the user's
authorized client or a local-first process they control.
