// Authentication in the core: signed-envelope verification + replay protection.
// With authenticate:true, a command is honored only if it carries a valid
// signature from the principal's key — proving identity, not just asserting it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBus } from '@orbitalfoundation/bus';
import { attach } from '../src/filespace.js';
import { makeMemoryStore } from '../src/store/memory.js';
import { newIdentity } from '../src/identity.js';
import { fsCommand, fsQuery } from '../src/auth.js';

function setup(now) {
  const bus = createBus({ description: 'auth-test' });
  attach(bus, { store: makeMemoryStore(), enforce: true, authenticate: true, now });
  return bus;
}

test('a signed claim binds the area to the signer; the owner key can build inside it', async () => {
  const bus = setup();
  const macy = newIdentity();

  const claimed = await bus.resolve(fsCommand(macy, 'claim', { slug: '/macy' }));
  assert.equal(claimed.ok, true);
  assert.equal(claimed.node.owner, macy.publicKey);

  const made = await bus.resolve(fsCommand(macy, 'create', { slug: '/macy/ces' }));
  assert.equal(made.ok, true);
});

test('a different key cannot act in someone else’s area', async () => {
  const bus = setup();
  const macy = newIdentity();
  const eve = newIdentity();
  await bus.resolve(fsCommand(macy, 'claim', { slug: '/macy' }));

  // eve signs validly as herself — authentication passes, authorization denies
  const res = await bus.resolve(fsCommand(eve, 'create', { slug: '/macy/hack' }));
  assert.equal(res.ok, false);
  assert.equal(res.error, 'forbidden');
});

test('an unsigned command is rejected when authenticate is on', async () => {
  const bus = setup();
  const macy = newIdentity();
  const res = await bus.resolve({ filespace: { command: { op: 'claim', slug: '/macy', principal: macy.publicKey } } });
  assert.equal(res.ok, false);
  assert.match(res.error, /signed envelope required/);
});

test('tampering with a signed command breaks the signature', async () => {
  const bus = setup();
  const macy = newIdentity();
  const envelope = fsCommand(macy, 'claim', { slug: '/macy' });

  // attacker intercepts and rewrites the target slug, keeping the signature
  envelope.filespace.command.slug = '/victim';
  const res = await bus.resolve(envelope);
  assert.equal(res.ok, false);
  assert.match(res.error, /signature mismatch/);
});

test('replaying a captured command is rejected (nonce burned)', async () => {
  const bus = setup();
  const macy = newIdentity();
  await bus.resolve(fsCommand(macy, 'claim', { slug: '/macy' }));

  const envelope = fsCommand(macy, 'create', { slug: '/macy/a' });
  assert.equal((await bus.resolve(envelope)).ok, true);

  const res = await bus.resolve(envelope); // resend the identical, validly-signed command
  assert.equal(res.ok, false);
  assert.match(res.error, /replay detected/);
});

test('a query with a PRESENT but invalid proof fails loudly — no silent guest downgrade', async () => {
  const bus = setup();
  const macy = newIdentity();
  await bus.resolve(fsCommand(macy, 'claim', { slug: '/macy', policy: 'private' }));

  // a tampered signed read: private data must not silently vanish behind an
  // anonymous downgrade — the caller gets told their proof is bad
  const envelope = fsQuery('get', { slug: '/macy' }, macy);
  envelope.filespace.query.auth.sig = envelope.filespace.query.auth.sig.replace(/^../, '00');
  const res = await bus.resolve(envelope);
  assert.equal(res.ok, false);
  assert.match(res.error, /signature|bad/i);

  // while a genuinely anonymous read stays open (and privacy-filtered)
  assert.equal(await bus.resolve(fsQuery('get', { slug: '/macy' })), null);
});

test('an expired command is rejected', async () => {
  let clock = 1000;
  const now = () => clock;
  const bus = setup(now);
  const macy = newIdentity();

  const envelope = fsCommand(macy, 'claim', { slug: '/macy' }, { ttlMs: 100, now });
  clock = 5000; // advance well past exp (1100)
  const res = await bus.resolve(envelope);
  assert.equal(res.ok, false);
  assert.match(res.error, /expired/);
});
