// Eager seeding is recursive hydration: the same manifest reader and the same
// ingest as the lazy path, walked to exhaustion. JSON manifests need no bus.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeMemoryStore } from '../src/store/memory.js';
import { makeNode } from '../src/node.js';
import { makeService } from '../src/filespace.js';

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

test('seeds only declared folders from the manifest tree', async () => {
  const store = makeMemoryStore();
  const fs = makeService(store, { manifestRoot: PUBLIC });
  const stats = await fs.seed({});

  assert.ok(stats.ok);
  assert.ok(stats.hydrated >= 4); // /, /drwobbles, playground, library
  assert.equal((await store.get('/')).components.about.label, 'Home');
  assert.equal((await store.get('/drwobbles')).owner, 'drwobbles');
  assert.equal((await store.get('/drwobbles/playground')).components.about.view, 'chat');
  assert.equal((await store.get('/drwobbles/library')).policy, 'protected');
  assert.ok((await store.get('/drwobbles/library/orbital')).components.link.href.startsWith('https://'));

  const geo = await store.byComponent('geo');
  assert.deepEqual(geo.map((n) => n.slug), ['/drwobbles/library/orbital', '/drwobbles/playground']);
});

test('seed never clobbers a runtime-origin node, and is idempotent', async () => {
  const store = makeMemoryStore();
  const fs = makeService(store, { manifestRoot: PUBLIC });
  await fs.seed({});

  // Simulate a live edit, then re-seed.
  await store.put(makeNode({ slug: '/drwobbles/playground', origin: 'runtime', components: { about: { label: 'EDITED' } } }));
  const again = await fs.seed({});

  assert.ok(again.ok);
  assert.equal((await store.get('/drwobbles/playground')).components.about.label, 'EDITED');
});

test('seed with an explicit dir works without a configured manifestRoot', async () => {
  const store = makeMemoryStore();
  const fs = makeService(store, {});
  const stats = await fs.seed({ dir: PUBLIC });
  assert.ok(stats.ok);
  assert.equal((await store.get('/drwobbles')).owner, 'drwobbles');
});
