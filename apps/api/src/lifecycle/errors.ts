/**
 * These categories map to SCIM's small error envelope without exposing SQL,
 * OpenFGA, token digests, or whether another connection owns a resource.
 */
export class LifecycleUnauthorizedError extends Error {
  public constructor() {
    super("A valid SCIM bearer credential is required.");
    this.name = "LifecycleUnauthorizedError";
  }
}

export class LifecycleForbiddenError extends Error {
  public constructor() {
    super("The principal may not manage this lifecycle resource.");
    this.name = "LifecycleForbiddenError";
  }
}

export class LifecycleNotFoundError extends Error {
  public constructor() {
    super("The SCIM resource was not found.");
    this.name = "LifecycleNotFoundError";
  }
}

export class LifecycleConflictError extends Error {
  public constructor() {
    super("The SCIM externalId or userName already exists.");
    this.name = "LifecycleConflictError";
  }
}
