import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ensureSymlinkSync } from '../src/utils/fs-helpers.js';

describe('ensureSymlinkSync', () => {
  let tmpDir: string;
  let target: string;
  let linkPath: string;
  let warnings: string[];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-test-fsh-'));
    target = path.join(tmpDir, 'target');
    fs.mkdirSync(target, { recursive: true });
    linkPath = path.join(tmpDir, 'link');
    warnings = [];
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const log = (msg: string) => warnings.push(msg);

  it('is a no-op when the symlink already points at the target', () => {
    ensureSymlinkSync(target, linkPath, { logger: log });
    ensureSymlinkSync(target, linkPath, { logger: log });

    assert.ok(fs.lstatSync(linkPath).isSymbolicLink());
    assert.equal(fs.readlinkSync(linkPath), target);
    assert.equal(warnings.length, 0, 'no-op must not warn or log');
  });

  it('replaces a symlink that points at a different target', () => {
    const otherTarget = path.join(tmpDir, 'other');
    fs.mkdirSync(otherTarget, { recursive: true });
    ensureSymlinkSync(otherTarget, linkPath, { logger: log });

    ensureSymlinkSync(target, linkPath, { logger: log });

    assert.ok(fs.lstatSync(linkPath).isSymbolicLink());
    assert.equal(fs.readlinkSync(linkPath), target);
  });

  it('removes a colliding plain file (and logs the removal)', () => {
    fs.writeFileSync(linkPath, 'i am a file, not a dir');

    ensureSymlinkSync(target, linkPath, { logger: log });

    assert.ok(fs.lstatSync(linkPath).isSymbolicLink());
    assert.equal(fs.readlinkSync(linkPath), target);
    assert.ok(warnings.some((w) => w.includes('Removed existing file')), 'expected a log about the removed file');
  });

  it('backs up a colliding real directory instead of deleting it', () => {
    // Real directory with user content.
    fs.mkdirSync(linkPath, { recursive: true });
    fs.writeFileSync(path.join(linkPath, 'data.txt'), 'keep me');
    fs.mkdirSync(path.join(linkPath, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(linkPath, 'sub', 'nested.txt'), 'keep me too');

    ensureSymlinkSync(target, linkPath, { logger: log });

    // Original dir is gone from linkPath...
    assert.ok(fs.lstatSync(linkPath).isSymbolicLink());
    assert.equal(fs.readlinkSync(linkPath), target);

    // ...but its contents are preserved in a backup sibling.
    const backups = fs.readdirSync(tmpDir).filter((name) => name.startsWith('link.hpm-backup.'));
    assert.equal(backups.length, 1, 'expected exactly one backup directory');
    assert.equal(fs.readFileSync(path.join(tmpDir, backups[0], 'data.txt'), 'utf8'), 'keep me');
    assert.equal(fs.readFileSync(path.join(tmpDir, backups[0], 'sub', 'nested.txt'), 'utf8'), 'keep me too');
    assert.ok(warnings.some((w) => w.includes('preserved') && w.includes(backups[0])),
      'expected a prominent warning naming the backup path');
  });
});
