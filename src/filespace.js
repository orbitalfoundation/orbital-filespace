// filespace — the namespace service, exposed as a single listener on the bus.
//
// It occupies exactly ONE reserved key in the bus vocabulary: `filespace`. All
// operations nest inside it, split query (reads) vs command (writes), plus a
// third inbound shape — seed — for entities streaming in from a manifest:
//
//   { filespace: { query:   { op: 'list', slug } } }
//   { filespace: { command: { op: 'claim', slug, principal, auth } } }
//   { filespace: { seed:    { slug, components, hydrated, children } } }   // from a manifest
//
// And one outbound shape — changed — announced after every successful write, so
// live clients, agents, and indexers can react without polling:
//
//   { filespace: { changed: { op, slug, node } } }
//
// Verbs live inside a namespace filespace owns, so they can't collide with other
// subsystems and don't crowd the shared root. The service is also installed as
// `bus.filespace` for direct in-process calls (mirroring bus.spatial).
//
// Two gates, both in the core:
//   - enforce      authorization — may principal P do this? (policy + membership,
//                  computed over the node's whole ancestor chain)
//   - authenticate authentication — is the caller really P? (signed envelope)
//
// Loading is lazy. With a `manifestRoot`, filespace hydrates an area on demand:
// the first read of an unhydrated slug loads that area's manifest (.js via the
// bus loader, .json via the seed reader) and its entities stream back in as seed
// events. A manifest is only loaded for a node its PARENT declared — undeclared
// folders are invisible even to a direct probe. Misses are remembered so we
// never hit the filesystem twice for the same absence.
//
// `seed` (the eager sweep) is just recursive hydration over the same path — one
// manifest convention, one reader, one ingest. It is an ADMIN operation: it is
// deliberately NOT reachable through the command surface.

import logger from '@orbitalfoundation/utils';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import { makeNode } from './node.js';
import { can, canRead, roleOf } from './policy.js';
import { findManifest, readJsonManifest } from './seed.js';
import { makeAuthGuard } from './auth.js';
import { normalizeSlug, parentSlug, rootSlug, isRoot, isValidSlug, isDescendantOf } from './paths.js';

// One key. The whole subsystem is namespaced beneath it.
const SCHEMA = { filespace: true };

const deny = (error) => ({ ok: false, error });

