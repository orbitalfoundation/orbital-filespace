// cli — drive the filespace from the console, no server required (the jam
// principle: the core works standalone; HTTP/sockets are just one front door).
// Commands go through the real bus so the CLI exercises the same path a client
// would.
//
//   FILESPACE_DB=.filespace/nodes.json   where the file store persists
//   FILESPACE_PRINCIPAL=anselm           default actor (override with --as)
//
//   filespace seed <dir>
//   filespace ls [slug]
//   filespace get <slug>
//   filespace claim <slug>            --as <principal> [--policy public]
//   filespace mk <slug>              --as <principal> [--policy public]
//   filespace rm <slug>             --as <principal>
//   filespace invite <slug> <who>    --as <principal> [--role member]
//   filespace find <component>      [--prefix /anselm]
//   filespace dump
//   filespace nuke --yes
//
// Admin convenience: enforcement is OFF by default in the CLI (god-mode). Pass
// --enforce to exercise the permission rules.

import { createBus } from '@orbitalfoundation/bus';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { attach } from './filespace.js';
import { makeFileStore } from './store/file.js';

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

function out(value) {
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}

const USAGE = `filespace <command>

  seed <dir>                     load a public/ manifest tree
  ls [slug]                      list children (default '/')
  get <slug>                     show one node
  claim <slug> --as <who>        claim a root area (first-come)
  mk <slug> --as <who>           create a folder/content node
  rm <slug> --as <who>           delete a node
  invite <slug> <who> --as <by>  grant membership [--role member|owner]
  find <component> [--prefix p]   list nodes carrying a component
  dump                           print every node
  nuke --yes                     erase the store

env: FILESPACE_DB, FILESPACE_PRINCIPAL   flags: --as, --policy, --role, --enforce`;

export async function run(argv = process.argv.slice(2)) {
  const { args, opts } = parseArgs(argv);
  const [cmd, ...rest] = args;
  const dbPath = process.env.FILESPACE_DB || join(process.cwd(), '.filespace', 'nodes.json');
  const principal = opts.as || process.env.FILESPACE_PRINCIPAL || null;

  if (!cmd || cmd === 'help' || opts.help) {
    out(USAGE);
    return;
  }

  if (cmd === 'nuke') {
    if (!opts.yes) return out('refusing to nuke without --yes');
    rmSync(dbPath, { force: true });
    return out(`erased ${dbPath}`);
  }

  const bus = createBus({ description: 'filespace-cli' });
  const fs = attach(bus, { store: makeFileStore(dbPath), enforce: !!opts.enforce });

  switch (cmd) {
    case 'seed':
      return out(await fs.seed({ dir: rest[0] }));
    case 'ls':
      return out(await fs.list(rest[0] || '/'));
    case 'get':
      return out((await fs.get(rest[0])) ?? '(not found)');
    case 'claim':
      return out(await fs.claim({ slug: rest[0], principal, policy: opts.policy }));
    case 'mk':
      return out(await fs.create({ slug: rest[0], principal, policy: opts.policy }));
    case 'rm':
      return out(await fs.remove({ slug: rest[0], principal }));
    case 'invite':
      return out(await fs.invite({ slug: rest[0], who: rest[1], principal, role: opts.role }));
    case 'find':
      return out(await fs.find({ component: rest[0], prefix: opts.prefix === true ? null : opts.prefix }));
    case 'dump':
      return out(await fs.find({}));
    default:
      out(`unknown command: ${cmd}\n\n${USAGE}`);
      process.exitCode = 1;
  }
}
