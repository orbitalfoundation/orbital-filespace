import { test } from 'node:test';
import assert from 'node:assert/strict';
import { can, roleOf } from '../src/policy.js';

const area = { slug: '/drwobbles', owner: 'drwobbles', policy: 'public', members: [{ who: 'drwobbles', role: 'owner' }] };

test('roleOf resolves owner via node and via area', () => {
  assert.equal(roleOf('drwobbles', { slug: '/drwobbles/x', owner: 'drwobbles' }), 'owner');
  assert.equal(roleOf('drwobbles', { slug: '/drwobbles/x' }, area), 'owner'); // inherited from area
  assert.equal(roleOf('bob', { slug: '/drwobbles/x', members: [{ who: 'bob', role: 'member' }] }), 'member');
  assert.equal(roleOf('eve', { slug: '/drwobbles/x' }), 'guest');
  assert.equal(roleOf(null, { slug: '/drwobbles/x' }), 'guest');
});

test('owner can do everything', () => {
  const node = { policy: 'private', owner: 'drwobbles' };
  for (const v of ['read', 'post', 'create-child', 'invite', 'administer'])
    assert.equal(can('drwobbles', v, node), true, v);
});

test('member can do everything except administer', () => {
  const node = { policy: 'private', members: [{ who: 'bob', role: 'member' }] };
  assert.equal(can('bob', 'read', node), true);
  assert.equal(can('bob', 'post', node), true);
  assert.equal(can('bob', 'create-child', node), true);
  assert.equal(can('bob', 'invite', node), true);
  assert.equal(can('bob', 'administer', node), false);
});

test('guest access follows policy', () => {
  assert.equal(can('eve', 'read', { policy: 'public' }), true);
  assert.equal(can('eve', 'post', { policy: 'public' }), true);
  assert.equal(can('eve', 'create-child', { policy: 'public' }), false);

  assert.equal(can('eve', 'read', { policy: 'protected' }), true);
  assert.equal(can('eve', 'post', { policy: 'protected' }), false);

  assert.equal(can('eve', 'read', { policy: 'private' }), false);
});
