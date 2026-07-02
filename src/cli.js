// cli — a single npm-accessible tool to exercise a filespace end to end.
//
// It runs the core with real security on by default (enforce + authenticate), and
// carries a local keyring so you can act AS named users: `--as alice` loads
// alice's retained keypair and signs the action for her. This is the "hosted
// keypair" convenience for testing — in production users hold their own keys.
//
// Stores (kept out of git):
//   FILESPACE_DB       node store            default ./.filespace/nodes.json
//   FILESPACE_KEYRING  retained keypairs     default ./.filespace/keyring.json
//
// Global flags: --as <user>, --policy <p>, --role <r>, --json <components>,
//               --prefix <slug>, --insecure (disable enforce+authenticate)
//
// Run `filespace help` for the full command list.

import { createBus } from '@orbitalfoundation/bus';
import { join, dirname } from 'node:path';
import { rmSync, mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { attach } from './filespace.js';
import { makeFileStore } from './store/file.js';
import { makeMemoryStore } from './store/memory.js';
import { makeKeyring } from './keyring.js';
import { signAction, fsCommand, fsQuery } from './auth.js';
import { newIdentity } from './identity.js';

const USAGE = `filespace — exercise a multiuser shared filespace

users (local test keyring — holds keypairs so the CLI can sign as them):
  user new <name>                 generate + retain a keypair for <name>
  user list                       list known test users and their pubkeys
  user show <name>                show one user's public key
  user rm <name>                  forget a user

areas & folders (writes require --as <user>):
  claim <slug> --as <u> [--policy p]    claim a root area, first-come
  mkdir <slug> --as <u> [--policy p]    create a sub-folder / content node
  policy <slug> <public|protected|private> --as <u>   set privacy
  set <slug> --as <u> --json '<obj>'    merge components onto a node ("x": null deletes x)
  mv <slug> <to> --as <u>               move/rename a node and its subtree
  invite <slug> <user> --as <u> [--role member|owner]  grant membership
  rm <slug> --as <u>                    delete a node

enumerate (reads; pass --as <u> to see private areas you belong to):
  ls [slug] [--as <u>]            list children (privacy-filtered)
  get <slug> [--as <u>]           show one node
  find <component> [--prefix s] [--as <u>]   find nodes carrying a component

admin / misc:
  seed [dir]                      eagerly hydrate a manifest tree (default ./public)
  dump                            raw store, ignoring privacy (debug)
  nuke --yes [--keys]             wipe the node store (and keyring with --keys)
  demo                            run a scripted end-to-end scenario
  lazydemo                        watch areas hydrate on demand (lazy loading)
  help

policies: public (guests read; posting is for the streams layer) ·
          protected (guests read) · private (members only)
guests are read-only: mutating a node always requires membership.
reads hydrate lazily from ./public (or FILESPACE_PUBLIC) when present.`;

function parseArgs(argv) {
  const args = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) opts[key] = true;
      else opts[key] = argv[++i];
    } else {
      args.push(a);
    }
  }
  return { args, opts };
}

const out = (v) => console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2));
const short = (pk) => (pk ? `${pk.slice(0, 10)}…` : '—');

// Reverse-map a pubkey to a friendly keyring name for readable output.
function namer(keyring) {
  const byKey = new Map(keyring.list().map((u) => [u.publicKey, u.name]));
  return (pk) => byKey.get(pk) ?? short(pk);
}

function fmtNode(n, name) {
  const label = n.components?.about?.label ?? '';
  return `${n.slug.padEnd(28)} [${(n.policy ?? '').padEnd(9)}] ${String(label).padEnd(20)} owner:${name(n.owner)}`;
}

// Send a write through the bus as { filespace: { command } }, signed as
// `identity` when present (unsigned only works in --insecure mode).
async function act(bus, op, args, identity) {
  const command = identity ? signAction(identity, op, args) : { op, ...args };
  return bus.resolve({ filespace: { command } });
}

