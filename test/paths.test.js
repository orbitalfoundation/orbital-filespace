import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeSlug, segments, parentSlug, rootSlug, isRoot, basename, isChildOf, isDescendantOf,
} from '../src/paths.js';

test('normalizeSlug', () => {
  assert.equal(normalizeSlug(undefined), '/');
  assert.equal(normalizeSlug('/'), '/');
  assert.equal(normalizeSlug('anselm'), '/anselm');
  assert.equal(normalizeSlug('/anselm/'), '/anselm');
  assert.equal(normalizeSlug('//anselm///playground//'), '/anselm/playground');
});

test('segments / root / parent / basename', () => {
  assert.deepEqual(segments('/anselm/playground'), ['anselm', 'playground']);
  assert.deepEqual(segments('/'), []);
  assert.equal(rootSlug('/anselm/playground/x'), '/anselm');
  assert.equal(parentSlug('/anselm/playground'), '/anselm');
  assert.equal(parentSlug('/anselm'), '/');
  assert.equal(basename('/anselm/playground'), 'playground');
});

test('isRoot', () => {
  assert.equal(isRoot('/anselm'), true);
  assert.equal(isRoot('/anselm/x'), false);
  assert.equal(isRoot('/'), false);
});

test('isChildOf / isDescendantOf', () => {
  assert.equal(isChildOf('/anselm/x', '/anselm'), true);
  assert.equal(isChildOf('/anselm/x/y', '/anselm'), false);
  assert.equal(isDescendantOf('/anselm/x/y', '/anselm'), true);
  assert.equal(isDescendantOf('/anselm', '/anselm'), false);
  assert.equal(isDescendantOf('/anselm', '/'), true);
});
