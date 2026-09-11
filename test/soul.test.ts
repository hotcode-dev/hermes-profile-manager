import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { mergeSoul } from '../src/core/soul.js';

describe('mergeSoul', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-test-soul-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('concatenates custom SOUL first and common SOUL second', () => {
    const commonDir = path.join(tmpDir, 'profiles', 'common');
    fs.mkdirSync(commonDir, { recursive: true });
    fs.writeFileSync(path.join(commonDir, 'SOUL.md'), '# Common Base Instructions');

    const workerDir = path.join(tmpDir, 'profiles', 'worker');
    fs.mkdirSync(workerDir, { recursive: true });
    fs.writeFileSync(path.join(workerDir, 'SOUL.custom.md'), '# Worker Personality');

    const results = mergeSoul({ rootDir: tmpDir, logger: () => {} });
    assert.equal(results.length, 1);
    assert.equal(results[0].status, 'merged');

    const output = fs.readFileSync(path.join(workerDir, 'SOUL.md'), 'utf8');
    assert.ok(output.startsWith('# Worker Personality'));
    assert.ok(output.includes('# Common Base Instructions'));
  });
});