export async function run(argv = process.argv.slice(2)) {
  const { args, opts } = parseArgs(argv);
  const [cmd, ...rest] = args;

  if (!cmd || cmd === 'help' || opts.help) return out(USAGE);
  if (cmd === 'demo') return demo();
  if (cmd === 'lazydemo') return lazydemo();

  const dbPath = process.env.FILESPACE_DB || join(process.cwd(), '.filespace', 'nodes.json');
  const keyringPath = process.env.FILESPACE_KEYRING || join(dirname(dbPath), 'keyring.json');
  const keyring = makeKeyring(keyringPath);

  // --- user management (no bus needed) ---
  if (cmd === 'user') {
    const [sub, name] = rest;
    if (sub === 'new') {
      if (!name) return out('usage: user new <name>');
      try {
        const id = keyring.create(name);
        return out({ name, publicKey: id.publicKey });
      } catch (err) {
        return out({ error: err.message });
      }
    }
    if (sub === 'list') return out(keyring.list());
    if (sub === 'show') return out(keyring.publicKeyOf(name) ?? '(unknown user)');
    if (sub === 'rm') return out({ removed: keyring.remove(name) });
    return out('usage: user <new|list|show|rm> <name>');
  }

  if (cmd === 'nuke') {
    if (!opts.yes) return out('refusing to nuke without --yes');
    rmSync(dbPath, { force: true });
    if (opts.keys) rmSync(keyringPath, { force: true });
    return out(`erased ${dbPath}${opts.keys ? ' + keyring' : ''}`);
  }

  const store = makeFileStore(dbPath);
  const secure = !opts.insecure;
  const bus = createBus({ description: 'filespace-cli' });
  const publicDir = process.env.FILESPACE_PUBLIC || (existsSync(join(process.cwd(), 'public')) ? join(process.cwd(), 'public') : null);
  const fs = attach(bus, { store, enforce: secure, authenticate: secure, manifestRoot: publicDir });
  const name = namer(keyring);

  // Resolve --as <user> to a signing identity (required for writes in secure mode).
  const actorName = opts.as;
  const actor = actorName ? keyring.identity(actorName) : null;
  if (actorName && !actor) return out(`unknown user: ${actorName} (try: user new ${actorName})`);
  const needActor = () => {
    if (secure && !actor) throw new Error(`this action needs --as <user> (secure mode). Users: ${keyring.list().map((u) => u.name).join(', ') || '(none)'}`);
  };

  try {
    switch (cmd) {
      case 'claim':
        needActor();
        return out(await act(bus, 'claim', { slug: rest[0], ...(opts.policy && { policy: opts.policy }) }, actor));
      case 'mkdir':
        needActor();
        return out(await act(bus, 'create', { slug: rest[0], ...(opts.policy && { policy: opts.policy }) }, actor));
      case 'policy':
        needActor();
        return out(await act(bus, 'set_policy', { slug: rest[0], policy: rest[1] }, actor));
      case 'set': {
        needActor();
        const components = opts.json ? JSON.parse(opts.json) : {};
        return out(await act(bus, 'update', { slug: rest[0], components }, actor));
      }
      case 'invite': {
        needActor();
        const who = keyring.publicKeyOf(rest[1]) ?? rest[1]; // name → pubkey, or raw pubkey
        return out(await act(bus, 'invite', { slug: rest[0], who, ...(opts.role && { role: opts.role }) }, actor));
      }
      case 'mv':
        needActor();
        return out(await act(bus, 'move', { slug: rest[0], to: rest[1] }, actor));
      case 'rm':
        needActor();
        return out(await act(bus, 'delete', { slug: rest[0] }, actor));

      case 'ls': {
        const nodes = await readAs(bus, 'list', { slug: rest[0] || '/' }, actor);
        return out(nodes.length ? nodes.map((n) => fmtNode(n, name)).join('\n') : '(empty or not visible)');
      }
      case 'get': {
        const node = await readAs(bus, 'get', { slug: rest[0] }, actor);
        return out(node ?? '(not found or not visible)');
      }
      case 'find': {
        const nodes = await readAs(bus, 'find', { component: rest[0], ...(opts.prefix && opts.prefix !== true && { prefix: opts.prefix }) }, actor);
        return out(nodes.length ? nodes.map((n) => fmtNode(n, name)).join('\n') : '(none visible)');
      }

      case 'seed':
        return out(await fs.seed(rest[0] ? { dir: rest[0] } : {}));
      case 'dump':
        return out((await store.all()).map((n) => fmtNode(n, name)).join('\n') || '(empty)');

      default:
        out(`unknown command: ${cmd}\n\n${USAGE}`);
        process.exitCode = 1;
    }
  } catch (err) {
    out({ error: err.message });
    process.exitCode = 1;
  }
}

