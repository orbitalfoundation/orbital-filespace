// Lazy hydration: nothing is scanned up front. filespace fetches an area's
// manifest the first time it's visited, remembers what it loaded, and never
// re-hits the filesystem for the same area or the same miss.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBus } from '@orbitalfoundation/bus';
import { attach } from '../src/filespace.js';
import { makeMemoryStore } from '../src/store/memory.js';

// A tiny public/ tree of .js manifests. Each folder's info.js declares its own
// node (hydrated) and its children — child folders as pointers (hydrated:false),
// which get upgraded when their own manifest loads.
function writeTree(root) {
  mkdirSync(join(root, 'drwobbles', 'library'), { recursive: true });
  // an on-disk folder the root manifest does NOT declare — must stay invisible
  mkdirSync(join(root, 'sneaky'), { recursive: true });
  writeFileSync(join(root, 'sneaky', 'info.js'), `
    export const self = { filespace: { seed: { slug: '/sneaky', hydrated: true, components: { about: { label: 'Sneaky' } } } } };
  `);
  writeFileSync(join(root, 'info.js'), `
    export const home = { filespace: { seed: { slug: '/', hydrated: true, components: { about: { label: 'Home' } } } } };
    export const drwobbles = { filespace: { seed: { slug: '/drwobbles', hydrated: false, components: { about: { label: 'Dr. Wobbles' } } } } };
  `);
  writeFileSync(join(root, 'drwobbles', 'info.js'), `
    export const self = { filespace: { seed: { slug: '/drwobbles', hydrated: true, owner: 'drwobbles', policy: 'public', components: { about: { label: 'Dr. Wobbles' } } } } };
    export const playground = { filespace: { seed: { slug: '/drwobbles/playground', hydrated: true, components: { about: { label: 'Playground' }, geo: { ll: [-16.25, 28.46, 0] } } } } };
    export const library = { filespace: { seed: { slug: '/drwobbles/library', hydrated: false, policy: 'protected', components: { about: { label: 'Library' } } } } };
  `);
  writeFileSync(join(root, 'drwobbles', 'library', 'info.js'), `
    export const self = { filespace: { seed: { slug: '/drwobbles/library', hydrated: true, policy: 'protected', components: { about: { label: 'Library' } } } } };
    export const orbital = { filespace: { seed: { slug: '/drwobbles/library/orbital', hydrated: true, components: { about: { label: 'Orbital' }, link: { href: 'https://example.org' } } } } };
  `);
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'filespace-lazy-'));
  const root = join(dir, 'public');
  writeTree(root);
  const bus = createBus({ description: 'lazy-test' });
  const loads = [];
  const orig = bus.resolve.bind(bus);
  bus.resolve = (e) => {
    if (e && typeof e === 'object' && e.load) loads.push(e.load);
    return orig(e);
  };
  const fs = attach(bus, { store: makeMemoryStore(), enforce: false, manifestRoot: root });
  return { fs, loads, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('areas hydrate on first visit and only then', async () => {
  const { fs, loads, cleanup } = setup();
  try {
    // listing / fetches exactly the root manifest — nothing else is scanned
    assert.deepEqual((await fs.list('/')).map((n) => n.slug), ['/drwobbles']);
    assert.equal(loads.length, 1);

    // /drwobbles came in as a pointer — present, but not yet hydrated
    const pointer = await fs.get('/drwobbles');
    assert.equal(pointer.hydrated, false);
    assert.equal(loads.length, 1); // get of a present node doesn't fetch

    // entering /drwobbles fetches its manifest; it's now hydrated
    assert.deepEqual((await fs.list('/drwobbles')).map((n) => n.slug), ['/drwobbles/library', '/drwobbles/playground']);
    assert.equal(loads.length, 2);
    assert.equal((await fs.get('/drwobbles')).hydrated, true);

    // re-listing is a cache hit — no new fetch
    await fs.list('/drwobbles');
    assert.equal(loads.length, 2);

    // deeper: /drwobbles/library was a pointer; visiting it hydrates it
    assert.equal((await fs.get('/drwobbles/library')).hydrated, false);
    assert.deepEqual((await fs.list('/drwobbles/library')).map((n) => n.slug), ['/drwobbles/library/orbital']);
    assert.equal(loads.length, 3);
  } finally {
    cleanup();
  }
});

test('a missing area is tombstoned — the filesystem is hit at most once', async () => {
  const { fs, loads, cleanup } = setup();
  try {
    await fs.list('/'); // 1 load
    assert.deepEqual(await fs.list('/drwobbles/nope'), []);
    const after = loads.length; // hydrating the parent chain; never a probe for nope itself
    assert.deepEqual(await fs.list('/drwobbles/nope'), []);
    assert.equal(loads.length, after); // negative cache — no second attempt
  } finally {
    cleanup();
  }
});

test('a folder its parent never declared is invisible — even to a direct probe', async () => {
  const { fs, loads, cleanup } = setup();
  try {
    // /sneaky exists on disk with a manifest, but the root manifest doesn't
    // declare it. Probing it must neither reveal it nor load its manifest.
    assert.equal(await fs.get('/sneaky'), null);
    assert.deepEqual(await fs.list('/sneaky'), []);
    assert.ok(!loads.some((l) => String(l).includes('sneaky')));
    assert.deepEqual((await fs.list('/')).map((n) => n.slug), ['/drwobbles']);
  } finally {
    cleanup();
  }
});

test('global find only sees what has been hydrated', async () => {
  const { fs, cleanup } = setup();
  try {
    // nothing visited yet → geo search finds nothing (not the whole tree)
    assert.deepEqual(await fs.find({ component: 'geo' }), []);
    // visit /drwobbles → playground (which carries geo) is now loaded
    await fs.list('/drwobbles');
    assert.deepEqual((await fs.find({ component: 'geo' })).map((n) => n.slug), ['/drwobbles/playground']);
  } finally {
    cleanup();
  }
});
