// policy — the permission rules. Pure functions: given a principal, a verb, the
// target node and its ancestor chain, decide allow/deny.
//
// This is the ruleset the edge auth-gateway consults. Keeping it pure and
// separately testable is the point: the socket gateway can run "allow-all" today
// and switch to enforcing these rules later by flipping one flag — no rewrite.
//
// Verbs:
//   read          see the node and enumerate its children
//   post          contribute to the node's stream (messages — the streams layer)
//   update        mutate the node's own components
//   create-child  create a sub-folder or content item under it
//   invite        grant membership to another principal
//   administer    delete, move, change policy, transfer ownership
//
// Roles are computed from the node AND its whole ancestor chain, so membership
// granted anywhere on the path applies to everything beneath it: invited to
// '/anselm/project', you are a member of '/anselm/project/photos' too.
//
// Guests are read-only. 'post' is the one guest-writable verb (public areas
// only) and is reserved for the streams layer — mutating a node itself
// ('update') always requires membership, so a public folder can't be defaced.

export const VERBS = ['read', 'post', 'update', 'create-child', 'invite', 'administer'];

// `chain` is the node's ancestors (any order); membership is the union.
export function roleOf(principal, node, chain = []) {
  if (!principal) return 'guest';
  const nodes = [node, ...chain].filter(Boolean);
  let member = false;
  for (const n of nodes) {
    if (n.owner === principal) return 'owner';
    const m = (n.members ?? []).find((x) => x.who === principal);
    if (m?.role === 'owner') return 'owner';
    if (m) member = true;
  }
  return member ? 'member' : 'guest';
}

// Read visibility, with inheritance: a guest may read only if neither the node
// nor ANY ancestor is private — a "public" item inside a private area stays
// hidden. Owners and members always see their own space.
export function canRead(principal, node, chain = []) {
  const role = roleOf(principal, node, chain);
  if (role !== 'guest') return true;
  return [node, ...chain].filter(Boolean).every((n) => (n.policy ?? 'public') !== 'private');
}

export function can(principal, verb, node, { chain = [] } = {}) {
  const role = roleOf(principal, node, chain);
  if (role === 'owner') return true;
  if (role === 'member') return verb !== 'administer';

  // guest — read-only, gated by privacy inheritance; 'post' (streams) is the
  // single exception, on public nodes only.
  if (!canRead(principal, node, chain)) return false;
  if (verb === 'read') return true;
  if (verb === 'post') return (node?.policy ?? 'public') === 'public';
  return false;
}