// A read via { filespace: { query } }, signed as the actor when one is given (so
// private areas they belong to become visible); anonymous otherwise. A present-
// but-invalid proof is an error, not a silent downgrade to guest.
async function readAs(bus, op, args, actor) {
  const res = await bus.resolve(fsQuery(op, args, actor));
  if (res && res.ok === false) throw new Error(res.error);
  return res;
}

// A scripted scenario that exercises every operation, on a throwaway in-memory
// store, so `filespace demo` shows the whole model working with real signatures.
async function demo() {
  const store = makeMemoryStore();
  const bus = createBus({ description: 'filespace-demo' });
  attach(bus, { store, enforce: true, authenticate: true });
  // every successful write is announced on the bus — anyone can watch
  bus.register({
    id: 'demo.watcher',
    resolve(e) {
      const c = e?.filespace?.changed;
      if (c) console.log(`      📣 changed: ${c.op} ${c.slug ?? ''}`);
    },
  });
  const alice = newIdentity();
  const bob = newIdentity();
  const eve = newIdentity();
  const name = (pk) => (pk === alice.publicKey ? 'alice' : pk === bob.publicKey ? 'bob' : pk === eve.publicKey ? 'eve' : short(pk));
  const step = (t) => console.log(`\n• ${t}`);
  const line = (l, r) => console.log(`    ${l.padEnd(46)} ${r.ok === false ? `DENIED (${r.error})` : 'ok'}`);
  const show = (nodes) => console.log(nodes.length ? nodes.map((n) => '    ' + fmtNode(n, name)).join('\n') : '    (nothing visible)');

  step('alice claims /alice as a PRIVATE area, adds a secret folder');
  line('alice claims /alice (private)', await bus.resolve(fsCommand(alice, 'claim', { slug: '/alice', policy: 'private' })));
  line('alice mkdir /alice/secret', await bus.resolve(fsCommand(alice, 'create', { slug: '/alice/secret' })));

  step('bob claims /bob as PUBLIC, drops a note anyone can post to');
  line('bob claims /bob (public)', await bus.resolve(fsCommand(bob, 'claim', { slug: '/bob', policy: 'public' })));
  line('bob mkdir /bob/notes', await bus.resolve(fsCommand(bob, 'create', { slug: '/bob/notes' })));

  step("guest lists / — sees /bob but NOT alice's private area");
  show(await bus.resolve(fsQuery('list', { slug: '/' })));

  step('guest tries to read /alice — hidden');
  console.log('    get /alice →', await bus.resolve(fsQuery('get', { slug: '/alice' })));

  step('eve (signed) still cannot see /alice — not a member');
  console.log('    get /alice as eve →', await bus.resolve(fsQuery('get', { slug: '/alice' }, eve)));

  step('alice invites bob into /alice; bob can now see it');
  line('alice invites bob', await bus.resolve(fsCommand(alice, 'invite', { slug: '/alice', who: bob.publicKey })));
  console.log('    /alice children as bob →');
  show(await bus.resolve(fsQuery('list', { slug: '/alice' }, bob)));

  step('eve tries to deface public /bob/notes (denied — guests are read-only); and to delete it (denied)');
  line('eve set /bob/notes content', await bus.resolve(fsCommand(eve, 'update', { slug: '/bob/notes', components: { about: { label: 'eve was here' } } })));
  line('eve deletes /bob/notes', await bus.resolve(fsCommand(eve, 'delete', { slug: '/bob/notes' })));

  step('bob, invited into /alice, can post content there — and owns what he makes');
  line('bob mkdir /alice/secret/from-bob', await bus.resolve(fsCommand(bob, 'create', { slug: '/alice/secret/from-bob' })));
  console.log('    /alice/secret children as bob →');
  show(await bus.resolve(fsQuery('list', { slug: '/alice/secret' }, bob)));

  step('alice renames her folder: mv /alice/secret → /alice/vault (the subtree moves)');
  line('alice mv /alice/secret /alice/vault', await bus.resolve(fsCommand(alice, 'move', { slug: '/alice/secret', to: '/alice/vault' })));
  show(await bus.resolve(fsQuery('list', { slug: '/alice/vault' }, alice)));

  step('bob flips /bob to protected; guests can still read, not write');
  line('bob policy /bob protected', await bus.resolve(fsCommand(bob, 'set_policy', { slug: '/bob', policy: 'protected' })));
  line('guest writes to /bob (should deny)', await bus.resolve({ filespace: { command: { op: 'update', slug: '/bob', principal: 'nobody', components: { x: 1 } } } }));

  console.log('\ndemo complete — every line above exercised auth, policy, privacy, or change events.');
}

