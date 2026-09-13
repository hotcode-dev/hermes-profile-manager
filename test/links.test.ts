import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { linkSkills, linkPlugins, linkHermes } from '../src/core/links.js';

describe('link operations', () => {
  let tmpDir: string;
  let hermesDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-test-links-'));
    hermesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-test-hermes-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(hermesDir, { recursive: true, force: true });
  });

  it('creates relative symlinks for common skills', () => {
    const commonSkills = path.join(tmpDir, 'profiles', 'common', 'skills', 'test-skill');
    fs.mkdirSync(commonSkills, { recursive: true });
    fs.writeFileSync(path.join(commonSkills, 'SKILL.md'), 'skill');

    const workerDir = path.join(tmpDir, 'profiles', 'worker');
    fs.mkdirSync(workerDir, { recursive: true });

    linkSkills({ rootDir: tmpDir, logger: () => {} });

    const workerSkillLink = path.join(workerDir, 'skills', 'test-skill');
    assert.ok(fs.existsSync(workerSkillLink));
    const lstat = fs.lstatSync(workerSkillLink);
    assert.ok(lstat.isSymbolicLink());
    const target = fs.readlinkSync(workerSkillLink);
    assert.equal(target, '../../common/skills/test-skill');
  });

  it('creates relative links for profile plugins and absolute for hermes plugins', () => {
    const commonPlugins = path.join(tmpDir, 'profiles', 'common', 'plugins', 'test-plugin');
    fs.mkdirSync(commonPlugins, { recursive: true });
    fs.writeFileSync(path.join(commonPlugins, 'index.py'), '# plugin');

    const workerDir = path.join(tmpDir, 'profiles', 'worker');
    fs.mkdirSync(workerDir, { recursive: true });

    linkPlugins({ rootDir: tmpDir, hermesDir, logger: () => {} });

    // Profile link
    const workerPluginLink = path.join(workerDir, 'plugins', 'test-plugin');
    assert.ok(fs.existsSync(workerPluginLink));
    assert.ok(fs.lstatSync(workerPluginLink).isSymbolicLink());
    assert.equal(fs.readlinkSync(workerPluginLink), '../../common/plugins/test-plugin');

    // Hermes link
    const hermesPluginLink = path.join(hermesDir, 'plugins', 'test-plugin');
    assert.ok(fs.existsSync(hermesPluginLink));
    assert.ok(fs.lstatSync(hermesPluginLink).isSymbolicLink());
    assert.equal(fs.readlinkSync(hermesPluginLink), commonPlugins);
  });

  it('links profiles directory to hermes home directory', () => {
    const profilesDir = path.join(tmpDir, 'profiles');
    fs.mkdirSync(profilesDir, { recursive: true });

    linkHermes({ rootDir: tmpDir, hermesDir, logger: () => {} });

    const dest = path.join(hermesDir, 'profiles');
    assert.ok(fs.existsSync(dest));
    assert.ok(fs.lstatSync(dest).isSymbolicLink());
    assert.equal(fs.readlinkSync(dest), profilesDir);
  });

  it('preserves a real skills directory that collides with a common skill (no data loss)', () => {
    const commonSkills = path.join(tmpDir, 'profiles', 'common', 'skills', 'shared-skill');
    fs.mkdirSync(commonSkills, { recursive: true });
    fs.writeFileSync(path.join(commonSkills, 'SKILL.md'), 'common skill');

    // Profile-local real directory (not a symlink) with user files inside.
    const profileSkillDir = path.join(tmpDir, 'profiles', 'worker', 'skills', 'shared-skill');
    fs.mkdirSync(profileSkillDir, { recursive: true });
    fs.writeFileSync(path.join(profileSkillDir, 'user-notes.txt'), 'precious user data');
    fs.mkdirSync(path.join(profileSkillDir, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(profileSkillDir, 'nested', 'deep.txt'), 'nested data');

    const warnings: string[] = [];
    linkSkills({ rootDir: tmpDir, logger: (msg) => warnings.push(msg) });

    // (a) The user's files must NOT be destroyed — they live in a backup dir.
    const backups = fs.readdirSync(path.join(tmpDir, 'profiles', 'worker', 'skills'))
      .filter((name) => name.startsWith('shared-skill.hpm-backup.'));
    assert.equal(backups.length, 1, 'expected exactly one backup directory');
    assert.equal(
      fs.readFileSync(path.join(profileSkillDir, '..', backups[0], 'user-notes.txt'), 'utf8'),
      'precious user data'
    );
    assert.equal(
      fs.readFileSync(path.join(profileSkillDir, '..', backups[0], 'nested', 'deep.txt'), 'utf8'),
      'nested data'
    );
    assert.ok(warnings.some((w) => w.includes('preserved') && w.includes(backups[0])),
      'expected a prominent warning pointing at the backup path');

    // (b) The link ends up pointing at the common skill.
    const lstat = fs.lstatSync(profileSkillDir);
    assert.ok(lstat.isSymbolicLink());
    assert.equal(fs.readlinkSync(profileSkillDir), '../../common/skills/shared-skill');
  });

  it('preserves a real plugins directory that collides with a common plugin (no data loss)', () => {
    const commonPlugins = path.join(tmpDir, 'profiles', 'common', 'plugins', 'shared-plugin');
    fs.mkdirSync(commonPlugins, { recursive: true });
    fs.writeFileSync(path.join(commonPlugins, 'index.py'), '# common plugin');

    const profilePluginDir = path.join(tmpDir, 'profiles', 'worker', 'plugins', 'shared-plugin');
    fs.mkdirSync(profilePluginDir, { recursive: true });
    fs.writeFileSync(path.join(profilePluginDir, 'custom.config'), 'local plugin config');

    const hermesPluginDir = path.join(hermesDir, 'plugins', 'shared-plugin');
    fs.mkdirSync(hermesPluginDir, { recursive: true });
    fs.writeFileSync(path.join(hermesPluginDir, 'live-state.json'), '{"installed":true}');

    const warnings: string[] = [];
    linkPlugins({ rootDir: tmpDir, hermesDir, logger: (msg) => warnings.push(msg) });

    // Profile-side real dir preserved.
    const profileBackups = fs.readdirSync(path.join(tmpDir, 'profiles', 'worker', 'plugins'))
      .filter((name) => name.startsWith('shared-plugin.hpm-backup.'));
    assert.equal(profileBackups.length, 1);
    assert.equal(
      fs.readFileSync(path.join(profilePluginDir, '..', profileBackups[0], 'custom.config'), 'utf8'),
      'local plugin config'
    );

    // Hermes-side real dir preserved (running Hermes home must not be clobbered).
    const hermesBackups = fs.readdirSync(path.join(hermesDir, 'plugins'))
      .filter((name) => name.startsWith('shared-plugin.hpm-backup.'));
    assert.equal(hermesBackups.length, 1);
    assert.equal(
      fs.readFileSync(path.join(hermesPluginDir, '..', hermesBackups[0], 'live-state.json'), 'utf8'),
      '{"installed":true}'
    );
    assert.ok(warnings.length >= 2, 'expected warnings for both collisions');

    // Links now point at the common plugin.
    assert.equal(fs.readlinkSync(profilePluginDir), '../../common/plugins/shared-plugin');
    assert.equal(fs.readlinkSync(hermesPluginDir), commonPlugins);
  });

  it('preserves a real ~/.hermes/profiles directory before linking (no data loss)', () => {
    const profilesDir = path.join(tmpDir, 'profiles');
    fs.mkdirSync(profilesDir, { recursive: true });

    // A real (non-symlink) profiles directory already exists in hermesDir.
    const realProfiles = path.join(hermesDir, 'profiles');
    fs.mkdirSync(realProfiles, { recursive: true });
    fs.writeFileSync(path.join(realProfiles, 'existing-profile-data.txt'), 'do not lose me');

    const warnings: string[] = [];
    linkHermes({ rootDir: tmpDir, hermesDir, logger: (msg) => warnings.push(msg) });

    // Original contents preserved in a backup.
    const backups = fs.readdirSync(hermesDir).filter((name) => name.startsWith('profiles.hpm-backup.'));
    assert.equal(backups.length, 1);
    assert.equal(
      fs.readFileSync(path.join(hermesDir, backups[0], 'existing-profile-data.txt'), 'utf8'),
      'do not lose me'
    );
    assert.ok(warnings.some((w) => w.includes('preserved') && w.includes(backups[0])));

    // dest is now the symlink.
    assert.ok(fs.lstatSync(realProfiles).isSymbolicLink());
    assert.equal(fs.readlinkSync(realProfiles), profilesDir);
  });
});
