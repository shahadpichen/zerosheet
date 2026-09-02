import type {
  AuthorizationApplicationService,
  AuthorizationGateway,
  CheckWorkbookPermissionInput,
} from "./types.js";

/**
 * AuthorizationService is deliberately small in this milestone. Its value is
 * the boundary: HTTP routes depend on a product action, while the gateway owns
 * OpenFGA syntax and consistency. OPA context and key-envelope possession can
 * be composed here later without teaching routes about multiple PDPs.
 */
export class AuthorizationService implements AuthorizationApplicationService {
  public constructor(private readonly gateway: AuthorizationGateway) {}

  public canAccessWorkbook(
    input: CheckWorkbookPermissionInput,
  ): Promise<boolean> {
    return this.gateway.checkWorkbookPermission(input);
  }
}
