// policy — the permission rules. Pure functions: given a principal, a verb, the
// target node and (optionally) its governing root area, decide allow/deny.
//
// This is the ruleset the edge auth-gateway consults. Keeping it pure and
// separately testable is the point: the socket gateway can run "allow-all" today
// and switch to enforcing these rules later by flipping one flag — no rewrite.
//
// Verbs:
//   read          see the node and enumerate its children
//   post          add messages / mutate the node's own content
//   create-child  create a sub-folder or content item under it
//   invite        grant membership to another principal
//   administer    delete, change policy, transfer ownership
//
// Roles are computed from the node AND its root area, so membership granted on
// '/anselm' applies to everything beneath it.

export const VERBS = ['read', 'post', 'create-child', 'invite', 'administer'];

export function roleOf(principal, node, area = null) {
  if (!principal) return 'guest';
  const owners = [node?.owner, area?.owner].filter(Boolean);
  if (owners.includes(principal)) return 'owner';
  const members = [...(node?.members ?? []), ...(area?.members ?? [])];
  const m = members.find((x) => x.who === principal);
  if (m) return m.role === 'owner' ? 'owner' : 'member';
  return 'guest';
}

export function can(principal, verb, node, { area = null } = {}) {
  const role = roleOf(principal, node, area);
  if (role === 'owner') return true;
  if (role === 'member') return verb !== 'administer';

  // guest — gated by the node's policy
  const policy = node?.policy ?? 'public';
  if (policy === 'public') return verb === 'read' || verb === 'post';
  if (policy === 'protected') return verb === 'read';
  return false; // private: guests get nothing
}

// Read visibility, with inheritance. A node is readable by a guest only if
// neither the node NOR its governing area is private — so a "public" item inside
// a private area stays hidden. Owners and members always see their own space.
export function canRead(principal, node, area = null) {
  const role = roleOf(principal, node, area);
  if (role === 'owner' || role === 'member') return true;
  const areaPolicy = area?.policy ?? node?.policy ?? 'public';
  const nodePolicy = node?.policy ?? 'public';
  return areaPolicy !== 'private' && nodePolicy !== 'private';
}
