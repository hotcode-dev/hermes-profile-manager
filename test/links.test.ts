import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { linkSkills, linkPlugins, linkHermes } from '../src/core/links.js';

describe('link operations', () => {
  let tmpDir: string;
  let hermesDir: string;
  // Shared escape target the path-traversal regression tests assert on:
  // path.dirname(tmpDir) is the OS temp dir, so <tmpdir>/pwned is SHARED
  // across runs. A stale artifact there would make the "wrote nothing
  // outside the workspace" assertion fail forever.
  const pwnedDir = () => path.join(path.dirname(tmpDir), 'pwned');

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-test-links-'));
    hermesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-test-hermes-'));
    // Hermetic precondition: no stale escape artifact from an earlier run.
    fs.rmSync(pwnedDir(), { recursive: true, force: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(hermesDir, { recursive: true, force: true });
    // Clean the shared escape target (see pwnedDir above).
    fs.rmSync(pwnedDir(), { recursive: true, force: true });
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

  it('dry run creates no symlinks and reports previews, not completed links', () => {
    // Real common skill + plugin sources so a live run WOULD create links.
    fs.mkdirSync(path.join(tmpDir, 'profiles', 'common', 'skills', 'test-skill'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'profiles', 'common', 'plugins', 'test-plugin'), { recursive: true });
    const workerDir = path.join(tmpDir, 'profiles', 'worker');
    fs.mkdirSync(workerDir, { recursive: true });

    const skillLines: string[] = [];
    linkSkills({ rootDir: tmpDir, dryRun: true, logger: (m) => skillLines.push(m) });

    const pluginLines: string[] = [];
    linkPlugins({ rootDir: tmpDir, hermesDir, dryRun: true, logger: (m) => pluginLines.push(m) });

    const hermesLines: string[] = [];
    linkHermes({ rootDir: tmpDir, hermesDir, dryRun: true, logger: (m) => hermesLines.push(m) });

    // No symlinks anywhere under profiles/ or in hermesDir.
    assert.ok(!fs.existsSync(path.join(workerDir, 'skills', 'test-skill')), 'no profile skill link');
    assert.ok(!fs.existsSync(path.join(workerDir, 'plugins', 'test-plugin')), 'no profile plugin link');
    assert.ok(!fs.existsSync(path.join(hermesDir, 'plugins', 'test-plugin')), 'no hermes plugin link');
    assert.ok(!fs.existsSync(path.join(hermesDir, 'profiles')), 'no hermes profiles link');

    // None of the log lines claim a link was created.
    for (const lines of [skillLines, pluginLines, hermesLines]) {
      assert.ok(!lines.some((l) => l.includes('Linked ')), `no "Linked" claim in:\n${lines.join('\n')}`);
      assert.ok(lines.every((l) => l.startsWith('Would link ')), `preview wording in:\n${lines.join('\n')}`);
    }
  });

  it('linkSkills rejects a path-traversal profile name BEFORE creating any symlink', () => {
    // SECURITY REGRESSION (path traversal via user-controlled -p/--profiles):
    // path.join(profilesDir, '../../pwned', 'skills', <skill>) resolves
    // OUTSIDE the workspace (to <tmpdir>/pwned/skills/...). Without the fix,
    // a pre-seeded common skill source would make linkSkills create symlinks
    // at the attacker-chosen location. The name must be rejected first.
    fs.mkdirSync(path.join(tmpDir, 'profiles', 'common', 'skills', 'test-skill'), { recursive: true });
    const escapeDir = pwnedDir();
    assert.ok(!fs.existsSync(escapeDir), 'precondition: shared escape target must not exist yet');

    assert.throws(
      () => linkSkills({ rootDir: tmpDir, profiles: ['../../pwned'], logger: () => {} }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /Invalid profile name: "\.\.\/\.\.\/pwned"/);
        return true;
      }
    );
    // No symlink (and no directory) may have been created outside the
    // workspace, and the workspace itself must be untouched.
    assert.ok(!fs.existsSync(escapeDir), `nothing may be created outside the workspace (found: ${escapeDir})`);
    assert.ok(!fs.existsSync(path.join(tmpDir, 'profiles', 'pwned')), 'no in-workspace escape either');
  });

  it('linkPlugins rejects a path-traversal profile name BEFORE creating any symlink', () => {
    // SECURITY REGRESSION (same vector, plugin concern): without the fix,
    // linkPlugins would create symlinks under <tmpdir>/pwned/plugins/ and
    // in hermesDir. The name must be rejected before any side effect.
    fs.mkdirSync(path.join(tmpDir, 'profiles', 'common', 'plugins', 'test-plugin'), { recursive: true });
    const escapeDir = pwnedDir();
    assert.ok(!fs.existsSync(escapeDir), 'precondition: shared escape target must not exist yet');

    assert.throws(
      () => linkPlugins({ rootDir: tmpDir, hermesDir, profiles: ['../../pwned'], logger: () => {} }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /Invalid profile name: "\.\.\/\.\.\/pwned"/);
        return true;
      }
    );
    assert.ok(!fs.existsSync(escapeDir), `nothing may be created outside the workspace (found: ${escapeDir})`);
    // The hermes-side plugin dir is also a side effect the validation must
    // precede.
    assert.ok(!fs.existsSync(path.join(hermesDir, 'plugins')), 'no hermes-side plugin links on rejection');
  });

  it('prunes dangling symlinks left by a renamed common skill and keeps real dirs untouched', () => {
    const common = path.join(tmpDir, 'profiles', 'common', 'skills');
    fs.mkdirSync(path.join(common, 'alpha'), { recursive: true });
    const workerSkills = path.join(tmpDir, 'profiles', 'worker', 'skills');
    fs.mkdirSync(workerSkills, { recursive: true });

    const lines: string[] = [];
    linkSkills({ rootDir: tmpDir, logger: (m) => lines.push(m) });
    const alphaLink = path.join(workerSkills, 'alpha');
    assert.ok(fs.lstatSync(alphaLink).isSymbolicLink());

    // A profile-local real directory that pruning must never touch.
    fs.mkdirSync(path.join(workerSkills, 'local-only'), { recursive: true });
    fs.writeFileSync(path.join(workerSkills, 'local-only', 'data.txt'), 'keep me');

    // The user renames the shared skill.
    fs.renameSync(path.join(common, 'alpha'), path.join(common, 'beta'));

    linkSkills({ rootDir: tmpDir, logger: (m) => lines.push(m) });

    // The dangling alpha link is gone and its removal is logged.
    assert.throws(() => fs.lstatSync(alphaLink), { code: 'ENOENT' });
    assert.ok(
      lines.some((l) => l.startsWith('Removed stale symlink:') && l.includes(alphaLink)),
      `expected a "Removed stale symlink" line for ${alphaLink} in:\n${lines.join('\n')}`
    );

    // The renamed skill is linked normally.
    assert.equal(fs.readlinkSync(path.join(workerSkills, 'beta')), '../../common/skills/beta');

    // The real directory is left completely alone (no prune, no backup).
    assert.ok(fs.statSync(path.join(workerSkills, 'local-only')).isDirectory());
    assert.equal(fs.readFileSync(path.join(workerSkills, 'local-only', 'data.txt'), 'utf8'), 'keep me');
  });

  it('prunes dangling symlinks left by a renamed common plugin (profile and ~/.hermes/plugins)', () => {
    const common = path.join(tmpDir, 'profiles', 'common', 'plugins');
    fs.mkdirSync(path.join(common, 'alpha'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'profiles', 'worker'), { recursive: true });

    const lines: string[] = [];
    linkPlugins({ rootDir: tmpDir, hermesDir, logger: (m) => lines.push(m) });
    const profileLink = path.join(tmpDir, 'profiles', 'worker', 'plugins', 'alpha');
    const hermesLink = path.join(hermesDir, 'plugins', 'alpha');
    assert.ok(fs.lstatSync(profileLink).isSymbolicLink());
    assert.ok(fs.lstatSync(hermesLink).isSymbolicLink());

    fs.renameSync(path.join(common, 'alpha'), path.join(common, 'beta'));

    linkPlugins({ rootDir: tmpDir, hermesDir, logger: (m) => lines.push(m) });

    // Both dangling links are gone and both removals are logged.
    assert.throws(() => fs.lstatSync(profileLink), { code: 'ENOENT' });
    assert.throws(() => fs.lstatSync(hermesLink), { code: 'ENOENT' });
    assert.ok(
      lines.some((l) => l.startsWith('Removed stale symlink:') && l.includes(hermesLink)),
      `expected a "Removed stale symlink" line for ${hermesLink} in:\n${lines.join('\n')}`
    );

    // The renamed plugin is linked in both places.
    assert.equal(fs.readlinkSync(path.join(tmpDir, 'profiles', 'worker', 'plugins', 'beta')), '../../common/plugins/beta');
    assert.equal(fs.readlinkSync(path.join(hermesDir, 'plugins', 'beta')), path.join(common, 'beta'));
  });

  it('dry run reports stale symlinks without removing them; the next live run removes them', () => {
    const common = path.join(tmpDir, 'profiles', 'common', 'skills');
    fs.mkdirSync(path.join(common, 'alpha'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'profiles', 'worker'), { recursive: true });

    linkSkills({ rootDir: tmpDir, logger: () => {} });
    const alphaLink = path.join(tmpDir, 'profiles', 'worker', 'skills', 'alpha');
    const betaLink = path.join(tmpDir, 'profiles', 'worker', 'skills', 'beta');

    fs.renameSync(path.join(common, 'alpha'), path.join(common, 'beta'));

    const dryLines: string[] = [];
    linkSkills({ rootDir: tmpDir, dryRun: true, logger: (m) => dryLines.push(m) });

    // Reported as a preview, but nothing is removed or created.
    assert.ok(
      dryLines.some((l) => l.startsWith('Would remove stale symlink:') && l.includes(alphaLink)),
      `expected a "Would remove stale symlink" line in:\n${dryLines.join('\n')}`
    );
    assert.ok(!dryLines.some((l) => l.startsWith('Removed ')), 'dry run must not claim removals');
    assert.ok(fs.lstatSync(alphaLink).isSymbolicLink(), 'dangling link must survive the dry run');
    assert.ok(!fs.existsSync(betaLink), 'dry run must not create the new link');

    const liveLines: string[] = [];
    linkSkills({ rootDir: tmpDir, logger: (m) => liveLines.push(m) });

    // The live run removes the stale link, links the renamed skill, and logs it.
    assert.throws(() => fs.lstatSync(alphaLink), { code: 'ENOENT' });
    assert.ok(
      liveLines.some((l) => l.startsWith('Removed stale symlink:') && l.includes(alphaLink)),
      `expected a "Removed stale symlink" line in:\n${liveLines.join('\n')}`
    );
    assert.equal(fs.readlinkSync(betaLink), '../../common/skills/beta');
  });

  it('rejects other traversal-shaped profile names (.., ./x, a/b) with the same clean error', () => {
    for (const name of ['..', './x', 'a/b']) {
      assert.throws(
        () => linkSkills({ rootDir: tmpDir, profiles: [name], logger: () => {} }),
        /Invalid profile name/,
        `linkSkills expected "${name}" to be rejected`
      );
      assert.throws(
        () => linkPlugins({ rootDir: tmpDir, hermesDir, profiles: [name], logger: () => {} }),
        /Invalid profile name/,
        `linkPlugins expected "${name}" to be rejected`
      );
    }
    assert.ok(!fs.existsSync(pwnedDir()), 'nothing may have been created outside the workspace');
  });

  it('linkSkills/linkPlugins reject the reserved name "common" BEFORE the self-symlink corruption', () => {
    // RESERVED-NAME REGRESSION (probe 3 of zf-hpm-e420a204): with a skill at
    // profiles/common/skills/myskill, `linkSkills -p common` used to see the
    // real shared dir at the SAME path as the link target, move the ACTUAL
    // shared skill aside to myskill.hpm-backup.<ts>, and replace it with a
    // self-referential symlink (../../common/skills/myskill) — leaving the
    // shared skill dangling for EVERY profile. The reserved name must be
    // rejected during the up-front validation loop, before any rename or
    // symlink side effect.
    const commonSkillDir = path.join(tmpDir, 'profiles', 'common', 'skills', 'myskill');
    fs.mkdirSync(commonSkillDir, { recursive: true });
    fs.writeFileSync(path.join(commonSkillDir, 'SKILL.md'), '# myskill\n');
    const commonPluginDir = path.join(tmpDir, 'profiles', 'common', 'plugins', 'myplugin');
    fs.mkdirSync(commonPluginDir, { recursive: true });
    fs.writeFileSync(path.join(commonPluginDir, 'README.md'), '# myplugin\n');

    for (const invoke of [
      () => linkSkills({ rootDir: tmpDir, profiles: ['common'], logger: () => {} }),
      () => linkPlugins({ rootDir: tmpDir, hermesDir, profiles: ['common'], logger: () => {} })
    ]) {
      assert.throws(
        invoke,
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.match(err.message, /Invalid profile name: "common"/);
          assert.match(err.message, /reserved for the shared common profile directory/);
          return true;
        }
      );
    }

    // The shared skill is still the REAL directory (no self-symlink, no
    // .hpm-backup move): no symlink anywhere under the shared skills dir and
    // no hpm-backup artifact was created.
    assert.ok(!fs.lstatSync(commonSkillDir).isSymbolicLink(), 'shared skill must not have become a symlink');
    assert.equal(
      fs.readdirSync(path.join(tmpDir, 'profiles', 'common', 'skills')).filter((n) => n.includes('hpm-backup')).length,
      0,
      'no .hpm-backup artifact may have been created'
    );
    assert.ok(!fs.lstatSync(commonPluginDir).isSymbolicLink(), 'shared plugin must not have become a symlink');
    // The shared sources are byte-for-byte intact.
    assert.equal(fs.readFileSync(path.join(commonSkillDir, 'SKILL.md'), 'utf8'), '# myskill\n');
    assert.equal(fs.readFileSync(path.join(commonPluginDir, 'README.md'), 'utf8'), '# myplugin\n');
  });
});
