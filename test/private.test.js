// Private areas are actually private: reads are gated, with inheritance, and an
// identity is only granted on a read when it's proven (signed).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBus } from '@orbitalfoundation/bus';
import { attach } from '../src/filespace.js';
import { makeMemoryStore } from '../src/store/memory.js';
import { newIdentity } from '../src/identity.js';
import { signAction } from '../src/auth.js';

function setup() {
  const bus = createBus({ description: 'private-test' });
  attach(bus, { store: makeMemoryStore(), enforce: true, authenticate: true });
  return bus;
}

test('a private area is invisible to guests and non-members, visible to the owner', async () => {
  const bus = setup();
  const alice = newIdentity();
  const bob = newIdentity();

  await bus.resolve({ fs_claim: signAction(alice, 'fs_claim', { slug: '/alice', policy: 'private' }) });
  await bus.resolve({ fs_create: signAction(alice, 'fs_create', { slug: '/alice/secret' }) });

  // anonymous guest sees nothing
  assert.equal(await bus.resolve({ fs_get_query: { slug: '/alice' } }), null);
  assert.deepEqual(await bus.resolve({ fs_list_query: { slug: '/' } }), []); // private root hidden from listing
  assert.deepEqual(await bus.resolve({ fs_list_query: { slug: '/alice' } }), []);

  // bob signs as himself but isn't a member — still hidden
  assert.equal(await bus.resolve({ fs_get_query: signAction(bob, 'fs_get_query', { slug: '/alice' }) }), null);

  // alice (signed) sees her area and its children
  const seen = await bus.resolve({ fs_get_query: signAction(alice, 'fs_get_query', { slug: '/alice' }) });
  assert.equal(seen?.slug, '/alice');
  const kids = await bus.resolve({ fs_list_query: signAction(alice, 'fs_list_query', { slug: '/alice' }) });
  assert.deepEqual(kids.map((n) => n.slug), ['/alice/secret']);
});

test('privacy inherits: a public child inside a private area stays hidden', async () => {
  const bus = setup();
  const alice = newIdentity();
  await bus.resolve({ fs_claim: signAction(alice, 'fs_claim', { slug: '/alice', policy: 'private' }) });
  await bus.resolve({ fs_create: signAction(alice, 'fs_create', { slug: '/alice/pub', policy: 'public' }) });

  // even though the child is 'public', the private area hides it from a guest
  assert.equal(await bus.resolve({ fs_get_query: { slug: '/alice/pub' } }), null);
  // and it doesn't leak through a component search
  assert.deepEqual(await bus.resolve({ fs_find_query: { selector: {} } }), []);
});

test('inviting a member reveals the private area to them', async () => {
  const bus = setup();
  const alice = newIdentity();
  const bob = newIdentity();
  await bus.resolve({ fs_claim: signAction(alice, 'fs_claim', { slug: '/alice', policy: 'private' }) });

  assert.equal(await bus.resolve({ fs_get_query: signAction(bob, 'fs_get_query', { slug: '/alice' }) }), null);
  await bus.resolve({ fs_invite: signAction(alice, 'fs_invite', { slug: '/alice', who: bob.publicKey }) });
  const seen = await bus.resolve({ fs_get_query: signAction(bob, 'fs_get_query', { slug: '/alice' }) });
  assert.equal(seen?.slug, '/alice');
});

test('setPolicy is owner-only (administer)', async () => {
  const bus = setup();
  const alice = newIdentity();
  const bob = newIdentity();
  await bus.resolve({ fs_claim: signAction(alice, 'fs_claim', { slug: '/alice', policy: 'public' }) });

  const denied = await bus.resolve({ fs_set_policy: signAction(bob, 'fs_set_policy', { slug: '/alice', policy: 'private' }) });
  assert.equal(denied.ok, false);
  assert.equal(denied.error, 'forbidden');

  const ok = await bus.resolve({ fs_set_policy: signAction(alice, 'fs_set_policy', { slug: '/alice', policy: 'private' }) });
  assert.equal(ok.ok, true);
  assert.equal(ok.node.policy, 'private');
});
