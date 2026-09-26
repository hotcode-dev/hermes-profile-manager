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

    // Jobs and soul are benign no-ops: the profile is reported as
    // `skipped` (its custom source is absent) instead of silently
    // missing, and nothing is written or thrown.
    assert.equal(result.jobs.length, 1);
    assert.equal(result.jobs[0].status, 'skipped');
    assert.equal(result.soul.length, 1);
    assert.equal(result.soul[0].status, 'skipped');
    assert.ok(!fs.existsSync(path.join(mainDir, 'cron', 'jobs.json')));
    assert.ok(!fs.existsSync(path.join(mainDir, 'SOUL.md')));
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
    // entry (not a throw), soul now does the same — a visible no-op instead
    // of a silent omission. No config/soul outputs written.
    assert.equal(result.soul.length, 1);
    assert.equal(result.soul[0].status, 'skipped');
    assert.equal(result.config.length, 1);
    assert.equal(result.config[0].status, 'skipped');
    assert.ok(!fs.existsSync(path.join(mainDir, 'config.yaml')));
    assert.ok(!fs.existsSync(path.join(mainDir, 'SOUL.md')));
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
    // The profile lacks cron/SOUL custom sources: both concerns now report
    // a visible `skipped` entry instead of silently omitting the profile.
    assert.equal(out.jobs.length, 1);
    assert.equal(out.jobs[0].status, 'skipped');
    assert.equal(out.soul.length, 1);
    assert.equal(out.soul[0].status, 'skipped');
    // No step failed: stepErrors is empty.
    assert.deepEqual(out.stepErrors, {});
  });

  it('mergeAll captures a top-level config failure in stepErrors WITHOUT aborting the jobs/soul steps', () => {
    // Invalid common config (a YAML list) + a broken worker cron custom
    // source (invalid JSON). Regression target: before the step-isolation
    // fix the mergeConfig throw aborted mergeAll, so the jobs/soul arrays
    // were empty and the broken worker jobs file stayed invisible.
    scaffoldCommon(tmpDir);
    fs.writeFileSync(
      path.join(tmpDir, 'profiles', 'common', 'config.yaml'),
      `- just\n- a\n- list\n`
    );
    const workerCron = path.join(tmpDir, 'profiles', 'worker', 'cron');
    fs.mkdirSync(workerCron, { recursive: true });
    fs.writeFileSync(path.join(workerCron, 'jobs.custom.json'), '{ not valid json');

    const out = mergeAll({ rootDir: tmpDir, logger: () => {} });
    // The config step failure is captured (not thrown)...
    assert.match(out.stepErrors.config ?? '', /Common config must be a YAML object/);
    // ...and the other steps still ran: the broken worker jobs file shows
    // up as a per-profile error entry instead of an empty array.
    assert.equal(out.jobs.length, 1);
    assert.equal(out.jobs[0].profile, 'worker');
    assert.equal(out.jobs[0].status, 'error');
    assert.match(out.jobs[0].error ?? '', /not valid JSON/);
    assert.equal(out.soul.length, 1);
    assert.equal(out.soul[0].status, 'skipped');
    assert.equal(out.stepErrors.jobs, undefined);
    assert.equal(out.stepErrors.soul, undefined);
    assert.equal(out.config.length, 0);
  });

  it('syncAll reports a top-level config error AND still records jobs/soul per-profile failures', () => {
    // Same broken workspace as above, through syncAll: the top-level step
    // error must be present AND the per-profile jobs/soul failures must
    // still be executed and recorded (today, before the fix, the jobs/soul
    // arrays are empty).
    scaffoldCommon(tmpDir);
    fs.writeFileSync(
      path.join(tmpDir, 'profiles', 'common', 'config.yaml'),
      `- just\n- a\n- list\n`
    );
    const workerCron = path.join(tmpDir, 'profiles', 'worker', 'cron');
    fs.mkdirSync(workerCron, { recursive: true });
    fs.writeFileSync(path.join(workerCron, 'jobs.custom.json'), '{ not valid json');

    const result: SyncAllResult = syncAll({ rootDir: tmpDir, hermesDir, logger: () => {} });
    assert.match(result.stepErrors.config ?? '', /Common config must be a YAML object/);
    const workerJobs = result.jobs.find((r) => r.profile === 'worker');
    assert.equal(workerJobs?.status, 'error');
    assert.match(workerJobs?.error ?? '', /not valid JSON/);
    const workerSoul = result.soul.find((r) => r.profile === 'worker');
    assert.equal(workerSoul?.status, 'skipped');
    // Backward-compat: the deprecated single-field carrier still surfaces
    // the step failure for the public SyncAllResult API.
    assert.match(result.syncError ?? '', /Common config must be a YAML object/);
  });

  it('syncAll captures BOTH top-level step errors when common config.yaml and SOUL.md are both missing', () => {
    // Only the skills/plugins source dirs exist: the common config.yaml and
    // SOUL.md sources are absent, so BOTH the config and the soul step hit
    // their pre-profile preconditions. Regression target: before the fix
    // only whichever step threw first was visible in syncError; now every
    // failing step gets its own slot and the jobs step still runs.
    const commonDir = path.join(tmpDir, 'profiles', 'common');
    fs.mkdirSync(path.join(commonDir, 'skills'), { recursive: true });
    fs.mkdirSync(path.join(commonDir, 'plugins'), { recursive: true });
    const workerDir = path.join(tmpDir, 'profiles', 'worker');
    fs.mkdirSync(workerDir, { recursive: true });

    const result: SyncAllResult = syncAll({ rootDir: tmpDir, hermesDir, logger: () => {} });
    assert.match(result.stepErrors.config ?? '', /Common config not found/);
    assert.match(result.stepErrors.soul ?? '', /Common SOUL file not found/);
    // The jobs step (no top-level precondition, no custom sources anywhere)
    // still ran and recorded its per-profile no-op instead of being
    // aborted behind the first failure.
    assert.equal(result.jobs.length, 1);
    assert.equal(result.jobs[0].profile, 'worker');
    assert.equal(result.jobs[0].status, 'skipped');
    assert.equal(result.stepErrors.jobs, undefined);
    // Backward-compat carrier: both messages, in step order.
    assert.match(result.syncError ?? '', /Common config not found/);
    assert.match(result.syncError ?? '', /Common SOUL file not found/);
  });

  it('a broken config step does not prevent the jobs step from recording successful per-profile merges', () => {
    // Broken common config, but a VALID worker cron custom source. The jobs
    // step must still merge and write its output even though the config
    // step failed top-level.
    scaffoldCommon(tmpDir);
    fs.writeFileSync(
      path.join(tmpDir, 'profiles', 'common', 'config.yaml'),
      `- just\n- a\n- list\n`
    );
    const workerCron = path.join(tmpDir, 'profiles', 'worker', 'cron');
    fs.mkdirSync(workerCron, { recursive: true });
    fs.writeFileSync(
      path.join(workerCron, 'jobs.custom.json'),
      JSON.stringify({ jobs: [{ id: '1', name: 'ok_job' }] }) + '\n'
    );

    const result: SyncAllResult = syncAll({ rootDir: tmpDir, hermesDir, logger: () => {} });
    assert.match(result.stepErrors.config ?? '', /Common config must be a YAML object/);
    const workerJobs = result.jobs.find((r) => r.profile === 'worker');
    assert.equal(workerJobs?.status, 'merged');
    // The jobs output was actually written.
    const jobsOutput = path.join(workerCron, 'jobs.json');
    assert.ok(fs.existsSync(jobsOutput));
    assert.equal(JSON.parse(fs.readFileSync(jobsOutput, 'utf8')).jobs.length, 1);
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

  it('standalone mergeJobs exits cleanly (no throw) for an explicit -p target without a cron source', () => {
    // Regression target: `mergeJobs({ profiles: ['nonexistent'] })` used to
    // throw the top-level "no profiles with cron/jobs.custom.json found"
    // error even though the user explicitly named a profile. It must behave
    // exactly like the mergeConfig case above: a per-profile `skipped`
    // entry and a clean return, so the CLI can exit 0.
    fs.mkdirSync(path.join(tmpDir, 'profiles', 'worker'), { recursive: true });
    const res = mergeJobs({ rootDir: tmpDir, profiles: ['nonexistent'], logger: () => {} });
    assert.equal(res.length, 1);
    assert.equal(res[0].profile, 'nonexistent');
    assert.equal(res[0].status, 'skipped');
    assert.match(res[0].error ?? '', /cron\/jobs\.custom\.json not found/);
    // Nothing was written for the targeted profile.
    assert.ok(!fs.existsSync(path.join(tmpDir, 'profiles', 'nonexistent', 'cron', 'jobs.json')));
  });

  it('standalone mergeSoul exits cleanly (no throw) for an explicit -p target without a SOUL source', () => {
    const commonDir = path.join(tmpDir, 'profiles', 'common');
    fs.mkdirSync(commonDir, { recursive: true });
    fs.writeFileSync(path.join(commonDir, 'SOUL.md'), '# Common\n');
    fs.mkdirSync(path.join(tmpDir, 'profiles', 'worker'), { recursive: true });

    // Same regression as mergeJobs above, mirrored for the SOUL concern.
    const res = mergeSoul({ rootDir: tmpDir, profiles: ['nonexistent'], logger: () => {} });
    assert.equal(res.length, 1);
    assert.equal(res[0].profile, 'nonexistent');
    assert.equal(res[0].status, 'skipped');
    assert.match(res[0].error ?? '', /SOUL\.custom\.md not found/);
    assert.ok(!fs.existsSync(path.join(tmpDir, 'profiles', 'nonexistent', 'SOUL.md')));
  });

  it('standalone mergeJobs with NO profiles and an empty workspace still throws the loud error', () => {
    // Regression guard: the fix must NOT weaken the no-target case. With no
    // -p flag on a workspace without any profile dirs, the standalone
    // command still fails loudly. The loud error is the shared
    // "No profiles found under" no-targets guard — the SAME error
    // mergeConfig throws, so all three sub-commands agree (this used to be
    // the concern-specific "no profiles with cron/jobs.custom.json found",
    // which diverged from mergeConfig).
    let errMsg = '';
    let threw = false;
    try {
      mergeJobs({ rootDir: tmpDir, logger: () => {} });
    } catch (err) {
      threw = true;
      errMsg = err instanceof Error ? err.message : String(err);
    }
    assert.equal(threw, true, 'expected the no-target standalone mergeJobs to throw');
    assert.match(errMsg, /No profiles found under/);
  });

  it('standalone mergeSoul with NO profiles and an empty workspace still throws the loud error', () => {
    // Same guard for soul: mergeSoul requires the common SOUL.md to even
    // start, so provide it — the throw under test is the shared no-targets
    // "No profiles found under" guard, not the common-source precondition.
    const commonDir = path.join(tmpDir, 'profiles', 'common');
    fs.mkdirSync(commonDir, { recursive: true });
    fs.writeFileSync(path.join(commonDir, 'SOUL.md'), '# Common\n');

    let errMsg = '';
    let threw = false;
    try {
      mergeSoul({ rootDir: tmpDir, logger: () => {} });
    } catch (err) {
      threw = true;
      errMsg = err instanceof Error ? err.message : String(err);
    }
    assert.equal(threw, true, 'expected the no-target standalone mergeSoul to throw');
    assert.match(errMsg, /No profiles found under/);
  });

  it('explicit empty profiles: [] on an empty workspace throws the same no-profiles error in all three sub-commands', () => {
    // Alignment regression: mergeConfig already threw `No profiles found
    // under` for an empty target list, while mergeJobs/mergeSoul silently
    // returned `[]` for the exact same call (a divergence baked in by the
    // explicit-`profiles` exemption). An empty list names no profile, so all
    // three must now fail identically with the shared no-targets error.
    // Common sources are provided so the throw under test is the no-targets
    // guard, not the common-source preconditions.
    const commonDir = path.join(tmpDir, 'profiles', 'common');
    fs.mkdirSync(commonDir, { recursive: true });
    fs.writeFileSync(path.join(commonDir, 'config.yaml'), `model: "base"\n`);
    fs.writeFileSync(path.join(commonDir, 'SOUL.md'), '# Common\n');
    // No profile subdirs besides common: the empty explicit list resolves
    // to an empty target list, exactly like `profiles: undefined`.

    assert.throws(
      () => mergeConfig({ rootDir: tmpDir, profiles: [], logger: () => {} }),
      /No profiles found under/
    );
    assert.throws(
      () => mergeJobs({ rootDir: tmpDir, profiles: [], logger: () => {} }),
      /No profiles found under/
    );
    assert.throws(
      () => mergeSoul({ rootDir: tmpDir, profiles: [], logger: () => {} }),
      /No profiles found under/
    );
  });

  it('explicit empty profiles: [] with allowEmpty: true on an empty workspace returns [] in all three sub-commands', () => {
    // Same contract as above with the aggregate-path escape hatch: an empty
    // target list is a clean no-op (`[]`) instead of the top-level throw,
    // identically for config/jobs/soul.
    const commonDir = path.join(tmpDir, 'profiles', 'common');
    fs.mkdirSync(commonDir, { recursive: true });
    fs.writeFileSync(path.join(commonDir, 'config.yaml'), `model: "base"\n`);
    fs.writeFileSync(path.join(commonDir, 'SOUL.md'), '# Common\n');

    assert.deepEqual(
      mergeConfig({ rootDir: tmpDir, profiles: [], allowEmpty: true, logger: () => {} }),
      []
    );
    assert.deepEqual(
      mergeJobs({ rootDir: tmpDir, profiles: [], allowEmpty: true, logger: () => {} }),
      []
    );
    assert.deepEqual(
      mergeSoul({ rootDir: tmpDir, profiles: [], allowEmpty: true, logger: () => {} }),
      []
    );
  });

  it('explicit empty profiles: [] falls back to auto-discovery on a workspace WITH profiles (per-profile skipped no-op, all three agree)', () => {
    // An empty explicit array names no profile, so all three sub-commands
    // fall back to the auto-discovered profiles — identical to omitting
    // `profiles` — and the run is a per-profile `skipped` no-op instead of
    // a top-level throw (the worker profile has no custom source).
    fs.mkdirSync(path.join(tmpDir, 'profiles', 'worker'), { recursive: true });
    const commonDir = path.join(tmpDir, 'profiles', 'common');
    fs.mkdirSync(commonDir, { recursive: true });
    fs.writeFileSync(path.join(commonDir, 'config.yaml'), `model: "base"\n`);
    fs.writeFileSync(path.join(commonDir, 'SOUL.md'), '# Common\n');

    assert.deepEqual(
      mergeConfig({ rootDir: tmpDir, profiles: [], logger: () => {} })
        .map((r) => ({ profile: r.profile, status: r.status })),
      [{ profile: 'worker', status: 'skipped' }]
    );
    assert.deepEqual(
      mergeJobs({ rootDir: tmpDir, profiles: [], logger: () => {} })
        .map((r) => ({ profile: r.profile, status: r.status })),
      [{ profile: 'worker', status: 'skipped' }]
    );
    assert.deepEqual(
      mergeSoul({ rootDir: tmpDir, profiles: [], logger: () => {} })
        .map((r) => ({ profile: r.profile, status: r.status })),
      [{ profile: 'worker', status: 'skipped' }]
    );
  });
});
