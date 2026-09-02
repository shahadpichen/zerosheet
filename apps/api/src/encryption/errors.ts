/**
 * Invalid encryption material is different from an authorization denial or a
 * transient dependency failure. The HTTP layer maps it to one generic 400 and
 * deliberately omits the failed key/envelope detail.
 */
export class WorkbookSecurityInputError extends Error {
  public constructor() {
    super("The encryption key or envelope is invalid.");
    this.name = "WorkbookSecurityInputError";
  }
}

/** A signed-in user must create/recover an encryption identity before use. */
export class EncryptionIdentityRequiredError extends Error {
  public constructor() {
    super("Set up your encryption recovery identity before continuing.");
    this.name = "EncryptionIdentityRequiredError";
  }
}

/** Authorization can succeed while the independent key envelope is absent. */
export class WorkbookEnvelopeUnavailableError extends Error {
  public constructor() {
    super("No usable workbook-key envelope is available for this user.");
    this.name = "WorkbookEnvelopeUnavailableError";
  }
}
