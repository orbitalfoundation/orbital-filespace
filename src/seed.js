// seed — the bridge between a shell programmer and the live store. Walks a
// public/ tree starting from its root manifest, visiting only folders the
// manifest declares in `children`. Undeclared folders are invisible by
// construction — no skip-lists.
//
// A manifest is info.json / info.js / manifest.json / manifest.js and may be:
//   - a single entity              { slug, components, ... }
//   - an array of entities         [ {...}, {...} ]
//   - a container                  { entities|nodes|items: [...], children: ["sub"] }
//
// Invariant: seeding NEVER clobbers a runtime-origin node. Disk manifests are
// initial conditions; once a node has been edited live, the live state wins. So
// re-running the seed is always safe and idempotent against admin content.

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { makeNode } from './node.js';
import { normalizeSlug } from './paths.js';

const MANIFEST_NAMES = ['info.js', 'info.json', 'manifest.js', 'manifest.json'];

function normalizeManifest(parsed) {
  if (Array.isArray(parsed)) return { entities: parsed, children: [] };
  if (!parsed || typeof parsed !== 'object') return { entities: [], children: [] };
  const entities = parsed.entities ?? parsed.nodes ?? parsed.items ?? (parsed.slug ? [parsed] : []);
  const children = parsed.children ?? [];
  return { entities, children };
}

async function readManifest(dir, warn) {
  for (const fname of MANIFEST_NAMES) {
    const p = join(dir, fname);
    if (!existsSync(p)) continue;
    try {
      if (fname.endsWith('.json')) {
        return normalizeManifest(JSON.parse(await readFile(p, 'utf8')));
      }
      const mod = await import(`${pathToFileURL(p).href}?t=${Date.now()}`);
      return normalizeManifest(mod.default ?? mod);
    } catch (err) {
      warn(`[seed] malformed manifest ${p}: ${err.message}`);
      return null;
    }
  }
  return null;
}

function resolveSlug(slug, base) {
  if (!slug) return null;
  if (String(slug).startsWith('/')) return normalizeSlug(slug);
  return normalizeSlug(base === '/' ? `/${slug}` : `${base}/${slug}`);
}

export async function seedDir(store, rootDir, { basePath = '/', log = () => {}, warn = console.warn } = {}) {
  const stats = { visited: 0, upserted: 0, skipped: 0 };

  async function walk(dir, base) {
    const manifest = await readManifest(dir, warn);
    stats.visited++;
    if (!manifest) return;

    for (const ent of manifest.entities) {
      const slug = resolveSlug(ent.slug, base);
      if (!slug) continue;
      const existing = await store.get(slug);
      if (existing && existing.origin === 'runtime') {
        stats.skipped++; // live edits win over the seed
        continue;
      }
      await store.put(
        makeNode({
          slug,
          owner: ent.owner ?? null,
          policy: ent.policy ?? 'public',
          members: ent.members ?? [],
          components: ent.components ?? {},
          origin: 'seed',
          id: existing?.id ?? null,
          createdAt: existing?.createdAt ?? null,
        }),
      );
      stats.upserted++;
    }

    for (const child of manifest.children) {
      await walk(join(dir, child), resolveSlug(child, base));
    }
  }

  await walk(rootDir, basePath);
  log(`[seed] visited ${stats.visited} folder(s), upserted ${stats.upserted}, skipped ${stats.skipped}`);
  return stats;
}
