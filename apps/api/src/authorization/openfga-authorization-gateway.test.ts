import {
  ClientWriteRequestOnDuplicateWrites,
  ClientWriteRequestOnMissingDeletes,
  ClientWriteStatus,
  ConsistencyPreference,
} from "@openfga/sdk";
import { describe, expect, it } from "vitest";
import { OpenFgaAuthorizationGateway } from "./openfga-authorization-gateway.js";

const modelId = "01H00000000000000000000001";

class RecordingOpenFgaClient {
  public allowed: boolean | undefined = true;
  public modelId = modelId;
  public checkBody:
    { user: string; relation: string; object: string } | undefined;
  public consistency: ConsistencyPreference | undefined;
  public writeStatus = ClientWriteStatus.SUCCESS;
  public writeBody:
    | {
        writes?: Array<{ user: string; relation: string; object: string }>;
        deletes?: Array<{ user: string; relation: string; object: string }>;
      }
    | undefined;
  public writeOptions: unknown;

  public readAuthorizationModel() {
    return Promise.resolve({ authorization_model: { id: this.modelId } });
  }

  public check(
    body: { user: string; relation: string; object: string },
    options: { consistency: ConsistencyPreference },
  ) {
    this.checkBody = body;
    this.consistency = options.consistency;
    return Promise.resolve(
      this.allowed === undefined ? {} : { allowed: this.allowed },
    );
  }

  public write(
    body: {
      writes?: Array<{ user: string; relation: string; object: string }>;
      deletes?: Array<{ user: string; relation: string; object: string }>;
    },
    options: unknown,
  ) {
    this.writeBody = body;
    this.writeOptions = options;
    return Promise.resolve({
      writes: (body.writes ?? []).map(() => ({
        status: this.writeStatus,
      })),
      deletes: (body.deletes ?? []).map(() => ({
        status: this.writeStatus,
      })),
    });
  }
}

describe("OpenFgaAuthorizationGateway", () => {
  it("maps stable product IDs to a higher-consistency workbook check", async () => {
    const client = new RecordingOpenFgaClient();
    const gateway = new OpenFgaAuthorizationGateway(client, modelId);

    await expect(
      gateway.checkWorkbookPermission({
        userId: "47f04318-0190-4b24-ab78-1aab6b8d927f",
        workbookId: "3d9a575e-aed9-4634-b9ea-3f00334df680",
        permission: "can_edit",
      }),
    ).resolves.toBe(true);

    expect(client.checkBody).toEqual({
      user: "user:47f04318-0190-4b24-ab78-1aab6b8d927f",
      relation: "can_edit",
      object: "workbook:3d9a575e-aed9-4634-b9ea-3f00334df680",
    });
    expect(client.consistency).toBe(ConsistencyPreference.HigherConsistency);
  });

  it("fails closed when OpenFGA omits an explicit allow", async () => {
    const client = new RecordingOpenFgaClient();
    client.allowed = undefined;
    const gateway = new OpenFgaAuthorizationGateway(client, modelId);

    await expect(
      gateway.checkWorkbookPermission({
        userId: "47f04318-0190-4b24-ab78-1aab6b8d927f",
        workbookId: "3d9a575e-aed9-4634-b9ea-3f00334df680",
        permission: "can_view",
      }),
    ).resolves.toBe(false);
  });

  it("maps organization and team permissions without accepting object strings", async () => {
    const client = new RecordingOpenFgaClient();
    const gateway = new OpenFgaAuthorizationGateway(client, modelId);

    await gateway.checkOrganizationPermission({
      userId: "47f04318-0190-4b24-ab78-1aab6b8d927f",
      organizationId: "7dcbb1f8-afaa-4bf0-a60a-a73aeb3b5d4d",
      permission: "can_manage_members",
    });
    expect(client.checkBody).toEqual({
      user: "user:47f04318-0190-4b24-ab78-1aab6b8d927f",
      relation: "can_manage_members",
      object: "organization:7dcbb1f8-afaa-4bf0-a60a-a73aeb3b5d4d",
    });

    await gateway.checkTeamPermission({
      userId: "47f04318-0190-4b24-ab78-1aab6b8d927f",
      teamId: "4be56488-a2b4-4514-b56d-56a39f0e9d6d",
      permission: "can_manage",
    });
    expect(client.checkBody?.object).toBe(
      "team:4be56488-a2b4-4514-b56d-56a39f0e9d6d",
    );
    expect(client.consistency).toBe(ConsistencyPreference.HigherConsistency);
  });

  it("applies retry-safe tuple replacements in one OpenFGA write", async () => {
    const client = new RecordingOpenFgaClient();
    const gateway = new OpenFgaAuthorizationGateway(client, modelId);

    await gateway.applyRelationshipMutation({
      writes: [
        {
          user: "user:47f04318-0190-4b24-ab78-1aab6b8d927f",
          relation: "editor",
          object: "workbook:3d9a575e-aed9-4634-b9ea-3f00334df680",
        },
      ],
      deletes: [
        {
          user: "user:47f04318-0190-4b24-ab78-1aab6b8d927f",
          relation: "viewer",
          object: "workbook:3d9a575e-aed9-4634-b9ea-3f00334df680",
        },
      ],
    });

    expect(client.writeBody).toEqual({
      writes: [
        {
          user: "user:47f04318-0190-4b24-ab78-1aab6b8d927f",
          relation: "editor",
          object: "workbook:3d9a575e-aed9-4634-b9ea-3f00334df680",
        },
      ],
      deletes: [
        {
          user: "user:47f04318-0190-4b24-ab78-1aab6b8d927f",
          relation: "viewer",
          object: "workbook:3d9a575e-aed9-4634-b9ea-3f00334df680",
        },
      ],
    });
    expect(client.writeOptions).toEqual({
      conflict: {
        onDuplicateWrites: ClientWriteRequestOnDuplicateWrites.Ignore,
        onMissingDeletes: ClientWriteRequestOnMissingDeletes.Ignore,
      },
    });
  });

  it("fails a partial bulk response and serially chunks large revocations", async () => {
    const client = new RecordingOpenFgaClient();
    client.writeStatus = ClientWriteStatus.FAILURE;
    const gateway = new OpenFgaAuthorizationGateway(client, modelId);
    const deletes = Array.from({ length: 101 }, (_value, index) => ({
      user: `user:00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`,
      relation: "member",
      object: "team:4be56488-a2b4-4514-b56d-56a39f0e9d6d",
    }));

    await expect(
      gateway.applyRelationshipMutation({ writes: [], deletes }),
    ).rejects.toThrow(/every relationship tuple/u);
    expect(client.writeOptions).toMatchObject({
      transaction: {
        disable: true,
        maxPerChunk: 100,
        maxParallelRequests: 1,
      },
    });
  });

  it("refuses startup when the pinned model cannot be read", async () => {
    const client = new RecordingOpenFgaClient();
    client.modelId = "01H00000000000000000000002";
    const gateway = new OpenFgaAuthorizationGateway(client, modelId);

    await expect(gateway.assertReady()).rejects.toThrow(
      /configured authorization model/u,
    );
  });
});
