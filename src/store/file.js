// file store — zero-dependency persistent adapter. Wraps the memory store and
// flushes the whole node set to a JSON file on every mutation. Durable across
// restarts; fine for development, a solo portfolio, or small spaces. Search is
// in-memory filtering, so it does not scale to large document sets — that is
// what a real document adapter (NeDB / Mongo) is for later.
//
// The seam is deliberate: file and memory satisfy the same contract, so swapping
// to a heavier adapter — or extracting all adapters into a separate
// orbital-database package — never touches filespace itself.

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { makeMemoryStore } from './memory.js';

export function makeFileStore(path) {
  const store = makeMemoryStore({
    onChange: (docs) => {
      mkdirSync(dirname(path), { recursive: true });
      // write-then-rename so a crash mid-write can never corrupt the store
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, JSON.stringify(docs, null, 2));
      renameSync(tmp, path);
    },
  });

  if (existsSync(path)) {
    try {
      for (const n of JSON.parse(readFileSync(path, 'utf8'))) store._seed(n);
    } catch (err) {
      // a corrupt file is non-fatal, but NEVER silently discarded — preserve it
      // and say so loudly, or a bad parse would quietly wipe the whole space
      const backup = `${path}.corrupt-${Date.now()}`;
      renameSync(path, backup);
      console.warn(`[filespace] corrupt store ${path} (${err.message}) — preserved as ${backup}, starting empty`);
    }
  }

  store.kind = 'file';
  store.path = path;
  return store;
}
