// filespace — the namespace service, exposed as a single listener on the bus.
//
// It is "just another bus listener": register the entity and the bus gains a
// filespace. Reads are *_query keys (first-responder returns the value); writes
// are action keys that carry a `principal`. The same methods are installed as
// bus.filespace for direct calls (mirroring bus.spatial / bus.db), and the CLI
// drives them with no server in sight.
//
// Authorization lives here because folder policy is a filespace concern. Every
// action takes a `principal` — the *server-verified* identity. The edge gateway
// is responsible for stamping it; filespace must never trust a principal a raw
// client supplied. With `enforce: false`, policy checks are skipped (the
// "allow-all" posture for early development) while everything else still works.

import logger from '@orbitalfoundation/utils';

import { makeNode } from './node.js';
import { can, canRead, roleOf } from './policy.js';
import { seedDir } from './seed.js';
import { makeAuthGuard } from './auth.js';
import { normalizeSlug, parentSlug, rootSlug, isRoot } from './paths.js';

const SCHEMA = {
  fs_get_query: true,
  fs_list_query: true,
  fs_find_query: true,
  fs_claim: true,
  fs_create: true,
  fs_update: true,
  fs_delete: true,
  fs_invite: true,
  fs_set_policy: true,
  fs_seed: true,
};

const deny = (error) => ({ ok: false, error });

