import type {
  AuthenticatedUser,
  InitializeWorkbookEncryptionInput,
  RegisterEncryptionIdentityInput,
  SecureWorkbookShareInput,
  StageWorkbookRotationInput,
} from "@zerosheet/contracts";
import type { AuthorizationApplicationService } from "../authorization/types.js";
import {
  ProductDependencyError,
  ProductForbiddenError,
  ProductNotFoundError,
} from "../product/errors.js";
import type { ProductApplicationService } from "../product/types.js";
import {
  EncryptionIdentityRequiredError,
  WorkbookEnvelopeUnavailableError,
} from "./errors.js";
import type {
  WorkbookSecurityApplicationService,
  WorkbookSecurityRepository,
} from "./types.js";
import {
  assertValidUserPublicKey,
  decodeEncryptedPrivateKeyBackup,
} from "./validation.js";

export interface WorkbookSecurityServiceOptions {
  readonly repository: WorkbookSecurityRepository;
  readonly decisions: AuthorizationApplicationService;
  readonly product: ProductApplicationService;
  readonly now?: () => Date;
}

/**
 * This service coordinates identity/authorization facts and opaque encrypted
 * material. HPKE seal/open operations are intentionally absent: only an
 * authorized browser ever handles the raw workbook key or recovery phrase.
 */
export class WorkbookSecurityService implements WorkbookSecurityApplicationService {
  readonly #repository: WorkbookSecurityRepository;
  readonly #decisions: AuthorizationApplicationService;
  readonly #product: ProductApplicationService;
  readonly #now: () => Date;

  public constructor(options: WorkbookSecurityServiceOptions) {
    this.#repository = options.repository;
    this.#decisions = options.decisions;
    this.#product = options.product;
    this.#now = options.now ?? (() => new Date());
  }

  public async registerIdentity(
    actor: AuthenticatedUser,
    input: RegisterEncryptionIdentityInput,
  ) {
    assertValidUserPublicKey(input.publicKey);
    const encryptedBackup = decodeEncryptedPrivateKeyBackup(
      input.encryptedPrivateKeyBackup,
    );
    try {
      return await this.#repository.registerIdentity({
        userId: actor.id,
        publicKey: input.publicKey,
        encryptedPrivateKeyBackup: encryptedBackup,
        now: this.#now(),
      });
    } finally {
      // The database driver made its own copy. Clearing this request-scoped
      // array reduces lifetime even though the Capsule was already encrypted.
      encryptedBackup.fill(0);
    }
  }

  public async ownIdentity(actor: AuthenticatedUser) {
    const identity = await this.#repository.findCurrentIdentity(actor.id);
    if (!identity) throw new EncryptionIdentityRequiredError();
    return identity;
  }

  public async ownIdentityVersion(
    actor: AuthenticatedUser,
    keyVersion: number,
  ) {
    const identity = await this.#repository.findIdentity(actor.id, keyVersion);
    if (!identity) throw new EncryptionIdentityRequiredError();
    return identity;
  }

  public async recipientKey(
    actor: AuthenticatedUser,
    workbookId: string,
    recipientUserId: string,
  ) {
    await this.requireWorkbookPermission(
      actor,
      workbookId,
      "can_manage_sharing",
    );
    const identity =
      await this.#repository.findRecipientIdentity(recipientUserId);
    if (!identity) throw new EncryptionIdentityRequiredError();
    return identity;
  }

  public async initializeWorkbook(
    actor: AuthenticatedUser,
    workbookId: string,
    input: InitializeWorkbookEncryptionInput,
  ) {
    await this.requireWorkbookPermission(
      actor,
      workbookId,
      "can_manage_sharing",
    );
    return this.#repository.initializeWorkbook({
      actorId: actor.id,
      workbookId,
      ...input,
      now: this.#now(),
    });
  }

  public async workbookAccess(actor: AuthenticatedUser, workbookId: string) {
    await this.requireWorkbookPermission(actor, workbookId, "can_view");
    const access = await this.#repository.findWorkbookAccess(
      workbookId,
      actor.id,
    );
    if (!access) throw new WorkbookEnvelopeUnavailableError();
    return access;
  }

  public async setSecureUserShare(
    actor: AuthenticatedUser,
    workbookId: string,
    recipientUserId: string,
    input: SecureWorkbookShareInput,
  ) {
    await this.requireWorkbookPermission(
      actor,
      workbookId,
      "can_manage_sharing",
    );

    // Store the recipient envelope before OpenFGA can authorize access. If the
    // relationship write fails, the envelope by itself grants nothing and the
    // browser rolls back the already-created Google Drive permission.
    await this.#repository.storeSecureShareMaterial({
      workbookId,
      recipientUserId,
      googlePermissionId: input.googlePermissionId,
      recipientEnvelope: input.recipientEnvelope,
      now: this.#now(),
    });
    return this.#product.setWorkbookShare(
      actor,
      workbookId,
      { type: "user", id: recipientUserId },
      input.role,
    );
  }

  public async stageRotation(
    actor: AuthenticatedUser,
    workbookId: string,
    input: StageWorkbookRotationInput,
  ) {
    await this.requireWorkbookPermission(
      actor,
      workbookId,
      "can_manage_sharing",
    );
    return this.#repository.stageRotation({
      actorId: actor.id,
      workbookId,
      ...input,
      now: this.#now(),
    });
  }

  public async rotationPlan(
    actor: AuthenticatedUser,
    workbookId: string,
    revokedUserId: string,
  ) {
    await this.requireWorkbookPermission(
      actor,
      workbookId,
      "can_manage_sharing",
    );
    return this.#repository.createRotationPlan(workbookId, revokedUserId);
  }

  public async commitRotation(
    actor: AuthenticatedUser,
    workbookId: string,
    toKeyVersion: number,
  ) {
    await this.requireWorkbookPermission(
      actor,
      workbookId,
      "can_manage_sharing",
    );

    // Advance the cryptographic version first. Even if OpenFGA is temporarily
    // unavailable, the removed user has no envelope for newly written content.
    const rotation = await this.#repository.commitRotation({
      actorId: actor.id,
      workbookId,
      toKeyVersion,
      now: this.#now(),
    });
    try {
      await this.#product.removeWorkbookShare(actor, workbookId, {
        type: "user",
        id: rotation.revokedUserId,
      });
    } catch (error) {
      // Retrying a successfully committed rotation after reconciliation can
      // find the share already gone. That is the desired idempotent end state.
      if (!(error instanceof ProductNotFoundError)) throw error;
    }
    return rotation;
  }

  private async requireWorkbookPermission(
    actor: AuthenticatedUser,
    workbookId: string,
    permission: "can_view" | "can_manage_sharing",
  ): Promise<void> {
    try {
      if (
        !(await this.#decisions.canAccessWorkbook({
          userId: actor.id,
          workbookId,
          permission,
        }))
      ) {
        throw new ProductForbiddenError();
      }
    } catch (error) {
      if (error instanceof ProductForbiddenError) throw error;
      throw new ProductDependencyError();
    }
  }
}