export function makeService(store, { enforce = true, authenticate = false, verify, now, manifestRoot = null, resolveManifest = null } = {}) {
  // The guard authenticates a signed request at the query/command boundary.
  const guard = authenticate ? makeAuthGuard({ verify, now }) : null;

  // Lazy-loading state. `bus` is bound at registration so hydrate() can ask the
  // loader to fetch manifests and writes can announce changes. `inflight` dedupes
  // concurrent hydrations; `misses` is the negative cache — keyed by root+slug so
  // an eager sweep over a different dir doesn't inherit stale tombstones.
  let bus = null;
  const inflight = new Map();
  const misses = new Set();
  const missKey = (root, s) => `${root ?? '*'}::${s}`;

  // The node's ancestors, nearest first, as far as the store knows them. This is
  // the chain policy decisions are made over: membership anywhere on the path
  // applies to everything beneath it, and privacy anywhere on the path hides
  // everything beneath it.
  async function ancestorsOf(slug) {
    const out = [];
    let s = normalizeSlug(slug);
    while (s !== '/') {
      s = parentSlug(s);
      const n = await store.get(s);
      if (n) out.push(n);
    }
    return out;
  }

  const readable = async (reader, node) => canRead(reader, node, await ancestorsOf(node.slug));

  // Announce a successful write on the bus — fire-and-forget; observers must
  // never be able to break a write.
  function announce(op, payload) {
    if (!bus) return;
    try {
      const r = bus.resolve({ filespace: { changed: { op, ...payload } } });
      if (r?.catch) r.catch(() => {});
    } catch { /* ignore observer failures */ }
  }

  // --- lazy hydration ---

  // The on-disk directory a slug maps to, confined under the manifest root.
  // isValidSlug already forbids '.'/'..' segments; the resolve check is the belt
  // to that suspender.
  function dirFor(root, s) {
    const base = resolve(root);
    const dir = s === '/' ? base : resolve(base, s.slice(1));
    if (dir !== base && !dir.startsWith(base + sep)) return null;
    return dir;
  }

  // Load the manifest for area `s`, streaming its declarations in as seed
  // events. Returns false when there is nothing to load.
  async function loadArea(s, root) {
    if (resolveManifest) {
      if (!bus) return false;
      await bus.resolve({ load: resolveManifest(s) }); // custom resolver: legacy escape hatch
      return true;
    }
    const dir = dirFor(root, s);
    if (!dir) return false;
    const found = findManifest(dir);
    if (!found) return false;
    if (found.kind === 'js') {
      // real JavaScript manifests go through the bus loader — each export is
      // dispatched as an event; we ingest the { filespace: { seed } } ones
      if (!bus) {
        (logger.warn ?? logger.log)?.(`[filespace] ${found.path} skipped — .js manifests load via the bus loader`);
        return false;
      }
      await bus.resolve({ load: pathToFileURL(found.path).href });
    } else {
      // plain JSON manifests: same declarations, read here, same ingest
      for (const d of await readJsonManifest(found.path, s)) {
        if (bus) await bus.resolve({ filespace: { seed: d } });
        else await ingest(d);
      }
    }
    return true;
  }

  // Ensure the manifest that declares `slug`'s children has been loaded. A node
  // is `hydrated` once its own manifest has streamed in; a node named only as a
  // child pointer by its parent is present-but-not-hydrated (a stub). Idempotent,
  // deduped, negative-cached — and gated: a manifest is only loaded for a node
  // its parent declared, so undeclared folders can't be discovered by probing.
  async function hydrate(slug, root = manifestRoot) {
    if (!resolveManifest && !root) return null;
    const s = normalizeSlug(slug);
    if (!isValidSlug(s)) return null;
    const existing = await store.get(s);
    if (existing?.hydrated) return existing; // already inflated
    const key = missKey(root, s);
    if (misses.has(key)) return existing ?? null; // known miss — don't hit the fs again
    if (inflight.has(key)) return inflight.get(key); // a concurrent read is already fetching

    const promise = (async () => {
      try {
        if (s !== '/') {
          await hydrate(parentSlug(s), root); // the chain hydrates top-down from the root anchor
          if (!(await store.get(s))) {
            misses.add(key); // the parent never declared this slug — invisible by construction
            return null;
          }
        }
        try {
          await loadArea(s, root);
        } catch (err) {
          (logger.warn ?? logger.log)?.(`[filespace] failed loading manifest for ${s}: ${err.message}`);
        }
        const node = await store.get(s);
        if (node?.hydrated) return node;
        misses.add(key); // no manifest of its own — a pointer leaf, or a genuine miss
        return node ?? null;
      } finally {
        inflight.delete(key);
      }
    })();
    inflight.set(key, promise);
    return promise;
  }

  // Absorb an entity declared by a manifest. Never clobbers a live (runtime)
  // edit, and never downgrades a hydrated node back to a pointer. `children`
  // sugar — a list of child names — expands into pointer declarations.
  async function ingest(decl = {}) {
    if (!decl.slug) return { ok: false, error: 'slug required' };
    const slug = normalizeSlug(decl.slug);
    if (!isValidSlug(slug)) return { ok: false, error: `invalid slug: ${slug}` };
    const { children = [], ...rest } = decl;
    const existing = await store.get(slug);
    const hydrated = rest.hydrated !== false; // pointers set hydrated:false explicitly
    let skipped = null;
    if (existing?.origin === 'runtime') skipped = 'runtime';
    else if (existing?.hydrated && !hydrated) skipped = 'would-downgrade';
    else {
      await store.put(makeNode({
        slug,
        owner: rest.owner ?? existing?.owner ?? null,
        policy: rest.policy ?? existing?.policy ?? 'public',
        members: rest.members ?? existing?.members ?? [],
        components: rest.components ?? existing?.components ?? {},
        origin: 'seed',
        hydrated,
        id: existing?.id ?? null,
        createdAt: existing?.createdAt ?? null,
      }));
    }
    for (const name of children) {
      await ingest({ slug: slug === '/' ? `/${name}` : `${slug}/${name}`, hydrated: false });
    }
    return skipped ? { ok: true, skipped } : { ok: true };
  }

  const ensureNode = async (slug) => {
    if ((manifestRoot || resolveManifest) && !(await store.get(slug))) await hydrate(parentSlug(slug)); // the parent declares it
  };
  const ensureChildren = async (slug) => {
    if (manifestRoot || resolveManifest) await hydrate(slug); // this area's manifest declares its children
  };

  // --- granular ops: authorization only; the principal is trusted as given ---

  async function claim({ slug, principal, policy = 'public', components = {} } = {}) {
    if (!principal) return deny('principal required');
    const s = normalizeSlug(slug);
    if (!isValidSlug(s)) return deny(`invalid slug: ${s}`);
    if (!isRoot(s)) return deny('claim is for root areas only (single path segment)');
    const node = makeNode({
      slug: s,
      owner: principal,
      policy,
      members: [{ who: principal, role: 'owner' }],
      components,
      origin: 'runtime',
    });
    try {
      await store.claimRoot(node);
    } catch (err) {
      return deny(err.message);
    }
    announce('claim', { slug: node.slug, node });
    return { ok: true, node };
  }

  async function create({ slug, principal, policy, components = {} } = {}) {
    const s = normalizeSlug(slug);
    if (!isValidSlug(s)) return deny(`invalid slug: ${s}`);
    if (isRoot(s)) return deny('use claim for root areas');
    await ensureNode(s); // the parent may only exist on disk until now
    const parent = await store.get(parentSlug(s));
    if (!parent) return deny(`parent does not exist: ${parentSlug(s)}`);
    if (enforce && !can(principal, 'create-child', parent, { chain: await ancestorsOf(parent.slug) })) return deny('forbidden');
    if (await store.get(s)) return deny('already exists');
    const node = makeNode({
      slug: s,
      // the creator owns what they make — the area owner still administers
      // everything beneath them through the ancestor chain
      owner: principal ?? null,
      policy: policy ?? parent.policy ?? 'public',
      components,
      origin: 'runtime',
    });
    await store.put(node);
    announce('create', { slug: s, node });
    return { ok: true, node };
  }

  async function update({ slug, principal, components = {} } = {}) {
    const s = normalizeSlug(slug);
    await ensureNode(s);
    const node = await store.get(s);
    if (!node) return deny('not found');
    if (enforce && !can(principal, 'update', node, { chain: await ancestorsOf(s) })) return deny('forbidden');
    node.components = { ...node.components, ...components };
    for (const [k, v] of Object.entries(components)) if (v === null) delete node.components[k]; // null deletes a component
    node.updatedAt = Date.now();
    await store.put(node);
    announce('update', { slug: s, node });
    return { ok: true, node };
  }

  async function setPolicy({ slug, principal, policy } = {}) {
    if (!['public', 'protected', 'private'].includes(policy)) return deny('invalid policy');
    const s = normalizeSlug(slug);
    await ensureNode(s);
    const node = await store.get(s);
    if (!node) return deny('not found');
    if (enforce && !can(principal, 'administer', node, { chain: await ancestorsOf(s) })) return deny('forbidden');
    node.policy = policy;
    node.updatedAt = Date.now();
    await store.put(node);
    announce('set_policy', { slug: s, node });
    return { ok: true, node };
  }

  async function remove({ slug, principal } = {}) {
    const s = normalizeSlug(slug);
    await ensureNode(s);
    const node = await store.get(s);
    if (!node) return deny('not found');
    if (enforce && !can(principal, 'administer', node, { chain: await ancestorsOf(s) })) return deny('forbidden');
    await store.delete(s);
    announce('delete', { slug: s });
    return { ok: true, slug: s };
  }

  async function invite({ slug, principal, who, role = 'member' } = {}) {
    if (!who) return deny('who required');
    const s = normalizeSlug(slug);
    await ensureNode(s);
    const node = await store.get(s);
    if (!node) return deny('not found');
    if (enforce && !can(principal, 'invite', node, { chain: await ancestorsOf(s) })) return deny('forbidden');
    node.members = [...(node.members ?? []).filter((m) => m.who !== who), { who, role }];
    node.updatedAt = Date.now();
    await store.put(node);
    announce('invite', { slug: s, node, who, role });
    return { ok: true, node };
  }

  // Rename/relocate a node and its whole subtree. Slugs are addresses, ids are
  // stable — descendants keep their identity, their slugs are rewritten. Not
  // atomic across the subtree (adapters may later provide a native move).
  async function move({ slug, to, principal } = {}) {
    const s = normalizeSlug(slug);
    const d = normalizeSlug(to ?? '');
    if (s === '/' || isRoot(s)) return deny('cannot move a root area');
    if (!isValidSlug(d) || d === '/') return deny(`invalid destination: ${d}`);
    if (isRoot(d)) return deny('destination cannot be a root area (roots are claimed)');
    if (d === s || isDescendantOf(d, s)) return deny('cannot move a node into itself');
    await ensureNode(s);
    const node = await store.get(s);
    if (!node) return deny('not found');
    await ensureNode(d);
    if (await store.get(d)) return deny('destination already exists');
    const destParent = await store.get(parentSlug(d));
    if (!destParent) return deny(`destination parent does not exist: ${parentSlug(d)}`);
    if (enforce) {
      if (!can(principal, 'administer', node, { chain: await ancestorsOf(s) })) return deny('forbidden');
      if (!can(principal, 'create-child', destParent, { chain: await ancestorsOf(destParent.slug) })) return deny('forbidden');
    }
    const subtree = (await store.all()).filter((n) => n.slug === s || n.slug.startsWith(s + '/'));
    for (const n of subtree) {
      await store.delete(n.slug);
      n.slug = d + n.slug.slice(s.length);
      n.updatedAt = Date.now();
      await store.put(n);
    }
    const moved = await store.get(d);
    announce('move', { slug: d, from: s, node: moved });
    return { ok: true, node: moved, from: s };
  }

  // Bootstrap/admin: eagerly hydrate the whole manifest tree — the same reader
  // and the same ingest as lazy loading, just walked to exhaustion. NOT exposed
  // as a command: seeding sets owner/policy directly and loads code, so it
  // belongs to the process that owns the store, not to remote callers.
  async function seed({ dir } = {}) {
    const root = dir ?? manifestRoot;
    if (!root && !resolveManifest) return deny('dir required (or configure manifestRoot)');
    const stats = { hydrated: 0, pointers: 0 };
    async function walk(slug) {
      const node = await hydrate(slug, root);
      if (!node?.hydrated) {
        if (node) stats.pointers++; // declared leaf with no manifest of its own
        return;
      }
      stats.hydrated++;
      for (const kid of await store.children(slug)) {
        if (!kid.hydrated) await walk(kid.slug);
      }
    }
    await walk('/');
    (logger.info ?? logger.log)?.(`[filespace] seed: ${stats.hydrated} area(s) hydrated, ${stats.pointers} pointer leaf/leaves`);
    return { ok: true, ...stats };
  }

  // --- reads: hydrate on demand, then privacy-gate by the resolved reader ---

  async function get(slug, reader = null) {
    await ensureNode(slug);
    const node = await store.get(slug);
    if (!node) return null;
    // return null (not a 403) when hidden, so existence itself doesn't leak
    return (await readable(reader, node)) ? node : null;
  }

  async function list(slug, reader = null) {
    const s = normalizeSlug(slug);
    await ensureChildren(s);
    const kids = await store.children(s);
    if (!kids.length) return [];
    const self = await store.get(s);
    const chain = [self, ...(await ancestorsOf(s))].filter(Boolean); // shared by every child
    return kids.filter((k) => canRead(reader, k, chain));
  }

  // find is a GLOBAL query — it can only see what's been hydrated. Lazy loading
  // deliberately doesn't fetch the whole tree to answer it; a server keeping a
  // complete index is the place for cross-cutting search.
  async function find({ component, prefix, selector, member } = {}, reader = null) {
    const matches = member
      ? await store.byMember(member)
      : component
        ? await store.byComponent(component, { prefix })
        : await store.query(selector ?? {});
    const chains = new Map(); // siblings share ancestors — memoize per parent
    const out = [];
    for (const n of matches) {
      const p = parentSlug(n.slug);
      if (!chains.has(p)) chains.set(p, await ancestorsOf(n.slug));
      if (canRead(reader, n, chains.get(p))) out.push(n);
    }
    return out;
  }

  // `seed` is deliberately absent: it is an admin/in-process API, not a command.
  const WRITE_OPS = { claim, create, update, set_policy: setPolicy, delete: remove, invite, move };

  // --- the two boundary entry points ---

  // command: authenticate, then run a write op. Authorization happens inside each op.
  async function command(req = {}) {
    const a = guard ? guard(req) : { ok: true };
    if (!a.ok) return deny(a.error);
    const { op, auth, ...params } = req;
    const fn = WRITE_OPS[op];
    if (!fn) return deny(`unknown command: ${op}`);
    return fn(params);
  }

  // query: resolve the reader, then run a read op, privacy-filtered. An absent
  // identity reads as an anonymous guest; a PRESENT-but-invalid proof fails
  // loudly — silently downgrading a bad signature to "guest" would make private
  // data vanish with no explanation (clock skew, replay, tampering all deserve
  // an error, not an empty listing).
  async function query(req = {}) {
    const { op, auth, principal, ...params } = req ?? {};
    let reader = null;
    if (principal) {
      if (authenticate) {
        const a = guard(req);
        if (!a.ok) return deny(a.error);
      }
      reader = principal;
    }
    if (op === 'get') return get(params.slug, reader);
    if (op === 'list') return list(params.slug, reader);
    if (op === 'find') return find(params, reader);
    return null;
  }

  return {
    query,
    command,
    ingest,
    hydrate,
    bindBus: (b) => { bus = b; },
    // granular methods, for in-process/admin callers (authorization only)
    claim, create, update, setPolicy, remove, invite, move, seed,
    get, list, find,
    roleOf,
    ancestorsOf,
  };
}

// Build the bus entity. createFilespace does not import the bus — it receives it
// at dispatch time, so the same code is testable against a stub or the real bus.
export function createFilespace({ store, enforce = true, authenticate = false, verify, now, manifestRoot = null, resolveManifest = null } = {}) {
  if (!store) throw new Error('createFilespace requires a store');
  const service = makeService(store, { enforce, authenticate, verify, now, manifestRoot, resolveManifest });

  const entity = {
    id: 'bus.filespace',
    resolve(event, bus) {
      if (event.registered) {
        bus.install?.('filespace', service);
        service.bindBus(bus); // so hydrate() can drive the loader and writes can announce
        bus.resolve?.({ schema: SCHEMA });
        return;
      }
      const req = event.filespace;
      if (!req || typeof req !== 'object') return undefined;
      if ('query' in req) return service.query(req.query);
      if ('command' in req) return service.command(req.command);
      if ('seed' in req) return service.ingest(req.seed); // entities streaming from a manifest
      return undefined; // 'changed' announcements fall through to other observers
    },
  };

  return { entity, service };
}

// Convenience: register filespace on a bus and return the service.
export function attach(bus, opts = {}) {
  const { entity, service } = createFilespace(opts);
  bus.register(entity);
  return service;
}
