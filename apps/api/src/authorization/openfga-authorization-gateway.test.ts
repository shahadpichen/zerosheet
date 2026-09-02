import { ConsistencyPreference } from "@openfga/sdk";
import { describe, expect, it } from "vitest";
import { OpenFgaAuthorizationGateway } from "./openfga-authorization-gateway.js";

const modelId = "01H00000000000000000000001";

class RecordingOpenFgaClient {
  public allowed: boolean | undefined = true;
  public modelId = modelId;
  public checkBody:
    { user: string; relation: string; object: string } | undefined;
  public consistency: ConsistencyPreference | undefined;

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

  it("refuses startup when the pinned model cannot be read", async () => {
    const client = new RecordingOpenFgaClient();
    client.modelId = "01H00000000000000000000002";
    const gateway = new OpenFgaAuthorizationGateway(client, modelId);

    await expect(gateway.assertReady()).rejects.toThrow(
      /configured authorization model/u,
    );
  });
});
