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
});
