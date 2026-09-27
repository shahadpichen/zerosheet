import { normalizeAndValidateRecoveryPhrase } from "@zerosheet/crypto";
import { hasEncryptionIdentity } from "./workspace-client.js";
import {
  createAndRegisterEncryptionIdentity,
  recoverEncryptionIdentity,
} from "./secure-workbook.js";

/** Recheck the authoritative identity before writing. Another tab may have
 * finished setup, or our previous POST may have succeeded despite a lost
 * response. In either case, open the existing backup; never replace its key.
 * Verifying the saved backup also proves recovery works before leaving setup. */
export async function saveRecoverySetup(phrase: string): Promise<string> {
  const normalized = normalizeAndValidateRecoveryPhrase(phrase);
  if (!(await hasEncryptionIdentity())) {
    await createAndRegisterEncryptionIdentity({
      recoveryPhrase: normalized,
      keyVersion: 1,
    });
  }
  await recoverEncryptionIdentity(normalized);
  return normalized;
}
