# `@zerosheet/sdk`

Typed client-side collection CRUD over the same `zs1` encrypted Google Sheet
format used by the ZeroSheet editor.

## Data layout

One configured collection maps to one existing Google tab:

```text
_id (always public) | name (protected) | status (explicitly public) | spend (protected)
cus_123             | zs1:...          | active                     | zs1:...
```

Headers, stable record IDs, tab dimensions, explicitly public fields,
ciphertext lengths, and update timing remain visible to Google. Every other
field is protected by default and authenticated to its workbook, tab, row,
column, and workbook-key version.

## API

```ts
const customers = database.collection<Customer>("customers");

await customers.insert({ name: "Acme", email: "owner@acme.test" });
await customers.get("cus_123");
await customers.update("cus_123", { name: "Acme Ltd" });
await customers.delete("cus_123");
await customers.all();
await customers.filter((customer) => customer.name.includes("Acme"), {
  offset: 0,
  limit: 25,
});
```

See the [five-minute quickstart](../../docs/quickstart/typescript-sdk.md) for
construction and browser key integration.

## Important behavior

- The caller supplies an already recovered, non-extractable AES-GCM
  `CryptoKey`. The SDK never receives raw workbook-key bytes.
- Reads decrypt a configured bounded scan locally. Predicates are JavaScript
  functions and are never sent to Google.
- Mutations compare the observed Drive file version immediately before writing.
  Google still has no atomic values compare-and-swap, so a narrow race remains.
- Deletes clear a row instead of shifting later rows because ciphertext AAD is
  bound to row coordinates. Inserts reuse the first empty row.
- A plaintext value appearing in a configured protected column is rejected as
  corruption/downgrade rather than silently accepted.
- A public string beginning with `=` is rejected because Google FORMULA reads
  cannot distinguish it from a formula after a RAW write.
- Changing field order, field protection, tab identity, or headers is a data
  migration. The SDK fails closed on mismatched schemas.
- `get(id)` is a bounded local scan in version 1. This package does not pretend
  Google Sheets is an indexed transactional database.

## Safe error handling

Catch `EncryptedSheetDatabaseError` and branch on its stable `code`. Do not log
the error's `cause`: provider/crypto causes may contain sensitive metadata or
encrypted cell values.
