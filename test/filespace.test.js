// filespace as a listener on the real @orbitalfoundation/bus, via the single
// reserved key: { filespace: { query|command } }. Here authenticate is OFF, so
// commands are unsigned and the principal is trusted — this exercises the
// authorization (enforce) path and the query/command dispatch.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createBus } from '@orbitalfoundation/bus';
import { attach } from '../src/filespace.js';
import { makeMemoryStore } from '../src/store/memory.js';

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

const cmd = (bus, op, args) => bus.resolve({ filespace: { command: { op, ...args } } });
const qry = (bus, op, args) => bus.resolve({ filespace: { query: { op, ...args } } });

function fresh() {
  const bus = createBus({ description: 'filespace-test' });
  const fs = attach(bus, { store: makeMemoryStore(), enforce: true }); // authenticate off
  return { bus, fs };
}

test('installs bus.filespace with query + command on registration', () => {
  const { bus } = fresh();
  assert.equal(typeof bus.filespace?.command, 'function');
  assert.equal(typeof bus.filespace?.query, 'function');
});

test('reserves exactly one bus key (filespace), no fs_* sprawl', async () => {
  const { bus } = fresh();
  await new Promise((r) => setImmediate(r)); // let the async schema claim settle
  const claimed = [...bus.schemas.keys()].filter((k) => k === 'filespace' || k.startsWith('fs_'));
  assert.deepEqual(claimed, ['filespace']);
});

test('claim is first-come', async () => {
  const { bus } = fresh();
  assert.equal((await cmd(bus, 'claim', { slug: '/macy', principal: 'macy' })).ok, true);
  const b = await cmd(bus, 'claim', { slug: '/macy', principal: 'bob' });
  assert.equal(b.ok, false);
  assert.match(b.error, /already claimed/);
});

test('slugs are validated: no dot-segments, no garbage roots', async () => {
  const { bus } = fresh();
  for (const slug of ['/..', '/.', '/../etc', '/macy/../oops', '/sp ace', '/.hidden']) {
    const res = await cmd(bus, 'claim', { slug, principal: 'eve' });
    assert.equal(res.ok, false, slug);
    assert.match(res.error, /invalid slug|root areas/, slug);
  }
});

test('only the owner/members create children; guests cannot', async () => {
  const { bus } = fresh();
  await cmd(bus, 'claim', { slug: '/macy', principal: 'macy' });
  assert.equal((await cmd(bus, 'create', { slug: '/macy/ces', principal: 'macy' })).ok, true);
  const denied = await cmd(bus, 'create', { slug: '/macy/sneaky', principal: 'bob' });
  assert.equal(denied.ok, false);
  assert.equal(denied.error, 'forbidden');
});

test('guests cannot mutate a public node; an invited member can', async () => {
  const { bus } = fresh();
  await cmd(bus, 'claim', { slug: '/macy', principal: 'macy' });
  await cmd(bus, 'create', { slug: '/macy/ces', principal: 'macy' });

  // eve is a guest — read yes, deface no
  assert.equal((await cmd(bus, 'update', { slug: '/macy/ces', principal: 'eve', components: { hi: 1 } })).ok, false);
  assert.equal((await cmd(bus, 'create', { slug: '/macy/ces/x', principal: 'eve' })).ok, false);

  assert.equal((await cmd(bus, 'invite', { slug: '/macy', principal: 'macy', who: 'eve' })).ok, true);
  assert.equal((await cmd(bus, 'update', { slug: '/macy/ces', principal: 'eve', components: { hi: 1 } })).ok, true);
  assert.equal((await cmd(bus, 'create', { slug: '/macy/ces/x', principal: 'eve' })).ok, true);
});

test('unknown command op is rejected — and seed is NOT a command', async () => {
  const { bus } = fresh();
  const res = await cmd(bus, 'obliterate_everything', { slug: '/x', principal: 'eve' });
  assert.equal(res.ok, false);
  assert.match(res.error, /unknown command/);

  // seeding loads manifests (code) and sets owner/policy directly — admin only,
  // never reachable through the command surface
  const sneak = await cmd(bus, 'seed', { dir: PUBLIC, principal: 'eve' });
  assert.equal(sneak.ok, false);
  assert.match(sneak.error, /unknown command/);
});

test('query ops return data via the bus first-responder', async () => {
  const { bus, fs } = fresh();
  await fs.seed({ dir: PUBLIC }); // admin API, in-process

  const node = await qry(bus, 'get', { slug: '/drwobbles/playground' });
  assert.equal(node.components.about.view, 'chat');

  const kids = await qry(bus, 'list', { slug: '/drwobbles' });
  assert.deepEqual(kids.map((n) => n.slug), ['/drwobbles/library', '/drwobbles/playground']);

  const geo = await qry(bus, 'find', { component: 'geo' });
  assert.ok(geo.length >= 2);
});

test('protected area: guest reads, cannot write', async () => {
  const { bus, fs } = fresh();
  await fs.seed({ dir: PUBLIC });

  const read = await qry(bus, 'get', { slug: '/drwobbles/library' });
  assert.equal(read.policy, 'protected');

  const write = await cmd(bus, 'update', { slug: '/drwobbles/library', principal: 'eve', components: { x: 1 } });
  assert.equal(write.ok, false);
});

test('null deletes a component on update', async () => {
  const { bus } = fresh();
  await cmd(bus, 'claim', { slug: '/macy', principal: 'macy' });
  await cmd(bus, 'create', { slug: '/macy/spot', principal: 'macy', components: { geo: { ll: [0, 0, 0] }, about: { label: 'Spot' } } });

  const res = await cmd(bus, 'update', { slug: '/macy/spot', principal: 'macy', components: { geo: null } });
  assert.equal(res.ok, true);
  assert.equal('geo' in res.node.components, false);
  assert.equal(res.node.components.about.label, 'Spot');
  assert.deepEqual(await qry(bus, 'find', { component: 'geo' }), []);
});
