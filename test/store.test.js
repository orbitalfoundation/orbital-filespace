import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeMemoryStore } from '../src/store/memory.js';
import { makeFileStore } from '../src/store/file.js';
import { makeNode } from '../src/node.js';

// One contract, run against every adapter.
function contract(name, makeStore) {
  test(`${name}: put/get/children/byComponent/query`, async () => {
    const s = makeStore();
    await s.put(makeNode({ slug: '/drwobbles', owner: 'drwobbles' }));
    await s.put(makeNode({ slug: '/drwobbles/a', components: { geo: { ll: [0, 0, 0] } } }));
    await s.put(makeNode({ slug: '/drwobbles/b', components: { about: { label: 'B' } } }));
    await s.put(makeNode({ slug: '/drwobbles/a/deep' }));

    assert.equal((await s.get('/drwobbles')).owner, 'drwobbles');
    assert.equal(await s.get('/nope'), undefined);

    const kids = await s.children('/drwobbles');
    assert.deepEqual(kids.map((n) => n.slug), ['/drwobbles/a', '/drwobbles/b']); // direct only

    const geo = await s.byComponent('geo');
    assert.deepEqual(geo.map((n) => n.slug), ['/drwobbles/a']);

    const prefixed = await s.byComponent('geo', { prefix: '/other' });
    assert.equal(prefixed.length, 0);

    const found = await s.query({ slug: { $regex: '^/drwobbles/a' } });
    assert.deepEqual(found.map((n) => n.slug), ['/drwobbles/a', '/drwobbles/a/deep']);
  });

  test(`${name}: byMember finds owned and membered nodes`, async () => {
    const s = makeStore();
    await s.put(makeNode({ slug: '/mine', owner: 'alice' }));
    await s.put(makeNode({ slug: '/shared', owner: 'bob', members: [{ who: 'alice', role: 'member' }] }));
    await s.put(makeNode({ slug: '/other', owner: 'bob' }));
    assert.deepEqual((await s.byMember('alice')).map((n) => n.slug), ['/mine', '/shared']);
  });

  test(`${name}: claimRoot is first-come`, async () => {
    const s = makeStore();
    const ok = await s.claimRoot(makeNode({ slug: '/macy', owner: 'macy' }));
    assert.equal(ok.slug, '/macy');
    await assert.rejects(() => s.claimRoot(makeNode({ slug: '/macy', owner: 'bob' })), /already claimed/);
  });

  test(`${name}: delete`, async () => {
    const s = makeStore();
    await s.put(makeNode({ slug: '/x' }));
    assert.equal(await s.delete('/x'), true);
    assert.equal(await s.delete('/x'), false);
    assert.equal(await s.get('/x'), undefined);
  });
}

contract('memory', () => makeMemoryStore());

test('file: persists across reopen', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'filespace-'));
  const path = join(dir, 'nodes.json');
  try {
    const a = makeFileStore(path);
    await a.put(makeNode({ slug: '/drwobbles', owner: 'drwobbles', components: { about: { label: 'A' } } }));

    const b = makeFileStore(path); // fresh instance reads the same file
    const node = await b.get('/drwobbles');
    assert.equal(node.owner, 'drwobbles');
    assert.equal(node.components.about.label, 'A');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('file: a corrupt store is preserved loudly, never silently wiped', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'filespace-corrupt-'));
  const path = join(dir, 'nodes.json');
  try {
    writeFileSync(path, '{ this is not json');
    const warnings = [];
    const origWarn = console.warn;
    console.warn = (m) => warnings.push(String(m));
    let store;
    try {
      store = makeFileStore(path);
    } finally {
      console.warn = origWarn;
    }
    assert.deepEqual(await store.all(), []); // starts empty…
    assert.ok(readdirSync(dir).some((f) => f.startsWith('nodes.json.corrupt-'))); // …but the bytes survive
    assert.ok(warnings.some((w) => w.includes('corrupt'))); // …and it says so
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Run the full contract against the file adapter too, each in its own tmp file.
let counter = 0;
contract('file', () => {
  const dir = mkdtempSync(join(tmpdir(), `filespace-c${counter++}-`));
  return makeFileStore(join(dir, 'nodes.json'));
});
