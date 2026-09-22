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

  it('recovers cleanly when base jobs.json is missing or corrupted', () => {
    const cronDir = path.join(tmpDir, 'profiles', 'worker', 'cron');
    fs.mkdirSync(cronDir, { recursive: true });

    fs.writeFileSync(path.join(cronDir, 'jobs.custom.json'), JSON.stringify({
      jobs: [{ id: '99', name: 'standalone' }]
    }));

    const results = mergeJobs({ rootDir: tmpDir, logger: () => {} });
    assert.equal(results.length, 1);
    assert.equal(results[0].status, 'merged');

    const output = JSON.parse(fs.readFileSync(path.join(cronDir, 'jobs.json'), 'utf8'));
    assert.equal(output.jobs.length, 1);
    assert.equal(output.jobs[0].id, '99');
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
});
