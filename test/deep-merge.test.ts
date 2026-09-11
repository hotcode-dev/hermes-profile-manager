import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { deepMerge } from '../src/utils/deep-merge.js';

describe('deepMerge', () => {
  it('recursively merges nested objects', () => {
    const base = { a: 1, nested: { x: 10, y: 20 } };
    const custom = { b: 2, nested: { y: 30, z: 40 } };
    const result = deepMerge(base, custom);

    assert.deepEqual(result, {
      a: 1,
      b: 2,
      nested: { x: 10, y: 30, z: 40 }
    });
  });

  it('allows custom arrays to override base arrays', () => {
    const base = { list: [1, 2, 3] };
    const custom = { list: [4, 5] };
    const result = deepMerge(base, custom);

    assert.deepEqual(result, { list: [4, 5] });
  });

  it('allows custom primitives to override base objects', () => {
    const base = { val: { nested: true } };
    const custom = { val: 'simple string' };
    const result = deepMerge(base, custom);

    assert.deepEqual(result, { val: 'simple string' });
  });
});
