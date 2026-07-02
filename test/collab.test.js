// The headline collaboration story: invite someone to jam on a PROJECT folder
// (not your root), and everything inside that folder is genuinely shared —
// they see it, they contribute to it, they own what they make. Plus move and
// change announcements.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBus } from '@orbitalfoundation/bus';
import { attach } from '../src/filespace.js';
import { makeMemoryStore } from '../src/store/memory.js';
import { newIdentity } from '../src/identity.js';
import { fsCommand, fsQuery } from '../src/auth.js';

function setup() {
  const bus = createBus({ description: 'collab-test' });
  const store = makeMemoryStore();
  attach(bus, { store, enforce: true, authenticate: true });
  return { bus, store };
}

test('invited to a mid-level project folder, a member can see and build inside it', async () => {
  const { bus } = setup();
  const alice = newIdentity();
  const bob = newIdentity();

  await bus.resolve(fsCommand(alice, 'claim', { slug: '/alice', policy: 'private' }));
  await bus.resolve(fsCommand(alice, 'create', { slug: '/alice/proj' }));
  await bus.resolve(fsCommand(alice, 'create', { slug: '/alice/proj/doc', components: { about: { label: 'Doc' } } }));

  // bob is invited to the PROJECT, not the root
  await bus.resolve(fsCommand(alice, 'invite', { slug: '/alice/proj', who: bob.publicKey }));

  // membership applies to everything beneath the invite
  const kids = await bus.resolve(fsQuery('list', { slug: '/alice/proj' }, bob));
  assert.deepEqual(kids.map((n) => n.slug), ['/alice/proj/doc']);
  assert.equal((await bus.resolve(fsQuery('get', { slug: '/alice/proj/doc' }, bob)))?.slug, '/alice/proj/doc');

  // …but not to the rest of alice's private space
  assert.equal(await bus.resolve(fsQuery('get', { slug: '/alice' }, bob)), null);

  // bob contributes — and can see his own contribution (he owns it)
  const made = await bus.resolve(fsCommand(bob, 'create', { slug: '/alice/proj/photo' }));
  assert.equal(made.ok, true);
  assert.equal(made.node.owner, bob.publicKey);
  assert.equal((await bus.resolve(fsQuery('get', { slug: '/alice/proj/photo' }, bob)))?.slug, '/alice/proj/photo');

  // creator owns his node (can administer it); alice administers via the chain
  assert.equal((await bus.resolve(fsCommand(bob, 'delete', { slug: '/alice/proj/photo' }))).ok, true);
  assert.equal((await bus.resolve(fsCommand(bob, 'delete', { slug: '/alice/proj/doc' }))).ok, false); // not his
  assert.equal((await bus.resolve(fsCommand(alice, 'delete', { slug: '/alice/proj/doc' }))).ok, true);
});

test('move relocates a whole subtree, keeps ids, and respects permissions', async () => {
  const { bus } = setup();
  const alice = newIdentity();
  const eve = newIdentity();

  await bus.resolve(fsCommand(alice, 'claim', { slug: '/alice' }));
  await bus.resolve(fsCommand(alice, 'create', { slug: '/alice/myphotos' }));
  const deep = await bus.resolve(fsCommand(alice, 'create', { slug: '/alice/myphotos/lonepine', components: { about: { label: 'Lone Pine' } } }));

  // eve can't rename alice's things
  assert.equal((await bus.resolve(fsCommand(eve, 'move', { slug: '/alice/myphotos', to: '/alice/stolen' }))).ok, false);

  const moved = await bus.resolve(fsCommand(alice, 'move', { slug: '/alice/myphotos', to: '/alice/2007photos' }));
  assert.equal(moved.ok, true);

  // the child came along, same identity, new address
  const child = await bus.resolve(fsQuery('get', { slug: '/alice/2007photos/lonepine' }, alice));
  assert.equal(child.id, deep.node.id);
  assert.equal(child.components.about.label, 'Lone Pine');
  assert.equal(await bus.resolve(fsQuery('get', { slug: '/alice/myphotos/lonepine' }, alice)), null);

  // guard rails
  assert.equal((await bus.resolve(fsCommand(alice, 'move', { slug: '/alice', to: '/bob' }))).ok, false); // roots are claimed, not moved
  assert.equal((await bus.resolve(fsCommand(alice, 'move', { slug: '/alice/2007photos', to: '/alice/2007photos/inside' }))).ok, false); // not into itself
});

test('every successful write is announced as { filespace: { changed } }', async () => {
  const { bus } = setup();
  const seen = [];
  bus.register({
    id: 'test.watcher',
    resolve(e) {
      const c = e?.filespace?.changed;
      if (c) seen.push(`${c.op} ${c.slug}`);
    },
  });

  const alice = newIdentity();
  await bus.resolve(fsCommand(alice, 'claim', { slug: '/alice' }));
  await bus.resolve(fsCommand(alice, 'create', { slug: '/alice/a' }));
  await bus.resolve(fsCommand(alice, 'update', { slug: '/alice/a', components: { about: { label: 'A' } } }));
  await bus.resolve(fsCommand(alice, 'move', { slug: '/alice/a', to: '/alice/b' }));
  await bus.resolve(fsCommand(alice, 'delete', { slug: '/alice/b' }));
  // a denied write announces nothing
  const eve = newIdentity();
  await bus.resolve(fsCommand(eve, 'create', { slug: '/alice/evil' }));

  assert.deepEqual(seen, [
    'claim /alice',
    'create /alice/a',
    'update /alice/a',
    'move /alice/b',
    'delete /alice/b',
  ]);
});
