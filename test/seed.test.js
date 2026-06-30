import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeMemoryStore } from '../src/store/memory.js';
import { makeNode } from '../src/node.js';
import { seedDir } from '../src/seed.js';

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), '..', 'example', 'public');

test('seeds only declared folders from the manifest tree', async () => {
  const store = makeMemoryStore();
  const stats = await seedDir(store, PUBLIC);

  assert.ok(stats.upserted >= 5);
  assert.equal((await store.get('/')).components.about.label, 'Home');
  assert.equal((await store.get('/drwobbles')).owner, 'drwobbles');
  assert.equal((await store.get('/drwobbles/playground')).components.about.view, 'chat');
  assert.equal((await store.get('/drwobbles/library')).policy, 'protected');
  assert.ok((await store.get('/drwobbles/library/orbital')).components.link.href.startsWith('https://'));

  const geo = await store.byComponent('geo');
  assert.deepEqual(geo.map((n) => n.slug), ['/drwobbles/library/orbital', '/drwobbles/playground']);
});

test('seed never clobbers a runtime-origin node', async () => {
  const store = makeMemoryStore();
  await seedDir(store, PUBLIC);

  // Simulate a live edit, then re-seed.
  await store.put(makeNode({ slug: '/drwobbles/playground', origin: 'runtime', components: { about: { label: 'EDITED' } } }));
  const stats = await seedDir(store, PUBLIC);

  assert.equal((await store.get('/drwobbles/playground')).components.about.label, 'EDITED');
  assert.ok(stats.skipped >= 1);
});
