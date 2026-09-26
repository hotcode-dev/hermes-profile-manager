import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { mergeJobs, mergeJobsDocuments } from '../src/core/jobs.js';

describe('mergeJobs', () => {
  let tmpDir: string;
  // Shared escape target the path-traversal regression tests assert on:
  // path.dirname(tmpDir) is the OS temp dir, so <tmpdir>/pwned is SHARED
  // across runs. A stale artifact there would make the "wrote nothing
  // outside the workspace" assertion fail forever.
  const pwnedDir = () => path.join(path.dirname(tmpDir), 'pwned');

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-test-jobs-'));
    // Hermetic precondition: no stale escape artifact from an earlier run.
    fs.rmSync(pwnedDir(), { recursive: true, force: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    // Clean the shared escape target (see pwnedDir above).
    fs.rmSync(pwnedDir(), { recursive: true, force: true });
  });

  it('merges custom jobs with matching ids and appends new jobs', () => {
    const cronDir = path.join(tmpDir, 'profiles', 'worker', 'cron');
    fs.mkdirSync(cronDir, { recursive: true });

    fs.writeFileSync(path.join(cronDir, 'jobs.json'), JSON.stringify({
      jobs: [
        { id: '1', name: 'default_job', schedule: '0 */4 * * *' },
        { id: '3', name: 'base_only_job', schedule: '0 0 * * *' }
      ]
    }));

    fs.writeFileSync(path.join(cronDir, 'jobs.custom.json'), JSON.stringify({
      jobs: [
        { id: '2', name: 'custom_job', schedule: '0 */2 * * *' },
        { id: '1', name: 'overridden_job', schedule: '0 */3 * * *' }
      ]
    }));

    const results = mergeJobs({ rootDir: tmpDir, logger: () => {} });
    assert.equal(results.length, 1);
    assert.equal(results[0].status, 'merged');

    const output = JSON.parse(fs.readFileSync(path.join(cronDir, 'jobs.json'), 'utf8'));
    assert.equal(output.jobs.length, 3);

    const job1 = output.jobs.find((j: any) => j.id === '1');
    const job2 = output.jobs.find((j: any) => j.id === '2');
    const job3 = output.jobs.find((j: any) => j.id === '3');

    assert.equal(job1.name, 'overridden_job');
    assert.equal(job1.schedule, '0 */3 * * *');
    assert.equal(job2.name, 'custom_job');
    assert.equal(job3.name, 'base_only_job');
  });

  it('dry run writes no file and reports a preview, not a completed write', () => {
    const cronDir = path.join(tmpDir, 'profiles', 'worker', 'cron');
    fs.mkdirSync(cronDir, { recursive: true });
    fs.writeFileSync(path.join(cronDir, 'jobs.custom.json'), JSON.stringify({ jobs: [{ id: '1' }] }) + '\n');

    const lines: string[] = [];
    const results = mergeJobs({ rootDir: tmpDir, dryRun: true, logger: (m) => lines.push(m) });
    assert.equal(results.length, 1);
    assert.equal(results[0].status, 'merged');

    // No output file was written.
    assert.ok(!fs.existsSync(path.join(cronDir, 'jobs.json')), 'dry-run must not write jobs.json');
    // The log line must not claim the file was written.
    assert.ok(!lines.some((l) => l.includes('written to')), `no "written to" claim in:\n${lines.join('\n')}`);
    // And it phrases the write as a preview.
    assert.ok(lines.some((l) => l.includes('Would merge jobs to:')), `preview wording missing in:\n${lines.join('\n')}`);
  });

  it('recovers cleanly when base jobs.json is missing', () => {
    const cronDir = path.join(tmpDir, 'profiles', 'worker', 'cron');
    fs.mkdirSync(cronDir, { recursive: true });

    fs.writeFileSync(path.join(cronDir, 'jobs.custom.json'), JSON.stringify({
      jobs: [{ id: '99', name: 'standalone' }]
    }));

    const lines: string[] = [];
    const results = mergeJobs({ rootDir: tmpDir, logger: (m) => lines.push(m) });
    assert.equal(results.length, 1);
    assert.equal(results[0].status, 'merged');

    const output = JSON.parse(fs.readFileSync(path.join(cronDir, 'jobs.json'), 'utf8'));
    assert.equal(output.jobs.length, 1);
    assert.equal(output.jobs[0].id, '99');
    // A genuinely ABSENT base is a normal first run, not data loss — no
    // corruption warning may fire.
    assert.ok(!lines.some((l) => l.includes('Warning:')), `no warning expected for a missing base:\n${lines.join('\n')}`);
  });

  it('logs a visible warning when base jobs.json is corrupt (reset to empty base)', () => {
    // The corrupt-base path: the base IS the accumulated merge output, so
    // resetting it to { jobs: [] } drops every previously merged base job.
    // The fallback itself is the correct recovery behavior — the defect is
    // that it was invisible. The warning must name the corrupt file and the
    // data loss, while the merge itself succeeds (status 'merged') and the
    // output holds custom jobs only, documenting the reset behavior.
    const cronDir = path.join(tmpDir, 'profiles', 'worker', 'cron');
    fs.mkdirSync(cronDir, { recursive: true });

    fs.writeFileSync(path.join(cronDir, 'jobs.json'), '{corrupt: ');
    fs.writeFileSync(path.join(cronDir, 'jobs.custom.json'), JSON.stringify({
      jobs: [{ name: 'custom-only-job', schedule: '0 0 * * *' }]
    }));

    const lines: string[] = [];
    const results = mergeJobs({ rootDir: tmpDir, logger: (m) => lines.push(m) });
    assert.equal(results.length, 1);
    assert.equal(results[0].status, 'merged');

    const warning = lines.find((l) => l.includes('Warning:'));
    assert.ok(warning, `expected a corruption warning in log, got:\n${lines.join('\n')}`);
    assert.ok(
      warning!.includes(path.join(cronDir, 'jobs.json')),
      `warning must name the corrupt file:\n${warning}`
    );
    assert.match(warning!, /not valid JSON/);
    assert.match(warning!, /previously merged jobs will be lost/);

    // Output was reset to custom jobs only (the documented reset behavior).
    const output = JSON.parse(fs.readFileSync(path.join(cronDir, 'jobs.json'), 'utf8'));
    assert.equal(output.jobs.length, 1);
    assert.equal(output.jobs[0].name, 'custom-only-job');
  });

  it('logs a visible warning when base jobs.json parses but is not a jobs document', () => {
    // Second silent class: valid JSON with the wrong shape (42, "foo",
    // {noJobs: true}) — normalizeJobsDoc resets the jobs list to [] just as
    // silently as the parse-failure path. Same visibility is required.
    const cronDir = path.join(tmpDir, 'profiles', 'worker', 'cron');
    fs.mkdirSync(cronDir, { recursive: true });

    fs.writeFileSync(path.join(cronDir, 'jobs.json'), '42\n');
    fs.writeFileSync(path.join(cronDir, 'jobs.custom.json'), JSON.stringify({
      jobs: [{ name: 'custom-after-wrong-shape' }]
    }));

    const lines: string[] = [];
    const results = mergeJobs({ rootDir: tmpDir, logger: (m) => lines.push(m) });
    assert.equal(results.length, 1);
    assert.equal(results[0].status, 'merged');

    const warning = lines.find((l) => l.includes('Warning:'));
    assert.ok(warning, `expected a wrong-shape warning in log, got:\n${lines.join('\n')}`);
    assert.ok(
      warning!.includes(path.join(cronDir, 'jobs.json')),
      `warning must name the base file:\n${warning}`
    );
    assert.match(warning!, /not a jobs document/);
    assert.match(warning!, /previously merged jobs will be lost/);

    const output = JSON.parse(fs.readFileSync(path.join(cronDir, 'jobs.json'), 'utf8'));
    assert.equal(output.jobs.length, 1);
    assert.equal(output.jobs[0].name, 'custom-after-wrong-shape');
  });

  it('stays silent about the base when it is a valid jobs document', () => {
    // Guard against over-warning: a well-formed base (object with a jobs
    // array, or a top-level array) must not trigger any warning.
    for (const base of [
      JSON.stringify({ jobs: [{ id: '1', name: 'base_job' }] }),
      JSON.stringify([{ id: '1', name: 'base_job' }])
    ]) {
      const cronDir = path.join(tmpDir, 'profiles', 'worker', 'cron');
      fs.rmSync(cronDir, { recursive: true, force: true });
      fs.mkdirSync(cronDir, { recursive: true });
      fs.writeFileSync(path.join(cronDir, 'jobs.json'), base);
      fs.writeFileSync(path.join(cronDir, 'jobs.custom.json'), JSON.stringify({
        jobs: [{ name: 'custom' }]
      }));

      const lines: string[] = [];
      const results = mergeJobs({ rootDir: tmpDir, logger: (m) => lines.push(m) });
      assert.equal(results[0].status, 'merged');
      assert.ok(!lines.some((l) => l.includes('Warning:')), `no warning for valid base:\n${lines.join('\n')}`);
    }
  });

  it('rejects a path-traversal profile name BEFORE any filesystem side effect', () => {
    // SECURITY REGRESSION (path traversal via user-controlled -p/--profiles):
    // path.join(profilesDir, '../../pwned', 'cron', 'jobs.json') resolves
    // OUTSIDE the workspace (to <tmpdir>/pwned/cron/jobs.json). The name
    // must be rejected before any read/write, so no escaped file is created.
    const escapeDir = pwnedDir();
    assert.ok(!fs.existsSync(escapeDir), 'precondition: shared escape target must not exist yet');
    // Pre-seed the attacker-controlled source so a pre-fix run would have
    // READ this and merged it into the escaped jobs.json.
    const escapeCron = path.join(escapeDir, 'cron');
    fs.mkdirSync(escapeCron, { recursive: true });
    fs.writeFileSync(path.join(escapeCron, 'jobs.custom.json'), JSON.stringify({ jobs: [{ id: 'pwn' }] }) + '\n');

    assert.throws(
      () => mergeJobs({ rootDir: tmpDir, profiles: ['../../pwned'], logger: () => {} }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /Invalid profile name: "\.\.\/\.\.\/pwned"/);
        return true;
      }
    );
    // No escaped output was written...
    assert.ok(
      !fs.existsSync(path.join(escapeCron, 'jobs.json')),
      `no file may be written outside the workspace (found: ${escapeCron}/jobs.json)`
    );
    // ...and the workspace was not modified either.
    assert.ok(!fs.existsSync(path.join(tmpDir, 'profiles')), 'workspace must not have been modified');
  });

  it('rejects other traversal-shaped profile names (.., ./x, a/b) with the same clean error', () => {
    for (const name of ['..', './x', 'a/b']) {
      assert.throws(
        () => mergeJobs({ rootDir: tmpDir, profiles: [name], logger: () => {} }),
        /Invalid profile name/,
        `expected "${name}" to be rejected`
      );
    }
    assert.ok(!fs.existsSync(pwnedDir()), 'nothing may have been written outside the workspace');
    assert.ok(!fs.existsSync(path.join(tmpDir, 'profiles')), 'workspace must not have been modified');
  });

  it('rejects the reserved profile name "common" BEFORE any read or write of the shared base', () => {
    // RESERVED-NAME REGRESSION (probe 2 of zf-hpm-e420a204): profiles/common/
    // is the SHARED base source. Without the reservation, `mergeJobs -p
    // common` would read common/cron/jobs.json, merge it with
    // common/cron/jobs.custom.json, and write the result BACK onto
    // common/cron/jobs.json — self-merging the shared base. The reserved name
    // must be rejected during the up-front validation loop.
    assert.throws(
      () => mergeJobs({ rootDir: tmpDir, profiles: ['common'], logger: () => {} }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /Invalid profile name: "common"/);
        assert.match(err.message, /reserved for the shared common profile directory/);
        return true;
      }
    );
    // No workspace was created or modified at all.
    assert.ok(!fs.existsSync(path.join(tmpDir, 'profiles')), 'workspace must not have been modified');
  });
});

