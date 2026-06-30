// Integration: filespace as a listener on the real @orbitalfoundation/bus.
// Exercises the bus query/action path AND the permission rules (enforce: true).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createBus } from '@orbitalfoundation/bus';
import { attach } from '../src/filespace.js';
import { makeMemoryStore } from '../src/store/memory.js';

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), '..', 'example', 'public');

function freshBus() {
  const bus = createBus({ description: 'filespace-test' });
  const service = attach(bus, { store: makeMemoryStore(), enforce: true });
  return { bus, service };
}

test('installs bus.filespace on registration', () => {
  const { bus } = freshBus();
  assert.equal(typeof bus.filespace?.claim, 'function');
});

test('claim is first-come', async () => {
  const { bus } = freshBus();
  const a = await bus.resolve({ fs_claim: { slug: '/macy', principal: 'macy' } });
  assert.equal(a.ok, true);
  const b = await bus.resolve({ fs_claim: { slug: '/macy', principal: 'bob' } });
  assert.equal(b.ok, false);
  assert.match(b.error, /already claimed/);
});

test('only the owner/members create children; guests cannot', async () => {
  const { bus } = freshBus();
  await bus.resolve({ fs_claim: { slug: '/macy', principal: 'macy' } });

  const owned = await bus.resolve({ fs_create: { slug: '/macy/ces', principal: 'macy' } });
  assert.equal(owned.ok, true);

  const denied = await bus.resolve({ fs_create: { slug: '/macy/sneaky', principal: 'bob' } });
  assert.equal(denied.ok, false);
  assert.equal(denied.error, 'forbidden');
});

test('public area lets a guest post but not create; invite upgrades them', async () => {
  const { bus } = freshBus();
  await bus.resolve({ fs_claim: { slug: '/macy', principal: 'macy' } });
  await bus.resolve({ fs_create: { slug: '/macy/ces', principal: 'macy' } });

  // guest can post (public policy), cannot create children
  assert.equal((await bus.resolve({ fs_update: { slug: '/macy/ces', principal: 'eve', components: { hi: 1 } } })).ok, true);
  assert.equal((await bus.resolve({ fs_create: { slug: '/macy/ces/x', principal: 'eve' } })).ok, false);

  // invite eve, now she can create children
  const inv = await bus.resolve({ fs_invite: { slug: '/macy', principal: 'macy', who: 'eve' } });
  assert.equal(inv.ok, true);
  assert.equal((await bus.resolve({ fs_create: { slug: '/macy/ces/x', principal: 'eve' } })).ok, true);
});

test('query keys return data via the bus first-responder', async () => {
  const { bus } = freshBus();
  await bus.resolve({ fs_seed: { dir: PUBLIC } });

  const node = await bus.resolve({ fs_get_query: { slug: '/drwobbles/playground' } });
  assert.equal(node.components.about.view, 'chat');

  const kids = await bus.resolve({ fs_list_query: { slug: '/drwobbles' } });
  assert.deepEqual(kids.map((n) => n.slug), ['/drwobbles/library', '/drwobbles/playground']);

  const geo = await bus.resolve({ fs_find_query: { component: 'geo' } });
  assert.ok(geo.length >= 2);
});

test('protected area: guest reads, cannot post', async () => {
  const { bus } = freshBus();
  await bus.resolve({ fs_seed: { dir: PUBLIC } });

  const read = await bus.resolve({ fs_get_query: { slug: '/drwobbles/library' } });
  assert.equal(read.policy, 'protected');

  const post = await bus.resolve({ fs_update: { slug: '/drwobbles/library', principal: 'eve', components: { x: 1 } } });
  assert.equal(post.ok, false);
});
