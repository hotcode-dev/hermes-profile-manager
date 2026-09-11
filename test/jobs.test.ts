import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { mergeJobs } from '../src/core/jobs.js';

describe('mergeJobs', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-test-jobs-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
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
});