describe('mergeJobsDocuments', () => {
  it('preserves custom jobs that have no id', () => {
    const base = { jobs: [{ id: '1', name: 'base_job' }] };
    const custom = {
      jobs: [
        { id: '2', name: 'with_id' },
        { name: 'no_id_job', schedule: '0 0 * * *' }
      ]
    };

    const merged = mergeJobsDocuments(base, custom);
    const jobs = merged.jobs ?? [];
    const ids = jobs.map((j) => j.id);
    const names = jobs.map((j) => j.name);

    assert.deepEqual(ids, ['1', '2', undefined]);
    assert.deepEqual(names, ['base_job', 'with_id', 'no_id_job']);
    const noIdJob = jobs.find((j) => j.name === 'no_id_job');
    assert.ok(noIdJob);
    assert.equal(noIdJob.schedule, '0 0 * * *');
  });

  it('preserves id-less jobs in a top-level array document', () => {
    // normalizeJobsDoc (not exported) wraps top-level arrays into { jobs: [...] };
    // exercise that path end-to-end through a real jobs.custom.json file.
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-test-jobs-array-'));
    const cronDir = path.join(tmpRoot, 'profiles', 'worker', 'cron');
    try {
      fs.mkdirSync(cronDir, { recursive: true });
      fs.writeFileSync(path.join(cronDir, 'jobs.json'), JSON.stringify({
        jobs: [{ id: '1', name: 'base_job' }]
      }));
      fs.writeFileSync(path.join(cronDir, 'jobs.custom.json'), JSON.stringify([
        { name: 'array_no_id', schedule: '0 1 * * *' },
        { id: '5', name: 'array_with_id' }
      ]));

      const results = mergeJobs({ rootDir: tmpRoot, logger: () => {} });
      assert.equal(results.length, 1);
      assert.equal(results[0].status, 'merged');

      const output = JSON.parse(fs.readFileSync(path.join(cronDir, 'jobs.json'), 'utf8'));
      const names = output.jobs.map((j: any) => j.name);
      assert.deepEqual(names, ['base_job', 'array_no_id', 'array_with_id']);
      const noId = output.jobs.find((j: any) => j.name === 'array_no_id');
      assert.equal(noId.schedule, '0 1 * * *');
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('still applies id-based override and append semantics', () => {
    const base = {
      jobs: [
        { id: '1', name: 'base_job', schedule: '0 */4 * * *' },
        { id: '3', name: 'base_only_job' }
      ]
    };
    const custom = {
      jobs: [
        { id: '2', name: 'custom_job' },
        { id: '1', name: 'overridden_job', schedule: '0 */3 * * *' }
      ]
    };

    const merged = mergeJobsDocuments(base, custom);
    const jobs = merged.jobs ?? [];
    assert.equal(jobs.length, 3);

    const job1 = jobs.find((j) => j.id === '1');
    assert.ok(job1);
    assert.equal(job1.name, 'overridden_job');
    assert.equal(job1.schedule, '0 */3 * * *');

    const job2 = jobs.find((j) => j.id === '2');
    assert.ok(job2);
    assert.equal(job2.name, 'custom_job');

    const job3 = jobs.find((j) => j.id === '3');
    assert.ok(job3);
    assert.equal(job3.name, 'base_only_job');
  });

  it('preserves id-less base jobs and appends id-less custom jobs alongside them', () => {
    const base = { jobs: [{ name: 'base_no_id' }, { id: '1', name: 'base_job' }] };
    const custom = { jobs: [{ name: 'custom_no_id' }] };

    const merged = mergeJobsDocuments(base, custom);
    const names = (merged.jobs ?? []).map((j) => j.name);

    assert.deepEqual(names, ['base_no_id', 'base_job', 'custom_no_id']);
  });

  it('does not duplicate id-less custom jobs when the base already contains them (idempotent f(f(b,c),c))', () => {
    // The exact reported drift: base = previous run's output already holds the
    // id-less custom job, so the custom doc's copy must NOT be re-appended.
    const custom = { jobs: [{ name: 'custom-job', schedule: '0 0 * * *' }] };
    const first = mergeJobsDocuments({ jobs: [{ name: 'base-job' }] }, custom);
    const second = mergeJobsDocuments(first, custom);
    const third = mergeJobsDocuments(second, custom);

    const names1 = (first.jobs ?? []).map((j) => j.name);
    const names2 = (second.jobs ?? []).map((j) => j.name);
    const names3 = (third.jobs ?? []).map((j) => j.name);

    assert.deepEqual(names1, ['base-job', 'custom-job']);
    // Stable across re-runs: no growth, identical arrays.
    assert.deepEqual(names2, names1);
    assert.deepEqual(names3, names1);
    assert.deepEqual(second, first);
    assert.deepEqual(third, first);
  });

  it('does not duplicate id-less custom jobs whose base copy differs only in key order', () => {
    // Content equality must be deep/canonical, not order-sensitive: the
    // previous merge output may have reordered keys relative to the source.
    const base = { jobs: [{ name: 'custom-job', schedule: '0 0 * * *' }] };
    const custom = { jobs: [{ schedule: '0 0 * * *', name: 'custom-job' }] };

    const merged = mergeJobsDocuments(base, custom);
    const names = (merged.jobs ?? []).map((j) => j.name);
    assert.deepEqual(names, ['custom-job']);
  });

  it('does not duplicate id-less custom jobs repeated within the custom doc itself', () => {
    const base = { jobs: [{ name: 'base-job' }] };
    const custom = { jobs: [{ name: 'custom-job' }, { name: 'custom-job' }] };

    const merged = mergeJobsDocuments(base, custom);
    const names = (merged.jobs ?? []).map((j) => j.name);
    assert.deepEqual(names, ['base-job', 'custom-job']);
  });

  it('still appends id-less custom jobs that are genuinely NEW content', () => {
    const base = { jobs: [{ name: 'custom-job' }] };
    const custom = { jobs: [{ name: 'custom-job' }, { name: 'another-job' }] };

    const merged = mergeJobsDocuments(base, custom);
    const names = (merged.jobs ?? []).map((j) => j.name);
    assert.deepEqual(names, ['custom-job', 'another-job']);
  });

  it('keeps id-matched jobs idempotent across repeated merges', () => {
    const base = { jobs: [{ id: '1', name: 'base_job', schedule: '0 */4 * * *' }] };
    const custom = { jobs: [{ id: '1', name: 'custom_job', schedule: '0 */2 * * *' }, { id: '2', name: 'new_job' }] };

    const first = mergeJobsDocuments(base, custom);
    const second = mergeJobsDocuments(first, custom);

    assert.deepEqual(second, first);
    const ids = (second.jobs ?? []).map((j) => j.id);
    assert.deepEqual(ids, ['1', '2']);
  });
});

describe('mergeJobs idempotency (re-run stability)', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-test-jobs-idempotent-'));
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('produces an identical jobs array on the 2nd and 3rd run (base = previous output)', () => {
    // Regression test for the reported bug: merge jobs re-merges the OUTPUT
    // file as base on every run. Id-less custom jobs used to be re-appended
    // on every run, so the jobs list grew by one copy per run.
    const cronDir = path.join(tmpRoot, 'profiles', 'worker', 'cron');
    fs.mkdirSync(cronDir, { recursive: true });

    fs.writeFileSync(path.join(cronDir, 'jobs.json'), JSON.stringify({
      jobs: [{ name: 'base-job', schedule: '0 0 * * *' }]
    }));
    fs.writeFileSync(path.join(cronDir, 'jobs.custom.json'), JSON.stringify({
      jobs: [
        { name: 'custom-job', schedule: '0 */2 * * *' },
        { id: '1', name: 'id-custom-job', schedule: '0 6 * * *' }
      ]
    }));

    const readJobs = () => JSON.parse(fs.readFileSync(path.join(cronDir, 'jobs.json'), 'utf8')).jobs;

    mergeJobs({ rootDir: tmpRoot, logger: () => {} });
    const run1 = readJobs();
    assert.deepEqual(run1.map((j: any) => j.name), ['base-job', 'custom-job', 'id-custom-job']);

    mergeJobs({ rootDir: tmpRoot, logger: () => {} });
    const run2 = readJobs();
    assert.deepEqual(run2, run1, 'run 2 must be byte-identical to run 1');

    mergeJobs({ rootDir: tmpRoot, logger: () => {} });
    const run3 = readJobs();
    assert.deepEqual(run3, run2, 'run 3 must be byte-identical to run 2');
  });

  it('stays stable when the base file is missing on run 1 (created by the merge itself)', () => {
    const cronDir = path.join(tmpRoot, 'profiles', 'worker', 'cron');
    fs.mkdirSync(cronDir, { recursive: true });

    fs.writeFileSync(path.join(cronDir, 'jobs.custom.json'), JSON.stringify({
      jobs: [{ name: 'only-custom', payload: { a: 1 } }]
    }));

    mergeJobs({ rootDir: tmpRoot, logger: () => {} });
    const run1 = JSON.parse(fs.readFileSync(path.join(cronDir, 'jobs.json'), 'utf8'));
    mergeJobs({ rootDir: tmpRoot, logger: () => {} });
    const run2 = JSON.parse(fs.readFileSync(path.join(cronDir, 'jobs.json'), 'utf8'));

    assert.deepEqual(run2, run1);
    assert.equal(run2.jobs.length, 1);
  });

  it('is byte-stable across a clean run after a corrupt-base recovery run', () => {
    // Ties the corrupt-base fallback into the f(f(b,c),c) contract: a run
    // that recovered from a corrupt base (warning + reset to empty base)
    // writes a well-formed output; the next run reads THAT as its base and
    // must be byte-stable — no growth, no extra warnings.
    const cronDir = path.join(tmpRoot, 'profiles', 'worker', 'cron');
    fs.mkdirSync(cronDir, { recursive: true });

    fs.writeFileSync(path.join(cronDir, 'jobs.json'), '{corrupt: ');
    fs.writeFileSync(path.join(cronDir, 'jobs.custom.json'), JSON.stringify({
      jobs: [{ name: 'recovered-job', schedule: '0 0 * * *' }]
    }));

    const lines: string[] = [];
    mergeJobs({ rootDir: tmpRoot, logger: (m) => lines.push(m) });
    assert.ok(lines.some((l) => l.includes('Warning:')), 'recovery run must log the corrupt-base warning');
    const afterRecovery = fs.readFileSync(path.join(cronDir, 'jobs.json'), 'utf8');

    lines.length = 0;
    mergeJobs({ rootDir: tmpRoot, logger: (m) => lines.push(m) });
    const afterSecond = fs.readFileSync(path.join(cronDir, 'jobs.json'), 'utf8');

    assert.equal(afterSecond, afterRecovery, '2nd run must be byte-identical to the recovery run');
    assert.ok(!lines.some((l) => l.includes('Warning:')), `no warning expected on the clean 2nd run:\n${lines.join('\n')}`);
  });
});
