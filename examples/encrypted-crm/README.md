# Encrypted CRM React example

This example renders decrypted customer records beside the exact raw values in
the backing Google Sheet. It performs CRUD only through `@zerosheet/sdk`.

The host application must first authenticate the user, obtain the independent
Google storage grant, recover the workbook envelope in the browser, and pass
the resulting non-extractable `CryptoKey` to `EncryptedCrm`. See the
[five-minute TypeScript quickstart](../../docs/quickstart/typescript-sdk.md) for
the complete composition.

The example intentionally makes `status` public. `_id`, headers, row count, and
ciphertext length are also visible. Name, email, and spend are protected.
