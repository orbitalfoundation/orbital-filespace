// Private areas are actually private: reads are gated, with inheritance, and an
// identity is only granted on a read when it's proven (signed).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBus } from '@orbitalfoundation/bus';
import { attach } from '../src/filespace.js';
import { makeMemoryStore } from '../src/store/memory.js';
import { newIdentity } from '../src/identity.js';
import { fsCommand, fsQuery } from '../src/auth.js';

function setup() {
  const bus = createBus({ description: 'private-test' });
  attach(bus, { store: makeMemoryStore(), enforce: true, authenticate: true });
  return bus;
}

test('a private area is invisible to guests and non-members, visible to the owner', async () => {
  const bus = setup();
  const alice = newIdentity();
  const bob = newIdentity();

  await bus.resolve(fsCommand(alice, 'claim', { slug: '/alice', policy: 'private' }));
  await bus.resolve(fsCommand(alice, 'create', { slug: '/alice/secret' }));

  // anonymous guest sees nothing
  assert.equal(await bus.resolve(fsQuery('get', { slug: '/alice' })), null);
  assert.deepEqual(await bus.resolve(fsQuery('list', { slug: '/' })), []); // private root hidden
  assert.deepEqual(await bus.resolve(fsQuery('list', { slug: '/alice' })), []);

  // bob signs as himself but isn't a member — still hidden
  assert.equal(await bus.resolve(fsQuery('get', { slug: '/alice' }, bob)), null);

  // alice (signed) sees her area and its children
  const seen = await bus.resolve(fsQuery('get', { slug: '/alice' }, alice));
  assert.equal(seen?.slug, '/alice');
  const kids = await bus.resolve(fsQuery('list', { slug: '/alice' }, alice));
  assert.deepEqual(kids.map((n) => n.slug), ['/alice/secret']);
});

test('privacy inherits: a public child inside a private area stays hidden', async () => {
  const bus = setup();
  const alice = newIdentity();
  await bus.resolve(fsCommand(alice, 'claim', { slug: '/alice', policy: 'private' }));
  await bus.resolve(fsCommand(alice, 'create', { slug: '/alice/pub', policy: 'public' }));

  assert.equal(await bus.resolve(fsQuery('get', { slug: '/alice/pub' })), null);
  assert.deepEqual(await bus.resolve(fsQuery('find', { selector: {} })), []); // no leak via search
});

test('inviting a member reveals the private area to them', async () => {
  const bus = setup();
  const alice = newIdentity();
  const bob = newIdentity();
  await bus.resolve(fsCommand(alice, 'claim', { slug: '/alice', policy: 'private' }));

  assert.equal(await bus.resolve(fsQuery('get', { slug: '/alice' }, bob)), null);
  await bus.resolve(fsCommand(alice, 'invite', { slug: '/alice', who: bob.publicKey }));
  const seen = await bus.resolve(fsQuery('get', { slug: '/alice' }, bob));
  assert.equal(seen?.slug, '/alice');
});

test('set_policy is owner-only (administer)', async () => {
  const bus = setup();
  const alice = newIdentity();
  const bob = newIdentity();
  await bus.resolve(fsCommand(alice, 'claim', { slug: '/alice', policy: 'public' }));

  const denied = await bus.resolve(fsCommand(bob, 'set_policy', { slug: '/alice', policy: 'private' }));
  assert.equal(denied.ok, false);
  assert.equal(denied.error, 'forbidden');

  const ok = await bus.resolve(fsCommand(alice, 'set_policy', { slug: '/alice', policy: 'private' }));
  assert.equal(ok.ok, true);
  assert.equal(ok.node.policy, 'private');
});
