// memory store — the reference implementation of the store contract, and the
// thing every other adapter is tested against. Volatile.
//
// The contract (what an adapter must provide):
//   get(slug)                 -> node | undefined
//   put(node)                 -> node            (upsert by slug)
//   delete(slug)              -> boolean
//   children(slug)            -> node[]          (direct children only)
//   byComponent(name, {prefix}) -> node[]
//   byMember(principal)       -> node[]          (owned by, or member of)
//   query(selector)           -> node[]          (generic document query)
//   claimRoot(node)           -> node            (atomic first-come; throws if taken)
//   all()                     -> node[]
//
// claimRoot is the one operation that must be atomic: the check-and-insert
// happens synchronously, before any await yields, so two simultaneous claims on
// the same slug cannot both win.

import { normalizeSlug, parentSlug } from '../paths.js';

const clone = (n) => (n == null ? n : structuredClone(n));
const bySlugCmp = (a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0);

function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

// A tiny mongo-ish selector: exact match, plus { $regex } and { $exists }.
function matchSelector(node, sel) {
  for (const [k, v] of Object.entries(sel)) {
    const actual = getPath(node, k);
    if (v && typeof v === 'object' && '$regex' in v) {
      if (!new RegExp(v.$regex).test(String(actual ?? ''))) return false;
    } else if (v && typeof v === 'object' && '$exists' in v) {
      if ((actual !== undefined) !== v.$exists) return false;
    } else if (actual !== v) {
      return false;
    }
  }
  return true;
}

export function makeMemoryStore({ onChange = null } = {}) {
  const bySlug = new Map();
  const changed = () => {
    if (onChange) onChange([...bySlug.values()].map(clone));
  };
  const withPrefix = (n, prefix) => {
    if (!prefix) return true;
    const p = normalizeSlug(prefix);
    return n.slug === p || n.slug.startsWith(p + '/');
  };

  return {
    kind: 'memory',

    async get(slug) {
      return clone(bySlug.get(normalizeSlug(slug)));
    },

    async put(node) {
      bySlug.set(node.slug, clone(node));
      changed();
      return clone(node);
    },

    async delete(slug) {
      const ok = bySlug.delete(normalizeSlug(slug));
      if (ok) changed();
      return ok;
    },

    async children(slug) {
      const p = normalizeSlug(slug);
      return [...bySlug.values()]
        .filter((n) => n.slug !== p && parentSlug(n.slug) === p)
        .map(clone)
        .sort(bySlugCmp);
    },

    async byComponent(name, { prefix = null } = {}) {
      return [...bySlug.values()]
        .filter((n) => n.components && name in n.components && withPrefix(n, prefix))
        .map(clone)
        .sort(bySlugCmp);
    },

    async byMember(principal) {
      return [...bySlug.values()]
        .filter((n) => n.owner === principal || (n.members ?? []).some((m) => m.who === principal))
        .map(clone)
        .sort(bySlugCmp);
    },

    async query(selector = {}) {
      return [...bySlug.values()].filter((n) => matchSelector(n, selector)).map(clone).sort(bySlugCmp);
    },

    async claimRoot(node) {
      if (bySlug.has(node.slug)) throw new Error(`already claimed: ${node.slug}`);
      bySlug.set(node.slug, clone(node)); // synchronous check-and-insert — atomic
      changed();
      return clone(node);
    },

    async all() {
      return [...bySlug.values()].map(clone);
    },

    // load a node without firing onChange — used by persistent adapters at boot
    _seed(node) {
      bySlug.set(normalizeSlug(node.slug), clone(node));
    },
  };
}
