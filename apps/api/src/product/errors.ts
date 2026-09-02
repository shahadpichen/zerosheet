/**
 * Product errors carry deliberately small transport-safe categories. Routes do
 * not expose PostgreSQL constraints, OpenFGA errors, or whether an unrelated
 * tenant resource exists.
 */
export class ProductForbiddenError extends Error {
  public constructor() {
    super("You do not have permission to perform this action.");
    this.name = "ProductForbiddenError";
  }
}

export class ProductNotFoundError extends Error {
  public constructor() {
    super("The requested resource was not found.");
    this.name = "ProductNotFoundError";
  }
}

export class ProductConflictError extends Error {
  public constructor(message = "The resource is being changed. Try again.") {
    super(message);
    this.name = "ProductConflictError";
  }
}

export class ProductDependencyError extends Error {
  public constructor() {
    super("Authorization synchronization is temporarily unavailable.");
    this.name = "ProductDependencyError";
  }
}
