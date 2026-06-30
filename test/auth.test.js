// Authentication in the core: signed-envelope verification + replay protection.
// With authenticate:true, a write is honored only if it carries a valid signature
// from the principal's key — proving identity, not just asserting it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBus } from '@orbitalfoundation/bus';
import { attach } from '../src/filespace.js';
import { makeMemoryStore } from '../src/store/memory.js';
import { newIdentity } from '../src/identity.js';
import { signAction } from '../src/auth.js';

function setup(now) {
  const bus = createBus({ description: 'auth-test' });
  attach(bus, { store: makeMemoryStore(), enforce: true, authenticate: true, now });
  return bus;
}

test('a signed claim binds the area to the signer; the owner key can build inside it', async () => {
  const bus = setup();
  const macy = newIdentity();

  const claimed = await bus.resolve({ fs_claim: signAction(macy, 'fs_claim', { slug: '/macy' }) });
  assert.equal(claimed.ok, true);
  assert.equal(claimed.node.owner, macy.publicKey);

  const made = await bus.resolve({ fs_create: signAction(macy, 'fs_create', { slug: '/macy/ces' }) });
  assert.equal(made.ok, true);
});

test('a different key cannot act in someone else’s area', async () => {
  const bus = setup();
  const macy = newIdentity();
  const eve = newIdentity();
  await bus.resolve({ fs_claim: signAction(macy, 'fs_claim', { slug: '/macy' }) });

  // eve signs validly as herself — authentication passes, authorization denies
  const res = await bus.resolve({ fs_create: signAction(eve, 'fs_create', { slug: '/macy/hack' }) });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'forbidden');

  // eve cannot even claim a fresh area while pretending to be macy:
  // she can't produce macy's signature, so there's no envelope to forge.
});

test('an unsigned write is rejected when authenticate is on', async () => {
  const bus = setup();
  const macy = newIdentity();
  const res = await bus.resolve({ fs_claim: { slug: '/macy', principal: macy.publicKey } });
  assert.equal(res.ok, false);
  assert.match(res.error, /signed envelope required/);
});

test('tampering with a signed payload breaks the signature', async () => {
  const bus = setup();
  const macy = newIdentity();
  const envelope = signAction(macy, 'fs_claim', { slug: '/macy' });

  // attacker intercepts and rewrites the target slug, keeping the signature
  const tampered = { ...envelope, slug: '/victim' };
  const res = await bus.resolve({ fs_claim: tampered });
  assert.equal(res.ok, false);
  assert.match(res.error, /signature mismatch/);
});

test('replaying a captured envelope is rejected (nonce burned)', async () => {
  const bus = setup();
  const macy = newIdentity();
  await bus.resolve({ fs_claim: signAction(macy, 'fs_claim', { slug: '/macy' }) });

  const envelope = signAction(macy, 'fs_create', { slug: '/macy/a' });
  assert.equal((await bus.resolve({ fs_create: envelope })).ok, true);

  // resend the identical (validly signed) envelope
  const res = await bus.resolve({ fs_create: envelope });
  assert.equal(res.ok, false);
  assert.match(res.error, /replay detected/);
});

test('an expired envelope is rejected', async () => {
  let clock = 1000;
  const now = () => clock;
  const bus = setup(now);
  const macy = newIdentity();

  const envelope = signAction(macy, 'fs_claim', { slug: '/macy' }, { ttlMs: 100, now });
  clock = 5000; // advance well past exp (1100)
  const res = await bus.resolve({ fs_claim: envelope });
  assert.equal(res.ok, false);
  assert.match(res.error, /expired/);
});
