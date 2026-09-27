/**
 * Google storage errors expose recovery categories, never provider response
 * bodies, OAuth codes, state values, tokens, or database details.
 */
export class GoogleStorageNotConfiguredError extends Error {
  public constructor() {
    super("Google Drive storage is not configured for this deployment.");
    this.name = "GoogleStorageNotConfiguredError";
  }
}

export class GoogleStorageConnectionRequiredError extends Error {
  public constructor() {
    super("Connect Google Drive before using workbook storage.");
    this.name = "GoogleStorageConnectionRequiredError";
  }
}

export class GoogleStorageOAuthFlowError extends Error {
  public constructor() {
    super("Google Drive authorization could not be completed. Start again.");
    this.name = "GoogleStorageOAuthFlowError";
  }
}

export class GoogleStorageDependencyError extends Error {
  public constructor() {
    super("Google authorization is temporarily unavailable.");
    this.name = "GoogleStorageDependencyError";
  }
}

/** A safe recovery category for combined login; no provider details escape. */
export class GoogleStorageOnboardingError extends Error {
  public constructor() {
    super(
      "Google Drive setup could not finish. Try again and allow the requested permissions.",
    );
    this.name = "GoogleStorageOnboardingError";
  }
}
