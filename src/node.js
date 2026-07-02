// node — the unit of the filespace. A node is a folder/area/content item at a
// slug. Folders and content are the same shape; the presence of components
// (about, agent, geo, link, chore...) is what distinguishes them, ECS-style.
//
//   id         durable uuid, assigned once at first sight
//   slug       path address, unique, the primary key
//   owner      principal (pubkey or handle) that owns this; inherited from area
//   policy     'public' | 'protected' | 'private'  (governs guest access)
//   members    [{ who, role }]  role: 'owner' | 'member'
//   components arbitrary data: about, geo, link, agent, chore, view, ...
//   origin     'seed' (from a manifest on disk) | 'runtime' (created live)

import { normalizeSlug } from './paths.js';

export function makeNode({
  slug,
  owner = null,
  policy = 'public',
  members = [],
  components = {},
  origin = 'runtime',
  // hydrated = its own manifest has been loaded, so its children are known. A node
  // named only as a child pointer by its parent is present but not yet hydrated.
  hydrated = true,
  id = null,
  createdAt = null,
} = {}) {
  const now = Date.now();
  return {
    id: id ?? crypto.randomUUID(),
    slug: normalizeSlug(slug),
    owner,
    policy,
    members,
    components,
    origin,
    hydrated,
    createdAt: createdAt ?? now,
    updatedAt: now,
  };
}