export function makeService(store, { enforce = true, authenticate = false, verify, now } = {}) {
  // When `authenticate` is on, every write must carry a valid signed envelope
  // proving the caller holds the private key for the principal it claims. The
  // guard is the bouncer; it runs before any authorization check.
  const guard = authenticate ? makeAuthGuard({ verify, now }) : null;
  const authed = (op, args) => (guard ? guard(op, args) : { ok: true });

  // The root area that governs a slug, used for inherited ownership/membership.
  async function governingArea(slug) {
    const root = rootSlug(slug);
    if (root === normalizeSlug(slug)) return null;
    return (await store.get(root)) ?? null;
  }

  // Establish who the reader is. A caller is only granted an identity on a read if
  // they prove it (signed envelope, when authenticate is on); an unsigned or
  // invalid identity claim is silently downgraded to an anonymous guest — never an
  // error, so public browsing stays open while private access requires proof.
  function readerOf(op, args) {
    const principal = args?.principal ?? null;
    if (!principal) return null;
    if (!authenticate) return principal;
    return guard(op, args).ok ? principal : null;
  }

  const readable = async (reader, node) =>
    canRead(reader, node, await governingArea(node.slug));

  return {
    // ---- reads (privacy-gated) ----
    async get(arg) {
      const args = typeof arg === 'string' ? { slug: arg } : (arg ?? {});
      const node = await store.get(args.slug);
      if (!node) return null;
      // return null (not a 403) when hidden, so existence itself doesn't leak
      return (await readable(readerOf('fs_get_query', args), node)) ? node : null;
    },
    async list(arg) {
      const args = typeof arg === 'string' ? { slug: arg } : (arg ?? {});
      const reader = readerOf('fs_list_query', args);
      const kids = await store.children(args.slug);
      const out = [];
      for (const k of kids) if (await readable(reader, k)) out.push(k);
      return out;
    },
    async find(args = {}) {
      const reader = readerOf('fs_find_query', args);
      const matches = args.component
        ? await store.byComponent(args.component, { prefix: args.prefix })
        : await store.query(args.selector ?? {});
      const out = [];
      for (const n of matches) if (await readable(reader, n)) out.push(n);
      return out;
    },

    // ---- writes ----

    // Claim a root area first-come. Succeeds only if the slug is free.
    async claim(args = {}) {
      const a = authed('fs_claim', args);
      if (!a.ok) return deny(a.error);
      const { slug, principal, policy = 'public', components = {} } = args;
      if (!principal) return deny('principal required');
      if (!isRoot(slug)) return deny('claim is for root areas only (single path segment)');
      const node = makeNode({
        slug,
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
      return { ok: true, node };
    },

    // Create a folder or content item inside an existing parent.
    async create(args = {}) {
      const a = authed('fs_create', args);
      if (!a.ok) return deny(a.error);
      const { slug, principal, policy, components = {} } = args;
      const s = normalizeSlug(slug);
      if (isRoot(s)) return deny('use claim for root areas');
      const parent = await store.get(parentSlug(s));
      if (!parent) return deny(`parent does not exist: ${parentSlug(s)}`);
      const area = await store.get(rootSlug(s));
      if (enforce && !can(principal, 'create-child', parent, { area })) return deny('forbidden');
      if (await store.get(s)) return deny('already exists');
      const node = makeNode({
        slug: s,
        owner: area?.owner ?? principal ?? null,
        policy: policy ?? parent.policy ?? 'public',
        components,
        origin: 'runtime',
      });
      await store.put(node);
      return { ok: true, node };
    },

    async update(args = {}) {
      const a = authed('fs_update', args);
      if (!a.ok) return deny(a.error);
      const { slug, principal, components = {} } = args;
      const node = await store.get(slug);
      if (!node) return deny('not found');
      const area = await governingArea(slug);
      if (enforce && !can(principal, 'post', node, { area })) return deny('forbidden');
      node.components = { ...node.components, ...components };
      node.updatedAt = Date.now();
      await store.put(node);
      return { ok: true, node };
    },

    async remove(args = {}) {
      const a = authed('fs_delete', args);
      if (!a.ok) return deny(a.error);
      const { slug, principal } = args;
      const node = await store.get(slug);
      if (!node) return deny('not found');
      const area = await governingArea(slug);
      if (enforce && !can(principal, 'administer', node, { area })) return deny('forbidden');
      await store.delete(slug);
      return { ok: true, slug: normalizeSlug(slug) };
    },

    async invite(args = {}) {
      const a = authed('fs_invite', args);
      if (!a.ok) return deny(a.error);
      const { slug, principal, who, role = 'member' } = args;
      if (!who) return deny('who required');
      const node = await store.get(slug);
      if (!node) return deny('not found');
      const area = await governingArea(slug);
      if (enforce && !can(principal, 'invite', node, { area })) return deny('forbidden');
      node.members = [...(node.members ?? []).filter((m) => m.who !== who), { who, role }];
      node.updatedAt = Date.now();
      await store.put(node);
      return { ok: true, node };
    },

    // Change a node's privacy. Distinct from update() (content) because changing
    // policy is an administer action — owner only.
    async setPolicy(args = {}) {
      const a = authed('fs_set_policy', args);
      if (!a.ok) return deny(a.error);
      const { slug, principal, policy } = args;
      if (!['public', 'protected', 'private'].includes(policy)) return deny('invalid policy');
      const node = await store.get(slug);
      if (!node) return deny('not found');
      const area = await governingArea(slug);
      if (enforce && !can(principal, 'administer', node, { area })) return deny('forbidden');
      node.policy = policy;
      node.updatedAt = Date.now();
      await store.put(node);
      return { ok: true, node };
    },

    // Bootstrap/admin: load a public/ tree of manifests into the store.
    async seed({ dir, basePath = '/' } = {}) {
      if (!dir) return deny('dir required');
      const stats = await seedDir(store, dir, { basePath, log: (m) => (logger.info ?? logger.log)?.(m) });
      return { ok: true, ...stats };
    },

    roleOf,
  };
}

// Build the bus entity. createFilespace does not import the bus — it receives it
// at dispatch time, so the same code is testable against a stub or the real bus.
export function createFilespace({ store, enforce = true, authenticate = false, verify, now } = {}) {
  if (!store) throw new Error('createFilespace requires a store');
  const service = makeService(store, { enforce, authenticate, verify, now });

  const entity = {
    id: 'bus.filespace',
    resolve(event, bus) {
      if (event.registered) {
        bus.install?.('filespace', service);
        bus.resolve?.({ schema: SCHEMA });
        return;
      }
      if (event.fs_get_query) return service.get(event.fs_get_query);
      if (event.fs_list_query) return service.list(event.fs_list_query);
      if (event.fs_find_query) return service.find(event.fs_find_query);
      if (event.fs_claim) return service.claim(event.fs_claim);
      if (event.fs_create) return service.create(event.fs_create);
      if (event.fs_update) return service.update(event.fs_update);
      if (event.fs_delete) return service.remove(event.fs_delete);
      if (event.fs_invite) return service.invite(event.fs_invite);
      if (event.fs_set_policy) return service.setPolicy(event.fs_set_policy);
      if (event.fs_seed) return service.seed(event.fs_seed);
      return undefined;
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
