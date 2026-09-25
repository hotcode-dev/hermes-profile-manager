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

  it('shares no references with the override input', () => {
    const base: Record<string, unknown> = { keep: 1 };
    const custom: Record<string, unknown> = {
      fresh: { inner: [1, 2], deep: { leaf: 7 } },
      list: [3, 4],
      nested: { y: 30 }
    };
    const result = deepMerge(base, custom);

    const fresh = result.fresh as Record<string, unknown>;
    const customFresh = custom.fresh as Record<string, unknown>;
    // Object value absent from base: top level and nested must be fresh copies
    assert.notEqual(fresh, customFresh);
    assert.notEqual(fresh.inner, customFresh.inner);
    assert.notEqual(fresh.deep, customFresh.deep);
    // Array override: must be a fresh copy
    assert.notEqual(result.list, custom.list);
    // Recursive-merge branch must also produce a fresh object
    assert.notEqual(result.nested, custom.nested);
  });

  it('shares no references with the base input', () => {
    const base: Record<string, unknown> = { keep: { inner: [1, 2] }, baseList: [5, 6] };
    const custom: Record<string, unknown> = { other: true };
    const result = deepMerge(base, custom);

    const keep = result.keep as Record<string, unknown>;
    const baseKeep = base.keep as Record<string, unknown>;
    assert.notEqual(keep, baseKeep);
    assert.notEqual(keep.inner, baseKeep.inner);
    assert.notEqual(result.baseList, base.baseList);
  });

  it('does not change the merged result when inputs are mutated after the call', () => {
    const base: Record<string, unknown> = { fromBase: { a: 1 }, shared: { x: 1 } };
    const custom: Record<string, unknown> = { fromOverride: { b: 2 }, shared: { x: 9 } };
    const result = deepMerge(base, custom);
    const snapshot = structuredClone(result);

    (base.fromBase as { a: number }).a = 999;
    (base.shared as { x: number }).x = 999;
    base.fromBase = { hijacked: true };
    (custom.fromOverride as { b: number }).b = 999;
    (custom.shared as { x: number }).x = 999;
    custom.fromOverride = { hijacked: true };

    assert.deepEqual(result, snapshot);
    assert.equal((result.shared as { x: number }).x, 9);
  });

  it('does not change either input when the merged result is mutated', () => {
    const base: Record<string, unknown> = { a: 1, nested: { x: 10 } };
    const custom: Record<string, unknown> = { override: { b: 1 }, nested: { y: 20 } };
    const baseBefore = structuredClone(base);
    const customBefore = structuredClone(custom);
    const result = deepMerge(base, custom);

    (result.nested as Record<string, unknown>).x = 999;
    (result.nested as Record<string, unknown>).y = 999;
    result.nested = { corrupted: true };
    (result.override as Record<string, unknown>).b = 999;
    result.override = { corrupted: true };
    result.a = 999;

    assert.deepEqual(base, baseBefore);
    assert.deepEqual(custom, customBefore);
  });
});
