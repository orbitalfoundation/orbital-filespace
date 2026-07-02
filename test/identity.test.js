// Identity: real secp256k1 keypairs as filespace principals.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBus } from '@orbitalfoundation/bus';
import { newIdentity, sign, verify } from '../src/identity.js';
import { attach } from '../src/filespace.js';
import { makeMemoryStore } from '../src/store/memory.js';

const cmd = (bus, op, args) => bus.resolve({ filespace: { command: { op, ...args } } });

test('sign / verify roundtrip', () => {
  const id = newIdentity();
  const message = { claim: '/drwobbles', at: 1 };
  const signature = id.sign(message);

  assert.equal(verify(id.publicKey, message, signature), true);
  assert.equal(verify(id.publicKey, { tampered: true }, signature), false);

  const other = newIdentity();
  assert.equal(verify(other.publicKey, message, signature), false); // wrong key
});

test('standalone sign() matches identity.sign()', () => {
  const id = newIdentity();
  const sig = sign(id.privateKey, 'hello');
  assert.equal(verify(id.publicKey, 'hello', sig), true);
});

test('a generated pubkey is a valid filespace principal (authorization path)', async () => {
  const bus = createBus({ description: 'identity-test' });
  attach(bus, { store: makeMemoryStore(), enforce: true }); // authenticate off

  const drwobbles = newIdentity();
  const claimed = await cmd(bus, 'claim', { slug: '/drwobbles', principal: drwobbles.publicKey });
  assert.equal(claimed.ok, true);
  assert.equal(claimed.node.owner, drwobbles.publicKey);

  // a different pubkey cannot create inside drwobbles' area
  const stranger = newIdentity();
  assert.equal((await cmd(bus, 'create', { slug: '/drwobbles/lab', principal: stranger.publicKey })).ok, false);

  // the owning key can
  assert.equal((await cmd(bus, 'create', { slug: '/drwobbles/lab', principal: drwobbles.publicKey })).ok, true);
});
