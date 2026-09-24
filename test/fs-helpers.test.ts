import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ensureSymlinkSync, atomicWriteFileSync, getProfileNames } from '../src/utils/fs-helpers.js';

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

describe('atomicWriteFileSync', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-test-awf-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const tmpFilesIn = (dir: string): string[] =>
    fs.readdirSync(dir).filter((name) => name.endsWith('.tmp'));

  it('writes content to the target path', () => {
    const target = path.join(tmpDir, 'out.yaml');
    atomicWriteFileSync(target, 'key: value\n');
    assert.equal(fs.readFileSync(target, 'utf8'), 'key: value\n');
  });

  it('creates missing parent directories', () => {
    const target = path.join(tmpDir, 'a', 'b', 'c', 'out.yaml');
    atomicWriteFileSync(target, 'nested\n');
    assert.equal(fs.readFileSync(target, 'utf8'), 'nested\n');
  });

  it('overwrites an existing file fully', () => {
    const target = path.join(tmpDir, 'out.yaml');
    fs.writeFileSync(target, 'old, much longer content\n'.repeat(100), 'utf8');

    atomicWriteFileSync(target, 'new\n');

    assert.equal(fs.readFileSync(target, 'utf8'), 'new\n');
  });

  it('leaves no .tmp files behind after success', () => {
    const target = path.join(tmpDir, 'out.yaml');
    atomicWriteFileSync(target, 'one\n');
    atomicWriteFileSync(target, 'two\n');

    assert.equal(tmpFilesIn(tmpDir).length, 0, 'no .tmp litter expected after successful writes');
    assert.equal(fs.readFileSync(target, 'utf8'), 'two\n');
  });

  it('throws and removes the temp file when the rename fails', () => {
    // Pre-create a directory at the target path: writeFileSync of the temp
    // file (sibling of the target, in the same dir) succeeds, but
    // renameSync onto a directory throws, exercising the cleanup path
    // without mocking fs.
    const targetPath = path.join(tmpDir, 'occupied');
    fs.mkdirSync(targetPath, { recursive: true });

    assert.throws(
      () => atomicWriteFileSync(targetPath, 'x\n'),
      /ENOENT|EACCES|EPERM|EISDIR|ENOTDIR/,
    );

    // The directory must be untouched and no .tmp file may linger beside it.
    assert.ok(fs.lstatSync(targetPath).isDirectory(), 'existing dir must survive a failed write');
    assert.equal(tmpFilesIn(tmpDir).length, 0, 'failed write must not leave .tmp files');
  });
});

describe('getProfileNames', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-test-gpn-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns [] when the profiles dir does not exist', () => {
    assert.deepEqual(getProfileNames(path.join(tmpDir, 'nope')), []);
  });

  it('lists profile dirs, sorted', () => {
    const profilesDir = path.join(tmpDir, 'profiles');
    fs.mkdirSync(profilesDir, { recursive: true });
    fs.mkdirSync(path.join(profilesDir, 'zeta'));
    fs.mkdirSync(path.join(profilesDir, 'alpha'));
    fs.mkdirSync(path.join(profilesDir, 'mid'));

    assert.deepEqual(getProfileNames(profilesDir), ['alpha', 'mid', 'zeta']);
  });

  it('excludes common, hidden dirs, plain files, and symlinks', () => {
    const profilesDir = path.join(tmpDir, 'profiles');
    fs.mkdirSync(profilesDir, { recursive: true });
    fs.mkdirSync(path.join(profilesDir, 'common'));
    fs.mkdirSync(path.join(profilesDir, '.hidden'));
    fs.mkdirSync(path.join(profilesDir, 'good1'));
    fs.mkdirSync(path.join(profilesDir, 'good2'));
    fs.writeFileSync(path.join(profilesDir, 'stray.txt'), 'not a dir');
    // Symlink to a real directory elsewhere: lstat-based discovery must
    // exclude it (entry.isDirectory() is false for symlinks).
    const outsideDir = path.join(tmpDir, 'outside');
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.symlinkSync(outsideDir, path.join(profilesDir, 'linked'), 'dir');
    // Symlink to a plain file too.
    fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'x');
    fs.symlinkSync(path.join(tmpDir, 'file.txt'), path.join(profilesDir, 'filelink'));

    assert.deepEqual(getProfileNames(profilesDir), ['good1', 'good2']);
  });
});
