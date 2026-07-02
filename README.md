# @orbitalfoundation/filespace

A multiuser, identity-owned, path-addressed **shared filespace** — implemented as a single listener on the [orbital bus](https://www.npmjs.com/package/@orbitalfoundation/bus).

Intended for use as a low level substrate for collaborative apps; a namespace of folders where roots are claimed first-come, ownership is keyed to a public key, and every folder can be public, protected, or private with invited members. The focus here is files, folders, ownership, membership and enumeration.

## Features

- A **path-addressed namespace.** A node lives at a slug like `/drwobbles/playground`.
  The first path segment is a "root area", handed out first-come to whoever claims it.
  Segments are validated (`[A-Za-z0-9][A-Za-z0-9._-]*` — no dot-segments), so a slug
  can never traverse outside the manifest root and garbage can't be squatted.
- **ECS-style nodes.** A node is `{ id, slug, owner, policy, members, components, origin }`.
  Folders and content are the same shape; the presence of a component (`about`,
  `geo`, `link`, `agent`, `chore`, `view`…) is what distinguishes them.
- **Identity by public key.** A `principal` is an opaque string — a readable handle
  or a secp256k1 public key (the curve web3auth / Ethereum wallets use). Users own
  what they sign; this package doesn't custody user data.
- **Real collaboration semantics.** Membership granted anywhere on a path applies
  to everything beneath it — invite a friend to `/anselm/project` and the whole
  project is shared, not just its top folder. Creators own what they make; the
  area owner still administers everything via the chain. Guests are read-only.
- **Change announcements.** Every successful write is announced on the bus as
  `{ filespace: { changed: { op, slug, node } } }` — live clients, agents and
  indexers react without polling.
- **Just a bus listener, one reserved key.** Register it and the bus gains a
  `filespace`. Everything goes through a single top-level key with a query/command
  split — `{ filespace: { query } }` (reads) and `{ filespace: { command } }`
  (writes) — so verbs nest inside a namespace filespace owns instead of crowding
  the shared bus root. The service is also installed as `bus.filespace` and driven
  by the CLI with no server in sight.
- **Pluggable persistence.** A tiny store interface (~7 methods) with `memory` and
  zero-dependency `file` adapters today; Mongo / NeDB / a separate
  `orbital-database` package slot in behind the same interface later. See
  [Persistence](#persistence-and-the-store-interface) below.


## Install

```sh
npm install @orbitalfoundation/filespace @orbitalfoundation/bus
```

## Use

```js
import { createBus } from '@orbitalfoundation/bus';
import { attach, makeFileStore } from '@orbitalfoundation/filespace';

const bus = createBus();
const fs  = attach(bus, { store: makeFileStore('.filespace/nodes.json'), enforce: true });

// admin seeds initial areas from a public/ manifest tree
await fs.seed({ dir: './public' });

// a user claims a root area, first-come — one key, a command inside
await bus.resolve({ filespace: { command: { op: 'claim', slug: '/macy', principal: macyPubKey } } });

// …and creates a folder inside it
await bus.resolve({ filespace: { command: { op: 'create', slug: '/macy/ces', principal: macyPubKey } } });

// reads are queries
const kids = await bus.resolve({ filespace: { query: { op: 'list', slug: '/macy' } } });
```

### Bus vocabulary — one key, everything nested

filespace reserves a single top-level key, `filespace`, and splits reads from
writes inside it (CQRS-style). A request is `{ op, ...params, auth? }`. This keeps
verbs out of the shared bus root and makes the read/write boundary visible to a
gateway (allow `query`, gate `command`).

Queries — `{ filespace: { query: { op, … } } }` — privacy-gated (see
[Permissions](#permissions)); pass `principal` + a signed envelope to see private
areas you belong to, else you read as an anonymous guest:

| op | params | returns |
|---|---|---|
| `get`  | `{ slug }` | the node, or `null` if hidden |
| `list` | `{ slug }` | direct children you may read |
| `find` | `{ component, prefix }`, `{ member }` or `{ selector }` | matching nodes you may read |

An **absent** identity reads as an anonymous guest. A **present-but-invalid**
proof (bad signature, expired, replayed) returns `{ ok: false, error }` — it is
never silently downgraded to guest, so private data doesn't just vanish when a
client has clock skew or a bug.

Commands — `{ filespace: { command: { op, …, principal, auth? } } }` — a signed
`auth` envelope is required when `authenticate` is on:

| op | params |
|---|---|
| `claim`      | `{ slug, principal, policy?, components? }` — claim a root area |
| `create`     | `{ slug, principal, policy?, components? }` — create a folder/content node |
| `update`     | `{ slug, principal, components }` — merge components (`"x": null` deletes `x`) |
| `move`       | `{ slug, to, principal }` — move/rename a node and its whole subtree |
| `set_policy` | `{ slug, principal, policy }` — change privacy (owner only) |
| `delete`     | `{ slug, principal }` |
| `invite`     | `{ slug, principal, who, role? }` |

`seed` is deliberately **not** a command: it loads manifests (code) and sets
`owner`/`policy` directly, so it belongs to the process that owns the store —
call `service.seed(...)` in-process, or use the CLI.

Helpers `fsCommand(identity, op, params)` and `fsQuery(op, params, identity?)`
build (and sign) these envelopes for you.

After every successful write, filespace announces
`{ filespace: { changed: { op, slug, node } } }` on the bus (fire-and-forget;
observers can't break a write). Slugs are addresses and may change (`move`);
`node.id` is the durable identity.

## Permissions

Each node carries `policy: public | protected | private` and a `members` list.
Roles (`owner`, `member`, `guest`) are computed from the node **and its whole
ancestor chain**, so membership granted anywhere on a path applies to everything
beneath it: invited to `/anselm/project`, you are a member of
`/anselm/project/photos` too — and you can have a private `/anselm/photos` next
to a protected `/anselm/projects/halloween` with invited friends.

| verb | owner | member | guest (public) | guest (protected) | guest (private) |
|---|---|---|---|---|---|
| read          | ✓ | ✓ | ✓ | ✓ | — |
| post *(streams layer, future)* | ✓ | ✓ | ✓ | — | — |
| update        | ✓ | ✓ | — | — | — |
| create-child  | ✓ | ✓ | — | — | — |
| invite        | ✓ | ✓ | — | — | — |
| administer    | ✓ | — | — | — | — |

**Guests are read-only.** Mutating a node (`update`, `create`, `move`, `delete`)
always requires membership — a public folder can't be defaced by passers-by.
`post` (contributing to a folder's message stream) is the one guest-writable
verb, on public nodes only; it is reserved for the streams layer that sits on
top of filespace.

**Creators own what they make.** A member creating inside a shared project owns
their node (they can update, move and delete it); the area owner still
administers everything beneath them through the chain.

`enforce: false` skips these checks (the "allow-all" posture for early
development). The rules live in [`src/policy.js`](src/policy.js) as pure functions.

**Reads are gated too, with inheritance.** A `private` node anywhere on the
chain hides everything beneath it from guests and non-members — `get` returns
`null` (existence doesn't leak) and `list`/`find` filter it out. Inviting a
member reveals the subtree to them. So `private` means *actually* private, not
merely unwritable.

## Authentication (in the core, not at a server)

`enforce` answers *may principal P do this?* — **authorization**. It still trusts
that the caller really is P. Turn on `authenticate` and filespace also answers
*is the caller really P?* — **authentication** — by verifying a signature, with no
server involved.

```js
import { attach, makeFileStore, newIdentity, fsCommand } from '@orbitalfoundation/filespace';

const fs = attach(bus, { store: makeFileStore('.filespace/nodes.json'), enforce: true, authenticate: true });

const macy = newIdentity();                       // a secp256k1 keypair (the web3auth curve)
await bus.resolve(fsCommand(macy, 'claim',  { slug: '/macy' }));
await bus.resolve(fsCommand(macy, 'create', { slug: '/macy/ces' }));
```

Each command carries a signed envelope `auth: { nonce, exp, sig }`. The signature
binds the **op + all params + nonce + exp**, and is verified against `principal`
(a public key). Therefore:

- **No private key, no action.** Passing `principal: <someone's pubkey>` without a
  signature is rejected — identity is *proven*, not asserted.
- **Tamper-evident.** Changing any arg after signing invalidates the signature.
- **Replay-resistant.** `nonce` is single-use and `exp` bounds lifetime; a captured
  envelope can't be resent.

This is deliberately below any server. Not every deployment is remote, and a
server should be a transport shim — not the bouncer. The `verify` function is
pluggable (default secp256k1), and re-verifying every message is the default; a
short-lived signed capability token (verified statelessly) is a natural layer on
top when you want to avoid signing every op. The only thing a server genuinely
adds is binding an authenticated identity to a live connection so you re-verify
less often — an optimization, not the security boundary.

> Authentication binds an owner to a **public key**. With `authenticate: true`,
> claim an area with a key (`fsCommand(identity, 'claim', …)`) so `owner`
> is that pubkey; handle→pubkey areas seeded from disk are admin content and
> aren't claimable by a key.

## Manifests — the shell-to-database bridge

There is **one manifest convention**, used by both lazy hydration and the eager
`seed` sweep (which is just recursive hydration — same reader, same ingest).

Every folder under `public/` may carry `info.js` or `info.json` (or
`manifest.*`). A manifest declares the folder's **own node** and **names its
children** — undeclared folders are invisible by construction, *even to a
direct probe*: filespace only loads a child's manifest if its parent declared it.

`.json` — the plain "pile of declarations" flavor:

```json
{
  "entities": [
    { "slug": "/drwobbles", "owner": "drwobbles",
      "components": { "about": { "label": "Dr. Wobbles" } } }
  ],
  "children": ["playground", "library"]
}
```

`children` sugar expands into bare **pointer** nodes (`hydrated: false`) — a
name that exists, whose own manifest loads on first visit. To give a child a
labeled card (or a policy!) before it's visited, declare it as a pointer entity
instead: `{ "slug": "library", "hydrated": false, "policy": "private",
"components": { "about": { "label": "Library" } } }`.

`.js` — real JavaScript, loaded through the **bus loader** (loops, imports,
computed declarations); each named export is a seed event:

```js
export const self    = { filespace: { seed: { slug: '/drwobbles', components: { about: { label: 'Dr. Wobbles' } } } } };
export const library = { filespace: { seed: { slug: '/drwobbles/library', hydrated: false } } };
```

**Lazy by default.** With `manifestRoot` set, nothing is scanned up front — an
area's manifest loads the first time it's visited, misses are tombstoned, and
`seed()` eagerly walks the same path to exhaustion when you want everything.
**Seeding never clobbers a runtime-origin node** and never downgrades a
hydrated node to a pointer — disk manifests are initial conditions, the live
store is the source of truth, so re-running the seed is always safe. See
[`public/`](public).

## Persistence and the store interface

filespace does not own a database. It declares a small **store interface** and
consumes it; adapters implement it. The same namespace logic runs on volatile
memory, a JSON file, or a production document store without change — and the
database can grow into its own concern (a separate `orbital-database` package) the
day a second consumer needs it.

An adapter provides:

```
get(slug)                   -> node | undefined
put(node)                   -> node            (upsert by slug)
delete(slug)                -> boolean
children(slug)              -> node[]          (direct children only)
byComponent(name, {prefix}) -> node[]
byMember(principal)         -> node[]          (owned by, or member of — "my areas")
query(selector)             -> node[]          (generic document query)
claimRoot(node)             -> node            (atomic first-come; throws if taken)
all()                       -> node[]
```

`claimRoot` is the only operation that must be atomic: the check-and-insert
happens synchronously, before any `await` yields, so two simultaneous claims on
the same slug cannot both win.

Adapters today:

- **`memory`** — the reference implementation; volatile; the thing every other
  adapter is tested against (`test/store.test.js` runs one contract over all of them).
- **`file`** — zero-dependency JSON persistence; durable across restarts; fine for
  development, a solo portfolio, or small spaces. Writes are atomic
  (write-then-rename), and a corrupt file is preserved as `nodes.json.corrupt-*`
  with a loud warning — never silently discarded. Single writer: two processes
  sharing one file will clobber each other; that's what a real adapter is for.
  Search is in-memory filtering, so it does not scale to large sets.

**Why a database is a separate feature.** The interface above is filespace's whole
need. Orbital as a whole has heavier, more varied storage — spatial indexes
(`bus.spatial`), time-series signals (`bus.db`), large collections with real
search — different shapes with different consumers, none of which should drag a
specific database into the others. So: filespace declares the interface; a separate
package provides implementations. When a real document adapter is added
(NeDB / PouchDB for embeddable, Mongo for production) and a second consumer wants
it, extract the adapters into `orbital-database` behind this same contract —
optionally with a dedicated search index (Orama / MiniSearch) over the document
store, since embeddable stores are weak at full-text search. Until then, `memory`
and `file` keep the dependency surface at zero. The seam is the interface;
extraction is a move, not a refactor.

## CLI — a tool to exercise the whole thing

The package is fully driveable from the console, with real security on by default
(`enforce` + `authenticate`). It carries a local **keyring** so you can act as
named users: `--as alice` loads alice's retained keypair and signs the action for
her. (Normally each user holds their own key; the keyring is a testing
convenience — a "hosted keypair" store. Private keys are plaintext on disk, so
keep it out of git — the default lives under the git-ignored `.filespace/`.)

```sh
# users — generate/retain keypairs so the CLI can sign as them
npx filespace user new alice
npx filespace user new bob
npx filespace user list

# areas & folders (writes need --as <user>)
npx filespace claim /alice --as alice --policy private
npx filespace mkdir /alice/journal --as alice
npx filespace policy /alice protected --as alice        # change privacy (owner only)
npx filespace set /alice/journal --as alice --json '{"about":{"label":"Diary"}}'
npx filespace mv /alice/journal /alice/diary --as alice # subtree moves too
npx filespace invite /alice bob --as alice --role member
npx filespace rm /alice/diary --as alice

# enumerate (add --as <user> to see private areas you belong to)
npx filespace ls /                    # anonymous: public/protected only
npx filespace ls /alice --as alice    # signed: sees private contents
npx filespace get /alice --as bob
npx filespace find geo --prefix /alice --as alice

# admin / misc
npx filespace seed                    # eagerly hydrate ./public (or: seed <dir>)
npx filespace dump                    # raw store, ignoring privacy (debug)
npx filespace nuke --yes [--keys]     # wipe nodes (and keyring with --keys)
npx filespace demo                    # scripted end-to-end scenario
```

Every operation you'd want to exercise: **create users, claim areas, set
privacy, drag content, invite participants, enumerate** — and each write is
genuinely signed and each read genuinely privacy-filtered. `filespace demo` runs
a full alice/bob/eve scenario (private area, invite, public post, policy flip) so
you can see auth + policy + privacy working in one shot.

Env: `FILESPACE_DB` (node store), `FILESPACE_KEYRING` (keypairs).
Flags: `--as`, `--policy`, `--role`, `--json`, `--prefix`, `--insecure`
(disable enforce+authenticate for quick poking).

## Identity helper

For tests and demos, mint a real secp256k1 keypair instead of a bare name:

```js
import { newIdentity, verify } from '@orbitalfoundation/filespace';

const id  = newIdentity();          // { publicKey, privateKey, sign }
const sig = id.sign({ claim: '/macy' });
verify(id.publicKey, { claim: '/macy' }, sig); // true
```

## Develop

```sh
npm install   # links @orbitalfoundation/bus + utils from ../reference/orbital-bus
npm test      # node:test — paths, policy (chain), store contract, seed/lazy
              #             hydration, bus integration, identity, authentication,
              #             privacy, collaboration/move/changed (54 cases)
```

## License

MIT
