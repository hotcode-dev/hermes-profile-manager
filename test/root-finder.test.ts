import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { findProjectRoot } from '../src/utils/root-finder.js';

describe('findProjectRoot', () => {
  let tmpDir: string;

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * Creates a fresh workspace under a unique temp dir with a real
   * `profiles/common` marker at the workspace root. Returns the start dir
   * (workspace root by default, or root/<rel> if given).
   */
  const makeWorkspace = (rel = ''): string => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-test-rootfinder-'));
    const root = path.join(tmpDir, 'workspace');
    fs.mkdirSync(path.join(root, 'profiles', 'common'), { recursive: true });
    return rel ? path.join(root, rel) : root;
  };

  it('finds profiles/common in the immediate parent directory', () => {
    const root = makeWorkspace();
    const child = path.join(root, 'src');
    fs.mkdirSync(child, { recursive: true });

    assert.equal(findProjectRoot(child), root);
  });

  it('walks up multiple levels and resolves to the ancestor containing profiles/common', () => {
    const root = makeWorkspace();
    const deep = path.join(root, 'a', 'b', 'c');
    fs.mkdirSync(deep, { recursive: true });

    assert.equal(findProjectRoot(deep), root);
  });

  it('returns the first (nearest) ancestor hit while walking up, not a deeper one', () => {
    const outer = makeWorkspace();
    const mid = path.join(outer, 'mid');
    fs.mkdirSync(path.join(mid, 'profiles', 'common'), { recursive: true });
    const deep = path.join(mid, 'x', 'y');
    fs.mkdirSync(deep, { recursive: true });

    assert.equal(findProjectRoot(deep), mid);
  });

  it('returns startDir itself when it directly contains profiles/common', () => {
    const root = makeWorkspace();

    assert.equal(findProjectRoot(root), path.resolve(root));
  });

  it('falls back to path.resolve(startDir) when no ancestor contains profiles/common', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-test-rootfinder-'));
    const leaf = path.join(tmpDir, 'empty', 'nested');
    fs.mkdirSync(leaf, { recursive: true });

    assert.equal(findProjectRoot(leaf), path.resolve(leaf));
  });

  it('only a directory named profiles/common triggers a hit — plain files and non-common siblings must not match', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-test-rootfinder-'));
    const start = path.join(tmpDir, 'start');
    fs.mkdirSync(start, { recursive: true });

    // A plain file named `profiles` (not a directory) must not count as a marker.
    fs.writeFileSync(path.join(start, 'profiles'), 'just a file');
    // A directory named `common` that is NOT under `profiles` must not count.
    fs.mkdirSync(path.join(start, 'common'), { recursive: true });

    assert.equal(findProjectRoot(start), path.resolve(start));

    // A sibling `profiles` dir that lacks a `common` subdirectory must not match either.
    const sib = path.join(tmpDir, 'sib');
    fs.mkdirSync(path.join(sib, 'profiles', 'other'), { recursive: true });

    assert.equal(findProjectRoot(sib), path.resolve(sib));
  });

  it('resolves to the workspace root from a deep nested start point (profiles/<name>/cron)', () => {
    const root = makeWorkspace();
    const start = path.join(root, 'profiles', 'agent-a', 'cron');
    fs.mkdirSync(start, { recursive: true });

    assert.equal(findProjectRoot(start), root);
  });
});
