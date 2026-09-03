import type {
  AuthenticatedUser,
  EncryptionIdentityResponse,
  InitializeWorkbookEncryptionInput,
  RecipientEncryptionKeyResponse,
  RegisterEncryptionIdentityInput,
  SecureWorkbookShareInput,
  StageWorkbookRotationInput,
  UserPublicEncryptionKey,
  WorkbookEncryptionAccessResponse,
  WorkbookEncryptionStateResponse,
  WorkbookKeyEnvelope,
  WorkbookRotationResponse,
  WorkbookRotationPlanResponse,
  WorkbookSharingAuditExpectationResponse,
  WorkbookShareResponse,
} from "@zerosheet/contracts";

export interface RegisterIdentityRecordInput {
  readonly userId: string;
  readonly publicKey: UserPublicEncryptionKey;
  readonly encryptedPrivateKeyBackup: Uint8Array;
  readonly now: Date;
}

export interface InitializeWorkbookRecordInput extends InitializeWorkbookEncryptionInput {
  readonly actorId: string;
  readonly workbookId: string;
  readonly now: Date;
}

export interface StoreSecureShareMaterialInput {
  readonly workbookId: string;
  readonly recipientUserId: string;
  readonly googlePermissionId: string;
  readonly recipientEnvelope: WorkbookKeyEnvelope;
  readonly now: Date;
}

export interface StageRotationRecordInput {
  readonly workbookId: string;
  readonly actorId: string;
  readonly revokedUserId: string;
  readonly toKeyVersion: number;
  readonly remainingRecipientEnvelopes: readonly {
    readonly userId: string;
    readonly envelope: WorkbookKeyEnvelope;
  }[];
  readonly now: Date;
}

export interface CommitRotationRecordInput {
  readonly workbookId: string;
  readonly actorId: string;
  readonly toKeyVersion: number;
  readonly now: Date;
}

/**
 * This repository accepts encrypted or public material only. Its interface has
 * no recovery phrase, CryptoKey, raw workbook-key bytes, or cell-value method,
 * which makes accidental server-side decryption an architectural violation.
 */
export interface WorkbookSecurityRepository {
  assertReady(): Promise<void>;
  registerIdentity(
    input: RegisterIdentityRecordInput,
  ): Promise<EncryptionIdentityResponse>;
  findCurrentIdentity(
    userId: string,
  ): Promise<EncryptionIdentityResponse | null>;
  findIdentity(
    userId: string,
    keyVersion: number,
  ): Promise<EncryptionIdentityResponse | null>;
  findRecipientIdentity(
    userId: string,
  ): Promise<RecipientEncryptionKeyResponse | null>;
  initializeWorkbook(
    input: InitializeWorkbookRecordInput,
  ): Promise<WorkbookEncryptionStateResponse>;
  findWorkbookAccess(
    workbookId: string,
    userId: string,
  ): Promise<WorkbookEncryptionAccessResponse | null>;
  listSharingAuditExpectation(
    workbookId: string,
  ): Promise<WorkbookSharingAuditExpectationResponse>;
  createRotationPlan(
    workbookId: string,
    revokedUserId: string,
  ): Promise<WorkbookRotationPlanResponse>;
  storeSecureShareMaterial(input: StoreSecureShareMaterialInput): Promise<void>;
  stageRotation(
    input: StageRotationRecordInput,
  ): Promise<WorkbookRotationResponse>;
  commitRotation(
    input: CommitRotationRecordInput,
  ): Promise<WorkbookRotationResponse>;
}

export interface WorkbookSecurityApplicationService {
  registerIdentity(
    actor: AuthenticatedUser,
    input: RegisterEncryptionIdentityInput,
  ): Promise<EncryptionIdentityResponse>;
  ownIdentity(actor: AuthenticatedUser): Promise<EncryptionIdentityResponse>;
  ownIdentityVersion(
    actor: AuthenticatedUser,
    keyVersion: number,
  ): Promise<EncryptionIdentityResponse>;
  recipientKey(
    actor: AuthenticatedUser,
    workbookId: string,
    recipientUserId: string,
  ): Promise<RecipientEncryptionKeyResponse>;
  initializeWorkbook(
    actor: AuthenticatedUser,
    workbookId: string,
    input: InitializeWorkbookEncryptionInput,
  ): Promise<WorkbookEncryptionStateResponse>;
  workbookAccess(
    actor: AuthenticatedUser,
    workbookId: string,
  ): Promise<WorkbookEncryptionAccessResponse>;
  sharingAuditExpectation(
    actor: AuthenticatedUser,
    workbookId: string,
  ): Promise<WorkbookSharingAuditExpectationResponse>;
  setSecureUserShare(
    actor: AuthenticatedUser,
    workbookId: string,
    recipientUserId: string,
    input: SecureWorkbookShareInput,
  ): Promise<WorkbookShareResponse>;
  rotationPlan(
    actor: AuthenticatedUser,
    workbookId: string,
    revokedUserId: string,
  ): Promise<WorkbookRotationPlanResponse>;
  stageRotation(
    actor: AuthenticatedUser,
    workbookId: string,
    input: StageWorkbookRotationInput,
  ): Promise<WorkbookRotationResponse>;
  commitRotation(
    actor: AuthenticatedUser,
    workbookId: string,
    toKeyVersion: number,
  ): Promise<WorkbookRotationResponse>;
}
