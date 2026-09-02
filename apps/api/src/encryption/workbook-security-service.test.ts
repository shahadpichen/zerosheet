import { createECDH, createHash } from "node:crypto";
import type {
  AuthenticatedUser,
  EncryptionIdentityResponse,
  RecipientEncryptionKeyResponse,
  UserPublicEncryptionKey,
  WorkbookEncryptionAccessResponse,
  WorkbookEncryptionStateResponse,
  WorkbookKeyEnvelope,
  WorkbookRotationPlanResponse,
  WorkbookRotationResponse,
} from "@zerosheet/contracts";
import { describe, expect, it } from "vitest";
import type {
  AuthorizationApplicationService,
  CheckWorkbookPermissionInput,
} from "../authorization/types.js";
import {
  ProductForbiddenError,
  ProductNotFoundError,
} from "../product/errors.js";
import type {
  Organization,
  OrganizationMembership,
  ProductApplicationService,
  Team,
  TeamMembership,
  Workbook,
  WorkbookShare,
  WorkbookSharePrincipal,
  WorkbookShareRole,
} from "../product/types.js";
import { WorkbookEnvelopeUnavailableError } from "./errors.js";
import type {
  CommitRotationRecordInput,
  InitializeWorkbookRecordInput,
  RegisterIdentityRecordInput,
  StageRotationRecordInput,
  WorkbookSecurityRepository,
} from "./types.js";
import { WorkbookSecurityService } from "./workbook-security-service.js";

const SUITE = "DHKEM_P256_HKDF_SHA256_HKDF_SHA256_AES_256_GCM" as const;
const actor: AuthenticatedUser = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "owner@example.com",
  displayName: "Owner",
};
const recipientId = "22222222-2222-4222-8222-222222222222";
const workbookId = "33333333-3333-4333-8333-333333333333";
const now = new Date("2026-09-03T03:00:00.000Z");

function publicKey(): UserPublicEncryptionKey {
  const ecdh = createECDH("prime256v1");
  const bytes = ecdh.generateKeys();
  return {
    formatVersion: 1,
    keyVersion: 1,
    suite: SUITE,
    publicKey: bytes.toString("base64url"),
    fingerprint: createHash("sha256").update(bytes).digest("hex"),
  };
}

function envelope(recipient: UserPublicEncryptionKey): WorkbookKeyEnvelope {
  const ephemeral = createECDH("prime256v1");
  return {
    formatVersion: 1,
    suite: SUITE,
    workbookKeyVersion: 1,
    recipientKeyVersion: recipient.keyVersion,
    recipientFingerprint: recipient.fingerprint,
    encapsulatedKey: ephemeral.generateKeys().toString("base64url"),
    ciphertext: Buffer.alloc(48, 7).toString("base64url"),
  };
}

class FakeDecisions implements AuthorizationApplicationService {
  public allowed = true;
  public checks: CheckWorkbookPermissionInput[] = [];
  public canCreateOrganization() {
    return Promise.resolve(false);
  }
  public canAccessOrganization() {
    return Promise.resolve(false);
  }
  public canAccessTeam() {
    return Promise.resolve(false);
  }
  public canAccessWorkbook(input: CheckWorkbookPermissionInput) {
    this.checks.push(input);
    return Promise.resolve(this.allowed);
  }
}

class FakeProduct implements ProductApplicationService {
  public readonly calls: string[] = [];
  public removeAsMissing = false;
  public createOrganization(): Promise<Organization> {
    throw new Error("not used");
  }
  public createTeam(): Promise<Team> {
    throw new Error("not used");
  }
  public createWorkbook(): Promise<Workbook> {
    throw new Error("not used");
  }
  public getWorkbook(): Promise<Workbook> {
    throw new Error("not used");
  }
  public setOrganizationMember(): Promise<OrganizationMembership> {
    throw new Error("not used");
  }
  public removeOrganizationMember(): Promise<void> {
    throw new Error("not used");
  }
  public setTeamMember(): Promise<TeamMembership> {
    throw new Error("not used");
  }
  public removeTeamMember(): Promise<void> {
    throw new Error("not used");
  }
  public setWorkbookShare(
    _actor: AuthenticatedUser,
    requestedWorkbookId: string,
    principal: WorkbookSharePrincipal,
    role: WorkbookShareRole,
  ): Promise<WorkbookShare> {
    this.calls.push("product-share");
    return Promise.resolve({
      workbookId: requestedWorkbookId,
      principal,
      role,
    });
  }
  public removeWorkbookShare(): Promise<void> {
    this.calls.push("product-revoke");
    return this.removeAsMissing
      ? Promise.reject(new ProductNotFoundError())
      : Promise.resolve();
  }
  public reconcilePendingOperations(): Promise<number> {
    return Promise.resolve(0);
  }
}

