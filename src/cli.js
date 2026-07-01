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
import { rmSync } from 'node:fs';
import { attach } from './filespace.js';
import { makeFileStore } from './store/file.js';
import { makeMemoryStore } from './store/memory.js';
import { makeKeyring } from './keyring.js';
import { signAction } from './auth.js';
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
  set <slug> --as <u> --json '<obj>'    merge components (content) onto a node
  invite <slug> <user> --as <u> [--role member|owner]  grant membership
  rm <slug> --as <u>                    delete a node

enumerate (reads; pass --as <u> to see private areas you belong to):
  ls [slug] [--as <u>]            list children (privacy-filtered)
  get <slug> [--as <u>]           show one node
  find <component> [--prefix s] [--as <u>]   find nodes carrying a component

admin / misc:
  seed <dir>                      load a public/ manifest tree
  dump                            raw store, ignoring privacy (debug)
  nuke --yes [--keys]             wipe the node store (and keyring with --keys)
  demo                            run a scripted end-to-end scenario
  help

policies: public (guest read+post) · protected (guest read only) · private (members only)`;

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

// Send an action through the bus, signing it as `identity` when present.
async function act(bus, key, op, args, identity) {
  const payload = identity ? signAction(identity, op, args) : args;
  return bus.resolve({ [key]: payload });
}

export async function run(argv = process.argv.slice(2)) {
  const { args, opts } = parseArgs(argv);
  const [cmd, ...rest] = args;

  if (!cmd || cmd === 'help' || opts.help) return out(USAGE);
  if (cmd === 'demo') return demo();

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
  const fs = attach(bus, { store, enforce: secure, authenticate: secure });
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
        return out(await act(bus, 'fs_claim', 'fs_claim', { slug: rest[0], principal: actor?.publicKey, ...(opts.policy && { policy: opts.policy }) }, actor));
      case 'mkdir':
        needActor();
        return out(await act(bus, 'fs_create', 'fs_create', { slug: rest[0], principal: actor?.publicKey, ...(opts.policy && { policy: opts.policy }) }, actor));
      case 'policy':
        needActor();
        return out(await act(bus, 'fs_set_policy', 'fs_set_policy', { slug: rest[0], principal: actor?.publicKey, policy: rest[1] }, actor));
      case 'set': {
        needActor();
        const components = opts.json ? JSON.parse(opts.json) : {};
        return out(await act(bus, 'fs_update', 'fs_update', { slug: rest[0], principal: actor?.publicKey, components }, actor));
      }
      case 'invite': {
        needActor();
        const who = keyring.publicKeyOf(rest[1]) ?? rest[1]; // name → pubkey, or raw pubkey
        return out(await act(bus, 'fs_invite', 'fs_invite', { slug: rest[0], principal: actor?.publicKey, who, ...(opts.role && { role: opts.role }) }, actor));
      }
      case 'rm':
        needActor();
        return out(await act(bus, 'fs_delete', 'fs_delete', { slug: rest[0], principal: actor?.publicKey }, actor));

      case 'ls': {
        const nodes = await readAs(bus, 'fs_list_query', { slug: rest[0] || '/' }, actor);
        return out(nodes.length ? nodes.map((n) => fmtNode(n, name)).join('\n') : '(empty or not visible)');
      }
      case 'get': {
        const node = await readAs(bus, 'fs_get_query', { slug: rest[0] }, actor);
        return out(node ?? '(not found or not visible)');
      }
      case 'find': {
        const nodes = await readAs(bus, 'fs_find_query', { component: rest[0], ...(opts.prefix && opts.prefix !== true && { prefix: opts.prefix }) }, actor);
        return out(nodes.length ? nodes.map((n) => fmtNode(n, name)).join('\n') : '(none visible)');
      }

      case 'seed':
        return out(await fs.seed({ dir: rest[0] }));
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

// A read, signed as the actor when one is given (so private areas they belong to
// become visible); anonymous otherwise.
function readAs(bus, key, args, actor) {
  const op = key;
  const payload = actor ? signAction(actor, op, { ...args, principal: actor.publicKey }) : args;
  return bus.resolve({ [key]: payload });
}

// A scripted scenario that exercises every operation, on a throwaway in-memory
// store, so `filespace demo` shows the whole model working with real signatures.
async function demo() {
  const store = makeMemoryStore();
  const bus = createBus({ description: 'filespace-demo' });
  attach(bus, { store, enforce: true, authenticate: true });
  const alice = newIdentity();
  const bob = newIdentity();
  const eve = newIdentity();
  const name = (pk) => (pk === alice.publicKey ? 'alice' : pk === bob.publicKey ? 'bob' : pk === eve.publicKey ? 'eve' : short(pk));
  const step = (t) => console.log(`\n• ${t}`);
  const line = (l, r) => console.log(`    ${l.padEnd(46)} ${r.ok === false ? `DENIED (${r.error})` : 'ok'}`);
  const show = (nodes) => console.log(nodes.length ? nodes.map((n) => '    ' + fmtNode(n, name)).join('\n') : '    (nothing visible)');

  step('alice claims /alice as a PRIVATE area, adds a secret folder');
  line('alice claims /alice (private)', await bus.resolve({ fs_claim: signAction(alice, 'fs_claim', { slug: '/alice', policy: 'private' }) }));
  line('alice mkdir /alice/secret', await bus.resolve({ fs_create: signAction(alice, 'fs_create', { slug: '/alice/secret' }) }));

  step('bob claims /bob as PUBLIC, drops a note anyone can post to');
  line('bob claims /bob (public)', await bus.resolve({ fs_claim: signAction(bob, 'fs_claim', { slug: '/bob', policy: 'public' }) }));
  line('bob mkdir /bob/notes', await bus.resolve({ fs_create: signAction(bob, 'fs_create', { slug: '/bob/notes' }) }));

  step("guest lists / — sees /bob but NOT alice's private area");
  show(await bus.resolve({ fs_list_query: { slug: '/' } }));

  step('guest tries to read /alice — hidden');
  console.log('    get /alice →', await bus.resolve({ fs_get_query: { slug: '/alice' } }));

  step('eve (signed) still cannot see /alice — not a member');
  console.log('    get /alice as eve →', await bus.resolve({ fs_get_query: signAction(eve, 'fs_get_query', { slug: '/alice' }) }));

  step('alice invites bob into /alice; bob can now see it');
  line('alice invites bob', await bus.resolve({ fs_invite: signAction(alice, 'fs_invite', { slug: '/alice', who: bob.publicKey }) }));
  console.log('    /alice children as bob →');
  show(await bus.resolve({ fs_list_query: signAction(bob, 'fs_list_query', { slug: '/alice' }) }));

  step('eve posts to public /bob/notes (allowed); tries to delete it (denied)');
  line('eve set /bob/notes content', await bus.resolve({ fs_update: signAction(eve, 'fs_update', { slug: '/bob/notes', components: { about: { label: 'eve was here' } } }) }));
  line('eve deletes /bob/notes', await bus.resolve({ fs_delete: signAction(eve, 'fs_delete', { slug: '/bob/notes' }) }));

  step('bob flips /bob to protected; guests can still read, not post');
  line('bob policy /bob protected', await bus.resolve({ fs_set_policy: signAction(bob, 'fs_set_policy', { slug: '/bob', policy: 'protected' }) }));
  line('guest posts to /bob (should deny)', await bus.resolve({ fs_update: { slug: '/bob', principal: 'nobody', components: { x: 1 } } }));

  console.log('\ndemo complete — every line above exercised auth, policy, or privacy.');
}
