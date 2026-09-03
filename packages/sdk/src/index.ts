/**
 * The SDK is client-side and headless: applications supply a recovered
 * non-extractable workbook key and an authorized storage adapter. It never
 * handles recovery phrases, OAuth refresh tokens, OpenFGA credentials, or
 * server-side decryption secrets.
 */
export { EncryptedCollection } from "./collection.js";
export { EncryptedSheetDatabase } from "./database.js";
export {
  EncryptedSheetDatabaseError,
  type EncryptedSheetDatabaseErrorCode,
} from "./errors.js";
export type {
  CollectionDefinition,
  CollectionFieldDefinition,
  CollectionPage,
  EncryptedSheetDatabaseOptions,
  EncryptedSheetDatabaseStorage,
  EncryptedSheetRecord,
  EncryptedSheetScalar,
  InsertOptions,
  PaginationOptions,
} from "./types.js";
