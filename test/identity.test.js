// Identity: real secp256k1 keypairs as filespace principals.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBus } from '@orbitalfoundation/bus';
import { newIdentity, sign, verify } from '../src/identity.js';
import { attach } from '../src/filespace.js';
import { makeMemoryStore } from '../src/store/memory.js';

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

test('a generated pubkey is a valid filespace principal', async () => {
  const bus = createBus({ description: 'identity-test' });
  attach(bus, { store: makeMemoryStore(), enforce: true });

  const drwobbles = newIdentity();
  const claimed = await bus.resolve({ fs_claim: { slug: '/drwobbles', principal: drwobbles.publicKey } });
  assert.equal(claimed.ok, true);
  assert.equal(claimed.node.owner, drwobbles.publicKey);

  // a different cryptographic identity cannot create inside drwobbles' area
  const stranger = newIdentity();
  const denied = await bus.resolve({ fs_create: { slug: '/drwobbles/lab', principal: stranger.publicKey } });
  assert.equal(denied.ok, false);

  // the owning key can
  const ok = await bus.resolve({ fs_create: { slug: '/drwobbles/lab', principal: drwobbles.publicKey } });
  assert.equal(ok.ok, true);
});
