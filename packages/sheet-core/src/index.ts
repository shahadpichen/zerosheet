/**
 * The public surface contains no Univer, React, fetch, OAuth, or PostgreSQL
 * types. It can therefore be tested headlessly and reused by the future SDK.
 */
export {
  decodeGoogleRange,
  encodeGoogleRange,
  type DecodedSheetRange,
  type EditorCell,
  type EncodedSheetRange,
  type SheetCipherContext,
} from "./codec.js";
export { SheetCoreError, type SheetCoreErrorCode } from "./errors.js";
export { CellProtectionMap } from "./protection-map.js";
export {
  assertGridRange,
  coordinateLabel,
  googleA1Range,
  MAX_SYNC_CELLS,
  MAX_TRACKED_PROTECTED_CELLS,
  rangeCellCount,
  type GridCoordinate,
  type GridRange,
} from "./ranges.js";
export {
  EncryptedSheetSyncSession,
  type SavedSheetRange,
  type SheetStoragePort,
} from "./sync-session.js";
