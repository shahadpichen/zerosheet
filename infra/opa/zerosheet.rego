# OPA is the contextual Policy Decision Point (PDP). OpenFGA has already
# answered the durable relationship question before resource requests reach
# this policy, but its answer is still included as a required, auditable fact.
package zerosheet.authz

import rego.v1

# Default denial means missing fields, unknown actions, new resource types, and
# malformed input cannot become access accidentally.
default allow := false

# Creating an organization has no OpenFGA object yet. It is allowed only for an
# active product account and only when the caller explicitly marks the action
# as one that does not require a relationship.
allow if {
  is_string(input.subject.id)
  input.subject.id != ""
  input.subject.status == "active"
  is_string(input.resource.id)
  input.resource.type == "platform"
  input.resource.id == "zerosheet"
  input.action == "create_organization"
  input.relationship.required == false
  input.relationship.allowed == false
}

# Existing-resource actions require every gate: an active account, an active
# tenant, an explicit OpenFGA allow, and a reviewed action/resource pairing.
allow if {
  is_string(input.subject.id)
  input.subject.id != ""
  input.subject.status == "active"
  is_string(input.organization.id)
  input.organization.id != ""
  input.organization.status == "active"
  is_string(input.resource.id)
  input.resource.id != ""
  input.relationship.required == true
  input.relationship.allowed == true
  resource_action_allowed
}

resource_action_allowed if {
  input.resource.type == "organization"
  input.action in {"can_manage_members", "can_create_workbook"}
}

resource_action_allowed if {
  input.resource.type == "team"
  input.action == "can_manage"
}

resource_action_allowed if {
  input.resource.type == "workbook"
  input.action in {"can_view", "can_edit", "can_manage_sharing"}
}
