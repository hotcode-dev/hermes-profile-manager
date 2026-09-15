import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parse as parseYaml } from 'yaml';
import { syncAll, mergeAll, linkAll, SyncAllResult } from '../src/core/sync.js';
import { mergeJobs } from '../src/core/jobs.js';
import { mergeSoul } from '../src/core/soul.js';
import { mergeConfig } from '../src/core/config.js';

/**
 * Builds a minimal but valid workspace skeleton under rootDir:
 *   profiles/common/config.yaml
 *   profiles/common/SOUL.md
 *   profiles/common/skills/   (dir, so linkSkills is a no-op)
 *   profiles/common/plugins/  (dir, so linkPlugins is a no-op)
 */
function scaffoldCommon(rootDir: string): void {
  const commonDir = path.join(rootDir, 'profiles', 'common');
  fs.mkdirSync(path.join(commonDir, 'skills'), { recursive: true });
  fs.mkdirSync(path.join(commonDir, 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(commonDir, 'config.yaml'), `\nmodel: "default"\ntemperature: 0.5\n`);
  fs.writeFileSync(path.join(commonDir, 'SOUL.md'), '# Common Base\n');
}

describe('syncAll / mergeAll aggregate behavior', () => {
  let tmpDir: string;
  let hermesDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-test-sync-'));
    hermesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-test-hermes-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(hermesDir, { recursive: true, force: true });
  });

  it('succeeds when the profile has config custom but NO cron/jobs.custom.json and NO SOUL.custom.md', () => {
    scaffoldCommon(tmpDir);
    const mainDir = path.join(tmpDir, 'profiles', 'main');
    fs.mkdirSync(mainDir, { recursive: true });
    fs.writeFileSync(
      path.join(mainDir, 'config.custom.yaml'),
      `model: "custom-model"\ntemperature: 0.9\n`
    );
    // Deliberately no cron/jobs.custom.json and no SOUL.custom.md.

    // Regression target: this used to throw "no profiles with cron/jobs.custom.json found".
    const result: SyncAllResult = syncAll({ rootDir: tmpDir, hermesDir, logger: () => {} });

    // Config was merged and written.
    const configOutput = path.join(mainDir, 'config.yaml');
    assert.ok(fs.existsSync(configOutput));
    const parsed = parseYaml(fs.readFileSync(configOutput, 'utf8'));
    assert.equal(parsed.model, 'custom-model');
    assert.equal(parsed.temperature, 0.9);
    assert.equal(result.config.length, 1);
    assert.equal(result.config[0].status, 'merged');

    // Jobs and soul are benign no-ops (empty result lists, not errors).
    assert.deepEqual(result.jobs, []);
    assert.deepEqual(result.soul, []);
  });

  it('succeeds when the profile has ONLY cron/jobs.custom.json (no config/soul custom)', () => {
    scaffoldCommon(tmpDir);
    const mainDir = path.join(tmpDir, 'profiles', 'main');
    const cronDir = path.join(mainDir, 'cron');
    fs.mkdirSync(cronDir, { recursive: true });
    fs.writeFileSync(
      path.join(cronDir, 'jobs.custom.json'),
      JSON.stringify({ jobs: [{ id: '1', name: 'only_job' }] }) + '\n'
    );
    // Deliberately no config.custom.yaml and no SOUL.custom.md.

    const result: SyncAllResult = syncAll({ rootDir: tmpDir, hermesDir, logger: () => {} });

    // Jobs merged and written.
    const jobsOutput = path.join(cronDir, 'jobs.json');
    assert.ok(fs.existsSync(jobsOutput));
    const jobsParsed = JSON.parse(fs.readFileSync(jobsOutput, 'utf8'));
    assert.equal(jobsParsed.jobs.length, 1);
    assert.equal(jobsParsed.jobs[0].id, '1');
    assert.equal(result.jobs.length, 1);
    assert.equal(result.jobs[0].status, 'merged');

    // Config/soul custom sources absent: config reports a per-profile skipped
    // entry (not a throw), soul is an empty no-op. No config output written.
    assert.equal(result.soul.length, 0);
    assert.equal(result.config.length, 1);
    assert.equal(result.config[0].status, 'skipped');
    assert.ok(!fs.existsSync(path.join(mainDir, 'config.yaml')));
  });

  it('completes without throwing when profiles dir has NO profile subdirs (config/jobs/soul all empty no-ops)', () => {
    scaffoldCommon(tmpDir);
    // Deliberately no profile subdirs other than common.

    // Regression target: mergeAll/syncAll used to throw "No profiles found
    // under .../profiles" from the standalone config guard, even though the
    // aggregate path forces allowEmpty: true (jobs/soul were already no-op).
    const result: SyncAllResult = syncAll({ rootDir: tmpDir, hermesDir, logger: () => {} });
    assert.deepEqual(result.config, []);
    assert.deepEqual(result.jobs, []);
    assert.deepEqual(result.soul, []);
  });

  it('mergeAll propagates no-throw semantics without touching links', () => {
    scaffoldCommon(tmpDir);
    const mainDir = path.join(tmpDir, 'profiles', 'main');
    fs.mkdirSync(mainDir, { recursive: true });
    fs.writeFileSync(path.join(mainDir, 'config.custom.yaml'), `temperature: 0.1\n`);

    const out = mergeAll({ rootDir: tmpDir, logger: () => {} });
    assert.equal(out.config.length, 1);
    assert.deepEqual(out.jobs, []);
    assert.deepEqual(out.soul, []);
  });

  it('preserves per-profile skipped/error entries and dryRun in the aggregate', () => {
    scaffoldCommon(tmpDir);
    // Profile A has a valid custom config; profile B has none.
    const aDir = path.join(tmpDir, 'profiles', 'alpha');
    const bDir = path.join(tmpDir, 'profiles', 'beta');
    fs.mkdirSync(aDir, { recursive: true });
    fs.mkdirSync(bDir, { recursive: true });
    fs.writeFileSync(path.join(aDir, 'config.custom.yaml'), `temperature: 0.3\n`);

    const dry = syncAll({ rootDir: tmpDir, hermesDir, dryRun: true, logger: () => {} });
    assert.equal(dry.config.length, 2);
    const alpha = dry.config.find((r) => r.profile === 'alpha');
    const beta = dry.config.find((r) => r.profile === 'beta');
    assert.equal(alpha?.status, 'merged');
    assert.equal(beta?.status, 'skipped');
    // dryRun: nothing written.
    assert.ok(!fs.existsSync(path.join(aDir, 'config.yaml')));
    assert.ok(!fs.existsSync(path.join(bDir, 'config.yaml')));

    // Now a real run writes alpha and keeps beta skipped.
    const live = syncAll({ rootDir: tmpDir, hermesDir, logger: () => {} });
    assert.ok(fs.existsSync(path.join(aDir, 'config.yaml')));
    assert.ok(!fs.existsSync(path.join(bDir, 'config.yaml')));
  });
});

