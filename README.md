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

Reads (return the value; no `principal` needed):

| key | payload | returns |
|---|---|---|
| `fs_get_query`  | `{ slug }` | the node |
| `fs_list_query` | `{ slug }` | direct children |
| `fs_find_query` | `{ component, prefix }` or `{ selector }` | matching nodes |

Writes (carry a server-verified `principal`):

| key | payload |
|---|---|
| `fs_claim`  | `{ slug, principal, policy?, components? }` — claim a root area |
| `fs_create` | `{ slug, principal, policy?, components? }` — create a folder/content node |
| `fs_update` | `{ slug, principal, components }` |
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
development). The rules live in [`src/policy.js`](src/policy.js) as pure functions
so the edge auth-gateway can consult them without duplicating logic.

> **Security note.** A `principal` must be the *server-verified* identity. The edge
> (a socket/HTTP gateway, a separate package) is responsible for stamping it onto
> events; filespace must never trust a principal a raw client supplied.

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

## CLI

The package is fully driveable from the console — no server required.

```sh
npx filespace seed example/public
npx filespace ls /
npx filespace claim /macy --as macy
npx filespace mk /macy/ces --as macy --enforce
npx filespace invite /macy bob --as macy
npx filespace find geo --prefix /drwobbles
npx filespace dump
```

Env: `FILESPACE_DB` (store path), `FILESPACE_PRINCIPAL` (default actor).
Flags: `--as`, `--policy`, `--role`, `--enforce`.

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
npm test      # node:test — paths, policy, store contract, seed, bus integration, identity
```

## License

MIT