// Watch lazy loading: a throwaway public/ tree of .js manifests, hydrated on
// demand. Each '↳ load' line is filespace telling the bus to fetch a manifest —
// note there's exactly one per area, on first visit, and none on repeats.
async function lazydemo() {
  const root = join(mkdtempSync(join(tmpdir(), 'filespace-lazydemo-')), 'public');
  mkdirSync(join(root, 'drwobbles', 'library'), { recursive: true });
  const M = (entities) => entities.map((e, i) => `export const e${i} = { filespace: { seed: ${JSON.stringify(e)} } };`).join('\n');
  writeFileSync(join(root, 'info.js'), M([
    { slug: '/', hydrated: true, components: { about: { label: 'Home' } } },
    { slug: '/drwobbles', hydrated: false, components: { about: { label: 'Dr. Wobbles' } } },
  ]));
  writeFileSync(join(root, 'drwobbles', 'info.js'), M([
    { slug: '/drwobbles', hydrated: true, components: { about: { label: 'Dr. Wobbles' } } },
    { slug: '/drwobbles/playground', hydrated: true, components: { about: { label: 'Playground' }, geo: { ll: [-16.25, 28.46, 0] } } },
    { slug: '/drwobbles/library', hydrated: false, components: { about: { label: 'Library' } } },
  ]));
  writeFileSync(join(root, 'drwobbles', 'library', 'info.js'), M([
    { slug: '/drwobbles/library', hydrated: true, components: { about: { label: 'Library' } } },
    { slug: '/drwobbles/library/orbital', hydrated: true, components: { about: { label: 'Orbital' }, link: { href: 'https://example.org' } } },
  ]));

  const bus = createBus({ description: 'filespace-lazydemo' });
  const orig = bus.resolve.bind(bus);
  bus.resolve = (e) => {
    if (e && typeof e === 'object' && e.load) console.log(`      ↳ load ${String(e.load).replace(/^.*\/public\//, 'public/')}`);
    return orig(e);
  };
  const fs = attach(bus, { store: makeMemoryStore(), enforce: false, manifestRoot: root });

  const nm = (pk) => short(pk);
  const step = (t) => console.log(`\n• ${t}`);
  const show = (nodes) => console.log(nodes.length ? nodes.map((n) => '    ' + fmtNode(n, nm) + (n.hydrated ? '' : '   ~pointer')).join('\n') : '    (nothing)');

  step('boot: nothing scanned. list / → fetches only the root manifest');
  show(await fs.list('/'));
  step('enter /drwobbles → fetches its manifest (one load)');
  show(await fs.list('/drwobbles'));
  step('re-list /drwobbles → cache hit, no load');
  show(await fs.list('/drwobbles'));
  step('enter /drwobbles/library → fetches its manifest');
  show(await fs.list('/drwobbles/library'));
  step('list /drwobbles/nope → undeclared by its parent, so the filesystem is never probed');
  await fs.list('/drwobbles/nope');
  await fs.list('/drwobbles/nope');
  step('global find(geo) → only what has been hydrated so far');
  show(await fs.find({ component: 'geo' }));

  rmSync(dirname(root), { recursive: true, force: true });
  console.log('\nlazydemo complete — one load per area on first visit, none on repeats.');
}