describe('linkAll / syncAll capture link failures without throwing', () => {
  let tmpDir: string;
  let hermesDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-test-sync-link-'));
    hermesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-test-hermes-link-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(hermesDir, { recursive: true, force: true });
  });

  it('linkAll captures a missing skills source dir as a linkError instead of throwing', () => {
    scaffoldCommon(tmpDir);
    // profiles/common/plugins is present (scaffoldCommon made it), but the
    // skills source dir is stripped so linkSkills throws internally.
    fs.rmSync(path.join(tmpDir, 'profiles', 'common', 'skills'), { recursive: true, force: true });

    // The regression target: linkAll used to throw, which made syncAll abort
    // before the CLI could report the merge results.
    const out = linkAll({ rootDir: tmpDir, hermesDir, logger: () => {} });
    assert.equal(out.skills.length, 0);
    assert.equal(out.linkErrors.length, 1);
    assert.match(out.linkErrors[0], /Common skills directory not found/);
  });

  it('linkAll captures a missing plugins source dir as a linkError instead of throwing', () => {
    scaffoldCommon(tmpDir);
    fs.rmSync(path.join(tmpDir, 'profiles', 'common', 'plugins'), { recursive: true, force: true });

    const out = linkAll({ rootDir: tmpDir, hermesDir, logger: () => {} });
    assert.equal(out.linkErrors.length, 1);
    assert.match(out.linkErrors[0], /Common plugins directory not found/);
  });

  it('linkAll captures BOTH missing skills and plugins source dirs as separate linkErrors', () => {
    scaffoldCommon(tmpDir);
    fs.rmSync(path.join(tmpDir, 'profiles', 'common', 'skills'), { recursive: true, force: true });
    fs.rmSync(path.join(tmpDir, 'profiles', 'common', 'plugins'), { recursive: true, force: true });

    const out = linkAll({ rootDir: tmpDir, hermesDir, logger: () => {} });
    assert.equal(out.linkErrors.length, 2);
    assert.match(out.linkErrors[0], /Common skills directory not found/);
    assert.match(out.linkErrors[1], /Common plugins directory not found/);
  });

  it('linkAll captures a missing profiles source dir for the hermes link when includeHermesLink is set', () => {
    // Only common exists; the profiles source dir is removed so linkHermes
    // throws. includeHermesLink: true forces the hermes link step to run.
    const onlyCommon = path.join(tmpDir, 'profiles');
    fs.mkdirSync(path.join(onlyCommon, 'common', 'skills'), { recursive: true });
    fs.mkdirSync(path.join(onlyCommon, 'common', 'plugins'), { recursive: true });
    fs.writeFileSync(path.join(onlyCommon, 'common', 'config.yaml'), `model: "default"\n`);
    // Now delete the profiles dir entirely so linkHermes (and the profile
    // loops) see a missing source.
    fs.rmSync(onlyCommon, { recursive: true, force: true });

    const out = linkAll({ rootDir: tmpDir, hermesDir, includeHermesLink: true, logger: () => {} });
    // skills + plugins + hermes all failed on the missing source.
    assert.equal(out.linkErrors.length, 3);
    assert.ok(out.linkErrors.some((e) => /Profiles source directory not found/.test(e)));
    assert.equal(out.hermesLink, undefined);
  });

  it('syncAll returns the merge results AND captures link failures (does not throw)', () => {
    // Valid config custom for the profile so config merges; both link source
    // dirs are stripped so both link steps fail.
    scaffoldCommon(tmpDir);
    const mainDir = path.join(tmpDir, 'profiles', 'main');
    fs.mkdirSync(mainDir, { recursive: true });
    fs.writeFileSync(path.join(mainDir, 'config.custom.yaml'), `model: "custom"\n`);
    fs.rmSync(path.join(tmpDir, 'profiles', 'common', 'skills'), { recursive: true, force: true });
    fs.rmSync(path.join(tmpDir, 'profiles', 'common', 'plugins'), { recursive: true, force: true });

    // Regression target: syncAll used to throw from linkAll, losing the
    // already-computed merge results. It must now return with BOTH.
    const result: SyncAllResult = syncAll({ rootDir: tmpDir, hermesDir, logger: () => {} });
    // The merge result survived and is reportable.
    assert.equal(result.config.length, 1);
    assert.equal(result.config[0].status, 'merged');
    // The link failures were captured (not thrown).
    assert.equal(result.linkErrors.length, 2);
    assert.match(result.linkErrors[0], /Common skills directory not found/);
    assert.match(result.linkErrors[1], /Common plugins directory not found/);
    // And the config merge actually wrote its output.
    assert.ok(fs.existsSync(path.join(mainDir, 'config.yaml')));
  });

  it('linkAll returns an empty linkErrors array when all link sources are present', () => {
    scaffoldCommon(tmpDir);
    const mainDir = path.join(tmpDir, 'profiles', 'main');
    fs.mkdirSync(mainDir, { recursive: true });

    const out = linkAll({ rootDir: tmpDir, hermesDir, logger: () => {} });
    assert.deepEqual(out.linkErrors, []);
  });
});

