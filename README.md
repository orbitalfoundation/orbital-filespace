# @orbitalfoundation/filespace

A multiuser, identity-owned, path-addressed **shared filespace** — implemented as a
single listener on the [orbital bus](https://www.npmjs.com/package/@orbitalfoundation/bus).

It is the low-level substrate underneath collaborative apps: a namespace of
folders where roots are claimed first-come, ownership is keyed to a public key,
and every folder can be public, protected, or private with invited members.
Chat, agents, simulations, presence, a web UI — all of that lives *on top*. This
package knows only about **files, folders, ownership, membership, and
enumeration**. If a feature isn't one of those, it belongs in a consumer, not here.

## What it is (and isn't)

- A **path-addressed namespace.** A node lives at a slug like `/drwobbles/playground`.
  The first path segment is a "root area", handed out first-come to whoever claims it.
- **ECS-style nodes.** A node is `{ id, slug, owner, policy, members, components, origin }`.
  Folders and content are the same shape; the presence of a component (`about`,
  `geo`, `link`, `agent`, `chore`, `view`…) is what distinguishes them.
- **Identity by public key.** A `principal` is an opaque string — a readable handle
  or a secp256k1 public key (the curve web3auth / Ethereum wallets use). Users own
  what they sign; this package doesn't custody user data.
- **Just a bus listener.** Register it and the bus gains a `filespace`. Reads are
  `*_query` keys (first-responder returns the value); writes are action keys that
  carry a `principal`. The same methods are installed as `bus.filespace` and driven
  by the CLI with no server in sight.
- **Pluggable persistence.** A tiny store interface (~7 methods) with `memory` and
  zero-dependency `file` adapters today; Mongo / NeDB / a separate
  `orbital-database` package slot in behind the same interface later. See
  [Persistence](#persistence-and-the-store-interface) below.

It is **not** a chat system, an agent runtime, an auth server, or a web app. Those
are layers above.

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
await fs.seed({ dir: './example/public' });

// a user claims a root area, first-come
await bus.resolve({ fs_claim: { slug: '/macy', principal: macyPubKey } });

// …and creates a folder inside it
await bus.resolve({ fs_create: { slug: '/macy/ces', principal: macyPubKey } });

// reads go through the bus as queries
const kids = await bus.resolve({ fs_list_query: { slug: '/macy' } });
```

### Bus vocabulary

Reads (privacy-gated — see [Permissions](#permissions); pass `principal` + a
signed envelope to see private areas you belong to, else you read as an
anonymous guest):

| key | payload | returns |
|---|---|---|
| `fs_get_query`  | `{ slug, principal?, auth? }` | the node, or `null` if hidden |
| `fs_list_query` | `{ slug, principal?, auth? }` | direct children you may read |
| `fs_find_query` | `{ component, prefix }` or `{ selector }` (+ `principal?, auth?`) | matching nodes you may read |

Writes (carry a `principal`; a signed `auth` envelope when `authenticate` is on):

| key | payload |
|---|---|
| `fs_claim`  | `{ slug, principal, policy?, components? }` — claim a root area |
| `fs_create` | `{ slug, principal, policy?, components? }` — create a folder/content node |
| `fs_update` | `{ slug, principal, components }` — post/merge content |
| `fs_set_policy` | `{ slug, principal, policy }` — change privacy (owner only) |
| `fs_delete` | `{ slug, principal }` |
| `fs_invite` | `{ slug, principal, who, role? }` |
| `fs_seed`   | `{ dir, basePath? }` — load a manifest tree (bootstrap/admin) |

## Permissions

Each node carries `policy: public | protected | private` and a `members` list.
Roles (`owner`, `member`, `guest`) are computed from the node **and** its root
area, so membership granted on `/drwobbles` applies to everything beneath it.

| verb | owner | member | guest (public) | guest (protected) | guest (private) |
|---|---|---|---|---|---|
| read          | ✓ | ✓ | ✓ | ✓ | — |
| post          | ✓ | ✓ | ✓ | — | — |
| create-child  | ✓ | ✓ | — | — | — |
| invite        | ✓ | ✓ | — | — | — |
| administer    | ✓ | — | — | — | — |

`enforce: false` skips these checks (the "allow-all" posture for early
development). The rules live in [`src/policy.js`](src/policy.js) as pure functions.

**Reads are gated too, with inheritance.** A `private` area is invisible to
guests and non-members — `get` returns `null` (existence doesn't leak) and
`list`/`find` filter it out. Privacy inherits: a `public` item inside a `private`
area stays hidden. Inviting a member reveals the area to them. So `private` means
*actually* private, not merely unwritable.

## Authentication (in the core, not at a server)

`enforce` answers *may principal P do this?* — **authorization**. It still trusts
that the caller really is P. Turn on `authenticate` and filespace also answers
*is the caller really P?* — **authentication** — by verifying a signature, with no
server involved.

```js
import { attach, makeFileStore, newIdentity, signAction } from '@orbitalfoundation/filespace';

const fs = attach(bus, { store: makeFileStore('.filespace/nodes.json'), enforce: true, authenticate: true });

const macy = newIdentity();                                  // a secp256k1 keypair (the web3auth curve)
await bus.resolve({ fs_claim:  signAction(macy, 'fs_claim',  { slug: '/macy' }) });
await bus.resolve({ fs_create: signAction(macy, 'fs_create', { slug: '/macy/ces' }) });
```

Each write carries a signed envelope `auth: { nonce, exp, sig }`. The signature
binds the **op + all args + nonce + exp**, and is verified against `principal` (a
public key). Therefore:

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
> claim an area with a key (`signAction(identity, 'fs_claim', …)`) so `owner`
> is that pubkey; handle→pubkey areas seeded from disk are admin content and
> aren't claimable by a key.

## Seeding — the shell-to-database bridge

`public/` holds `info.json` / `info.js` / `manifest.*` files. A root manifest
declares which sub-folders are scanned via `children`; undeclared folders are
invisible by construction. **Seeding never clobbers a runtime-origin node** — disk
manifests are initial conditions, the live store is the source of truth, so
re-running the seed is always safe. See [`example/public/`](example/public).

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
  development, a solo portfolio, or small spaces. Search is in-memory filtering, so
  it does not scale to large sets.

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
npx filespace invite /alice bob --as alice --role member
npx filespace rm /alice/journal --as alice

# enumerate (add --as <user> to see private areas you belong to)
npx filespace ls /                    # anonymous: public/protected only
npx filespace ls /alice --as alice    # signed: sees private contents
npx filespace get /alice --as bob
npx filespace find geo --prefix /alice --as alice

# admin / misc
npx filespace seed example/public     # load a manifest tree
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
npm test      # node:test — paths, policy, store contract, seed, bus integration,
              #             identity, authentication, privacy (36 cases)
```

## License

MIT