class FakeRepository implements WorkbookSecurityRepository {
  public readonly calls: string[] = [];
  public access: WorkbookEncryptionAccessResponse | null = null;
  public identity: EncryptionIdentityResponse | null = null;
  public recipient: RecipientEncryptionKeyResponse | null = null;
  public assertReady(): Promise<void> {
    return Promise.resolve();
  }
  public registerIdentity(input: RegisterIdentityRecordInput) {
    this.calls.push("register");
    return Promise.resolve({
      userId: input.userId,
      publicKey: input.publicKey,
      encryptedPrivateKeyBackup: Buffer.from(
        input.encryptedPrivateKeyBackup,
      ).toString("base64url"),
    });
  }
  public findCurrentIdentity() {
    return Promise.resolve(this.identity);
  }
  public findIdentity() {
    return Promise.resolve(this.identity);
  }
  public findRecipientIdentity() {
    this.calls.push("recipient-key");
    return Promise.resolve(this.recipient);
  }
  public initializeWorkbook(
    input: InitializeWorkbookRecordInput,
  ): Promise<WorkbookEncryptionStateResponse> {
    return Promise.resolve({
      workbookId: input.workbookId,
      googleSpreadsheetId: input.googleSpreadsheetId,
      googleSheetId: input.googleSheetId,
      googleSheetTitle: input.googleSheetTitle,
      activeKeyVersion: 1,
      rotationState: "active",
      pendingKeyVersion: null,
    });
  }
  public findWorkbookAccess() {
    return Promise.resolve(this.access);
  }
  public createRotationPlan(): Promise<WorkbookRotationPlanResponse> {
    throw new Error("not used");
  }
  public storeSecureShareMaterial(): Promise<void> {
    this.calls.push("store-envelope");
    return Promise.resolve();
  }
  public stageRotation(
    input: StageRotationRecordInput,
  ): Promise<WorkbookRotationResponse> {
    return Promise.resolve({
      workbookId: input.workbookId,
      fromKeyVersion: input.toKeyVersion - 1,
      toKeyVersion: input.toKeyVersion,
      revokedUserId: input.revokedUserId,
      state: "pending",
    });
  }
  public commitRotation(
    input: CommitRotationRecordInput,
  ): Promise<WorkbookRotationResponse> {
    this.calls.push("commit-crypto");
    return Promise.resolve({
      workbookId: input.workbookId,
      fromKeyVersion: input.toKeyVersion - 1,
      toKeyVersion: input.toKeyVersion,
      revokedUserId: recipientId,
      state: "committed",
    });
  }
}

function setup() {
  const repository = new FakeRepository();
  const decisions = new FakeDecisions();
  const product = new FakeProduct();
  const service = new WorkbookSecurityService({
    repository,
    decisions,
    product,
    now: () => now,
  });
  return { service, repository, decisions, product };
}

describe("WorkbookSecurityService", () => {
  it("validates and registers only the acting user's encrypted identity", async () => {
    const { service, repository } = setup();
    const key = publicKey();
    const backup = Buffer.from("encrypted-capsule").toString("base64url");

    await expect(
      service.registerIdentity(actor, {
        publicKey: key,
        encryptedPrivateKeyBackup: backup,
      }),
    ).resolves.toMatchObject({ userId: actor.id, publicKey: key });
    expect(repository.calls).toEqual(["register"]);
  });

  it("does not disclose a recipient key before sharing permission passes", async () => {
    const { service, repository, decisions } = setup();
    decisions.allowed = false;

    await expect(
      service.recipientKey(actor, workbookId, recipientId),
    ).rejects.toBeInstanceOf(ProductForbiddenError);
    expect(repository.calls).toEqual([]);
  });

  it("stores the envelope before activating the user share", async () => {
    const { service, repository, product } = setup();
    const recipient = publicKey();
    await service.setSecureUserShare(actor, workbookId, recipientId, {
      role: "viewer",
      googlePermissionId: "1Permission_Resource_Id_123",
      recipientEnvelope: envelope(recipient),
    });

    expect([...repository.calls, ...product.calls]).toContain("store-envelope");
    expect(repository.calls).toEqual(["store-envelope"]);
    expect(product.calls).toEqual(["product-share"]);
  });

  it("keeps authorization and key possession as independent requirements", async () => {
    const { service } = setup();
    await expect(
      service.workbookAccess(actor, workbookId),
    ).rejects.toBeInstanceOf(WorkbookEnvelopeUnavailableError);
  });

  it("advances the cryptographic version before relationship revocation", async () => {
    const { service, repository, product } = setup();
    product.removeAsMissing = true;

    await expect(
      service.commitRotation(actor, workbookId, 2),
    ).resolves.toMatchObject({
      state: "committed",
      revokedUserId: recipientId,
    });
    expect(repository.calls).toEqual(["commit-crypto"]);
    expect(product.calls).toEqual(["product-revoke"]);
  });
});
