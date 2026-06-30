// file store — zero-dependency persistent adapter. Wraps the memory store and
// flushes the whole node set to a JSON file on every mutation. Durable across
// restarts; fine for development, a solo portfolio, or small spaces. Search is
// in-memory filtering, so it does not scale to large document sets — that is
// what a real document adapter (NeDB / Mongo) is for later.
//
// The seam is deliberate: file and memory satisfy the same contract, so swapping
// to a heavier adapter — or extracting all adapters into a separate
// orbital-database package — never touches filespace itself.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { makeMemoryStore } from './memory.js';

export function makeFileStore(path) {
  const store = makeMemoryStore({
    onChange: (docs) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(docs, null, 2));
    },
  });

  if (existsSync(path)) {
    try {
      for (const n of JSON.parse(readFileSync(path, 'utf8'))) store._seed(n);
    } catch {
      // a corrupt file is non-fatal — start empty rather than crash
    }
  }

  store.kind = 'file';
  store.path = path;
  return store;
}