describe('standalone merge sub-commands still surface "no custom found"', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-test-standalone-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('standalone mergeJobs throws when no profile has cron/jobs.custom.json', () => {
    // A profile dir exists, but no cron custom source anywhere.
    fs.mkdirSync(path.join(tmpDir, 'profiles', 'worker'), { recursive: true });
    assert.throws(
      () => mergeJobs({ rootDir: tmpDir, logger: () => {} }),
      /no profiles with cron\/jobs\.custom\.json found/
    );
  });

  it('standalone mergeSoul throws when no profile has SOUL.custom.md', () => {
    const commonDir = path.join(tmpDir, 'profiles', 'common');
    fs.mkdirSync(commonDir, { recursive: true });
    fs.writeFileSync(path.join(commonDir, 'SOUL.md'), '# Common\n');
    fs.mkdirSync(path.join(tmpDir, 'profiles', 'worker'), { recursive: true });
    assert.throws(
      () => mergeSoul({ rootDir: tmpDir, logger: () => {} }),
      /no profiles with SOUL\.custom\.md found/
    );
  });

  it('standalone mergeConfig throws when no profile has valid config.custom.yaml', () => {
    const commonDir = path.join(tmpDir, 'profiles', 'common');
    fs.mkdirSync(commonDir, { recursive: true });
    fs.writeFileSync(path.join(commonDir, 'config.yaml'), `model: "base"\n`);
    // Profile exists but has no config.custom.yaml.
    fs.mkdirSync(path.join(tmpDir, 'profiles', 'worker'), { recursive: true });
    assert.throws(
      () => mergeConfig({ rootDir: tmpDir, logger: () => {} }),
      /No profiles with valid config\.custom\.yaml could be merged/
    );
  });

  it('explicit --profiles still surfaces the no-merge situation for standalone config', () => {
    const commonDir = path.join(tmpDir, 'profiles', 'common');
    fs.mkdirSync(commonDir, { recursive: true });
    fs.writeFileSync(path.join(commonDir, 'config.yaml'), `model: "base"\n`);
    fs.mkdirSync(path.join(tmpDir, 'profiles', 'worker'), { recursive: true });
    // When explicit profiles are given, the "nothing merged" throw is NOT
    // triggered (existing behavior) — a skipped entry is returned instead.
    const res = mergeConfig({ rootDir: tmpDir, profiles: ['worker'], logger: () => {} });
    assert.equal(res.length, 1);
    assert.equal(res[0].status, 'skipped');
  });
});
