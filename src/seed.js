// seed — the manifest reader: the bridge between a shell programmer and the
// live store. There is ONE manifest convention, used by both lazy hydration and
// the eager `seed` sweep (which is just recursive hydration):
//
//   - Every folder may carry info.js / info.json (or manifest.js / manifest.json).
//   - A manifest declares the folder's own node and names its children — either
//     as explicit pointer declarations ({ slug, hydrated: false }) or via
//     `children: ["name", ...]` sugar, which filespace expands into pointers.
//   - Undeclared folders are invisible by construction: filespace only loads a
//     child's manifest if its parent declared it. No skip-lists, no probing.
//
//   .js  manifests are loaded through the @orbitalfoundation/bus loader — each
//        named export is dispatched as a bus event; filespace ingests the
//        { filespace: { seed: {...} } } shaped ones. Real JavaScript: loops,
//        imports, computed declarations.
//   .json manifests are the plain "pile of declarations" flavor; filespace reads
//        them here and feeds the same seed events (via the bus when bound).
//
// A JSON manifest may be:
//   - a single entity              { slug, components, ... }
//   - an array of entities         [ {...}, {...} ]
//   - a container                  { entities|nodes|items: [...], children: ["sub"] }
//
// Invariant (enforced by filespace's ingest): seeding NEVER clobbers a
// runtime-origin node, and never downgrades a hydrated node to a pointer. Disk
// manifests are initial conditions; the live store is the source of truth.

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeSlug } from './paths.js';

export const MANIFEST_NAMES = ['info.js', 'info.json', 'manifest.js', 'manifest.json'];

// The manifest file present in a folder, if any: { path, kind: 'js' | 'json' }.
export function findManifest(dir) {
  for (const fname of MANIFEST_NAMES) {
    const path = join(dir, fname);
    if (existsSync(path)) return { path, kind: fname.endsWith('.json') ? 'json' : 'js' };
  }
  return null;
}

function resolveSlug(slug, base) {
  if (!slug) return null;
  if (String(slug).startsWith('/')) return normalizeSlug(slug);
  return normalizeSlug(base === '/' ? `/${slug}` : `${base}/${slug}`);
}

// Read a .json manifest into seed declarations with slugs resolved against
// `base` (the folder's own slug). Top-level `children` become pointer
// declarations; entity-level `children` sugar is left for ingest to expand.
export async function readJsonManifest(path, base = '/') {
  const parsed = JSON.parse(await readFile(path, 'utf8'));
  const shaped = Array.isArray(parsed) ? { entities: parsed } : parsed && typeof parsed === 'object' ? parsed : {};
  const entities = shaped.entities ?? shaped.nodes ?? shaped.items ?? (shaped.slug ? [shaped] : []);
  const decls = [];
  for (const ent of entities) {
    const slug = resolveSlug(ent.slug, base);
    if (!slug) continue;
    decls.push({ ...ent, slug });
  }
  for (const name of shaped.children ?? []) {
    const slug = resolveSlug(name, base);
    if (slug) decls.push({ slug, hydrated: false });
  }
  return decls;
}
