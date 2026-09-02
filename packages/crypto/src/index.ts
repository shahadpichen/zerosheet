/**
 * The public package intentionally exports storage-independent operations only.
 * Browser UI, Google APIs, PostgreSQL, logging, and authorization belong in
 * other layers and must never be imported into this cryptographic core.
 */
export {
  CELL_GCM_TAG_BYTES,
  CELL_NONCE_BYTES,
  decryptCell,
  ENCRYPTED_CELL_FORMAT_VERSION,
  ENCRYPTED_CELL_PREFIX,
  encryptCell,
  inspectEncryptedCell,
  isEncryptedCell,
  MAX_SERIALIZED_CELL_BYTES,
  serializedCellValueLength,
  type CellEncryptionContext,
  type EncryptedCellHeader,
  type PlainCellValue,
} from "./cell.js";
export {
  ZeroSheetCryptoError,
  type ZeroSheetCryptoErrorCode,
} from "./errors.js";
export {
  createUserEncryptionIdentity,
  importUserPublicKey,
  openUserPrivateKeyBackup,
  openWorkbookKeyEnvelope,
  sealWorkbookKeyForRecipient,
  USER_HPKE_SUITE,
  USER_PUBLIC_KEY_FORMAT_VERSION,
  WORKBOOK_KEY_ENVELOPE_VERSION,
  type CreatedUserEncryptionIdentity,
  type UserPublicEncryptionKey,
  type WorkbookKeyEnvelope,
} from "./hpke.js";
export {
  generateRecoveryPhrase,
  normalizeAndValidateRecoveryPhrase,
  RecoveryPhraseMemory,
} from "./recovery.js";
export {
  assertWorkbookKey,
  generateWorkbookKeyBytes,
  importWorkbookKey,
  WORKBOOK_KEY_BYTES,
} from "./workbook-key.js";
