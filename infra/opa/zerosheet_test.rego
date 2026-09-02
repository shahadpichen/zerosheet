# These tests run in OPA's own policy engine. TypeScript tests separately prove
# that the API builds these inputs correctly and fails closed at network edges.
package zerosheet.authz

import rego.v1

active_subject := {"id": "user-1", "status": "active", "organizationStatus": "active"}
active_organization := {"id": "organization-1", "status": "active"}
active_relationship := {"required": true, "allowed": true}

test_active_user_can_create_organization if {
  allow with input as {
    "subject": active_subject,
    "resource": {"type": "platform", "id": "zerosheet"},
    "action": "create_organization",
    "relationship": {"required": false, "allowed": false},
  }
}

test_suspended_user_cannot_create_organization if {
  not allow with input as {
    "subject": {"id": "user-1", "status": "suspended"},
    "resource": {"type": "platform", "id": "zerosheet"},
    "action": "create_organization",
    "relationship": {"required": false, "allowed": false},
  }
}

test_active_relationship_and_context_allow_workbook_view if {
  allow with input as {
    "subject": active_subject,
    "organization": active_organization,
    "resource": {"type": "workbook", "id": "workbook-1"},
    "action": "can_view",
    "relationship": active_relationship,
  }
}

test_openfga_denial_overrides_active_context if {
  not allow with input as {
    "subject": active_subject,
    "organization": active_organization,
    "resource": {"type": "workbook", "id": "workbook-1"},
    "action": "can_view",
    "relationship": {"required": true, "allowed": false},
  }
}

test_suspended_user_overrides_openfga_allow if {
  not allow with input as {
    "subject": {"id": "user-1", "status": "suspended"},
    "organization": active_organization,
    "resource": {"type": "workbook", "id": "workbook-1"},
    "action": "can_view",
    "relationship": active_relationship,
  }
}

test_suspended_tenant_membership_overrides_openfga_allow if {
  not allow with input as {
    "subject": {"id": "user-1", "status": "active", "organizationStatus": "suspended"},
    "organization": active_organization,
    "resource": {"type": "workbook", "id": "workbook-1"},
    "action": "can_view",
    "relationship": active_relationship,
  }
}

test_suspended_tenant_overrides_openfga_allow if {
  not allow with input as {
    "subject": active_subject,
    "organization": {"id": "organization-1", "status": "suspended"},
    "resource": {"type": "workbook", "id": "workbook-1"},
    "action": "can_view",
    "relationship": active_relationship,
  }
}

test_action_resource_mismatch_is_denied if {
  not allow with input as {
    "subject": active_subject,
    "organization": active_organization,
    "resource": {"type": "workbook", "id": "workbook-1"},
    "action": "can_manage_members",
    "relationship": active_relationship,
  }
}

test_missing_input_is_denied if {
  not allow with input as {}
}

test_missing_identifiers_are_denied if {
  not allow with input as {
    "subject": {"status": "active", "organizationStatus": "active"},
    "organization": active_organization,
    "resource": {"type": "workbook"},
    "action": "can_view",
    "relationship": active_relationship,
  }
}
