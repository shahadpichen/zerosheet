# MVP backend-style repository example

`createCustomerRepository` shows application CRUD implemented only against
`@zerosheet/sdk`; the SDK then talks to the supplied Google Sheets adapter.

This is safe as a local-first or user-device module. If a conventional hosted
backend receives the workbook `CryptoKey`, that backend becomes a trusted
plaintext endpoint and the claim that ordinary hosted services cannot decrypt
protected data no longer applies. Do not hide this trust change behind the term
"backend."
