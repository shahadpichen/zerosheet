import { describe, expect, it } from "vitest";
import {
  organizationMembershipMutation,
  provisionTeamMutation,
  provisionWorkbookMutation,
  teamMembershipMutation,
  workbookShareMutation,
} from "./relationship-tuples.js";

describe("reviewed OpenFGA relationship tuple builders", () => {
  it("separates tenant containment from workbook ownership", () => {
    expect(
      provisionWorkbookMutation("workbook-id", "organization-id", "owner-id"),
    ).toEqual({
      writes: [
        {
          user: "organization:organization-id",
          relation: "organization",
          object: "workbook:workbook-id",
        },
        {
          user: "user:owner-id",
          relation: "owner",
          object: "workbook:workbook-id",
        },
      ],
      deletes: [],
    });
  });

  it("creates a team with its organization and initial manager", () => {
    expect(
      provisionTeamMutation("team-id", "organization-id", "manager-id"),
    ).toEqual({
      writes: [
        {
          user: "organization:organization-id",
          relation: "organization",
          object: "team:team-id",
        },
        {
          user: "user:manager-id",
          relation: "manager",
          object: "team:team-id",
        },
      ],
      deletes: [],
    });
  });

  it("replaces a direct role without accepting raw tuple strings", () => {
    expect(
      organizationMembershipMutation(
        "organization-id",
        "user-id",
        "member",
        "admin",
      ),
    ).toEqual({
      writes: [
        {
          user: "user:user-id",
          relation: "admin",
          object: "organization:organization-id",
        },
      ],
      deletes: [
        {
          user: "user:user-id",
          relation: "member",
          object: "organization:organization-id",
        },
      ],
    });
  });

  it("represents a team share as the team member userset", () => {
    expect(
      workbookShareMutation(
        "workbook-id",
        { type: "team", id: "team-id" },
        null,
        "editor",
      ),
    ).toEqual({
      writes: [
        {
          user: "team:team-id#member",
          relation: "editor",
          object: "workbook:workbook-id",
        },
      ],
      deletes: [],
    });
  });

  it("builds deletion-only mutations for revocation", () => {
    expect(
      teamMembershipMutation("team-id", "user-id", "member", null),
    ).toEqual({
      writes: [],
      deletes: [
        {
          user: "user:user-id",
          relation: "member",
          object: "team:team-id",
        },
      ],
    });
  });
});
