import { test } from 'node:test';
import assert from 'node:assert/strict';
import { can, canRead, roleOf } from '../src/policy.js';

const area = { slug: '/drwobbles', owner: 'drwobbles', policy: 'public', members: [{ who: 'drwobbles', role: 'owner' }] };

test('roleOf resolves owner via node and via the ancestor chain', () => {
  assert.equal(roleOf('drwobbles', { slug: '/drwobbles/x', owner: 'drwobbles' }), 'owner');
  assert.equal(roleOf('drwobbles', { slug: '/drwobbles/x' }, [area]), 'owner'); // inherited from chain
  assert.equal(roleOf('bob', { slug: '/drwobbles/x', members: [{ who: 'bob', role: 'member' }] }), 'member');
  assert.equal(roleOf('eve', { slug: '/drwobbles/x' }), 'guest');
  assert.equal(roleOf(null, { slug: '/drwobbles/x' }), 'guest');
});

test('membership anywhere on the chain applies beneath it', () => {
  const project = { slug: '/a/proj', policy: 'private', members: [{ who: 'bob', role: 'member' }] };
  const root = { slug: '/a', owner: 'alice', policy: 'private' };
  const deep = { slug: '/a/proj/photos/1', policy: 'private' };
  // bob was invited to the mid-level project folder, not the root
  assert.equal(roleOf('bob', deep, [project, root]), 'member');
  assert.equal(canRead('bob', deep, [project, root]), true);
  assert.equal(can('bob', 'create-child', deep, { chain: [project, root] }), true);
  // eve was never invited anywhere
  assert.equal(canRead('eve', deep, [project, root]), false);
});

test('owner can do everything', () => {
  const node = { policy: 'private', owner: 'drwobbles' };
  for (const v of ['read', 'post', 'update', 'create-child', 'invite', 'administer'])
    assert.equal(can('drwobbles', v, node), true, v);
});

test('member can do everything except administer', () => {
  const node = { policy: 'private', members: [{ who: 'bob', role: 'member' }] };
  assert.equal(can('bob', 'read', node), true);
  assert.equal(can('bob', 'post', node), true);
  assert.equal(can('bob', 'update', node), true);
  assert.equal(can('bob', 'create-child', node), true);
  assert.equal(can('bob', 'invite', node), true);
  assert.equal(can('bob', 'administer', node), false);
});

test('guests are read-only; post (streams) is the one public exception', () => {
  assert.equal(can('eve', 'read', { policy: 'public' }), true);
  assert.equal(can('eve', 'post', { policy: 'public' }), true); // reserved for the streams layer
  assert.equal(can('eve', 'update', { policy: 'public' }), false); // no defacing public nodes
  assert.equal(can('eve', 'create-child', { policy: 'public' }), false);

  assert.equal(can('eve', 'read', { policy: 'protected' }), true);
  assert.equal(can('eve', 'post', { policy: 'protected' }), false);
  assert.equal(can('eve', 'update', { policy: 'protected' }), false);

  assert.equal(can('eve', 'read', { policy: 'private' }), false);
});

test('privacy anywhere on the chain hides everything beneath it', () => {
  const privateRoot = { slug: '/a', policy: 'private' };
  assert.equal(canRead('eve', { slug: '/a/pub', policy: 'public' }, [privateRoot]), false);
  assert.equal(can('eve', 'post', { slug: '/a/pub', policy: 'public' }, { chain: [privateRoot] }), false);
});
