import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parse as parseYaml } from 'yaml';
import { mergeConfig } from '../src/core/config.js';

describe('mergeConfig', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-test-config-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('merges common config and profile custom config', () => {
    // Setup profiles/common/config.yaml
    const commonDir = path.join(tmpDir, 'profiles', 'common');
    fs.mkdirSync(commonDir, { recursive: true });
    fs.writeFileSync(path.join(commonDir, 'config.yaml'), `
name: common
models:
  - name: default
    provider: openai
    model: gpt-4
timeout: 30
`);

    // Setup profiles/worker/config.custom.yaml
    const workerDir = path.join(tmpDir, 'profiles', 'worker');
    fs.mkdirSync(workerDir, { recursive: true });
    fs.writeFileSync(path.join(workerDir, 'config.custom.yaml'), `
name: worker
tools:
  - terminal
  - web
timeout: 60
`);

    const results = mergeConfig({ rootDir: tmpDir, logger: () => {} });
    assert.equal(results.length, 1);
    assert.equal(results[0].profile, 'worker');
    assert.equal(results[0].status, 'merged');

    const outputContent = fs.readFileSync(path.join(workerDir, 'config.yaml'), 'utf8');
    const parsed = parseYaml(outputContent);

    assert.equal(parsed.name, 'worker');
    assert.equal(parsed.timeout, 60);
    assert.deepEqual(parsed.tools, ['terminal', 'web']);
    assert.equal(parsed.models[0].model, 'gpt-4');
  });

  it('dry run writes no file and reports a preview, not a completed write', () => {
    const commonDir = path.join(tmpDir, 'profiles', 'common');
    fs.mkdirSync(commonDir, { recursive: true });
    fs.writeFileSync(path.join(commonDir, 'config.yaml'), `name: common\n`);

    const workerDir = path.join(tmpDir, 'profiles', 'worker');
    fs.mkdirSync(workerDir, { recursive: true });
    fs.writeFileSync(path.join(workerDir, 'config.custom.yaml'), `name: worker\n`);

    const lines: string[] = [];
    const results = mergeConfig({ rootDir: tmpDir, dryRun: true, logger: (m) => lines.push(m) });
    assert.equal(results.length, 1);
    assert.equal(results[0].status, 'merged');

    // No output file was written.
    assert.ok(!fs.existsSync(path.join(workerDir, 'config.yaml')), 'dry-run must not write config.yaml');
    // The log line must not claim the file was written.
    assert.ok(!lines.some((l) => l.includes('written to')), `no "written to" claim in:\n${lines.join('\n')}`);
    // And it phrases the write as a preview.
    assert.ok(lines.some((l) => l.includes('Would merge config to:')), `preview wording missing in:\n${lines.join('\n')}`);
  });

  it('throws when common config is missing', () => {
    assert.throws(() => {
      mergeConfig({ rootDir: tmpDir, logger: () => {} });
    }, /Common config not found/);
  });

  it('returns [] without throwing when allowEmpty is true and profiles dir has no profile subdirs', () => {
    const commonDir = path.join(tmpDir, 'profiles', 'common');
    fs.mkdirSync(commonDir, { recursive: true });
    fs.writeFileSync(path.join(commonDir, 'config.yaml'), `model: "base"\n`);
    // No profile subdirs besides common.
    const results = mergeConfig({ rootDir: tmpDir, allowEmpty: true, logger: () => {} });
    assert.deepEqual(results, []);
  });

  it('still throws "No profiles found" when allowEmpty is falsy and there are no profile subdirs', () => {
    const commonDir = path.join(tmpDir, 'profiles', 'common');
    fs.mkdirSync(commonDir, { recursive: true });
    fs.writeFileSync(path.join(commonDir, 'config.yaml'), `model: "base"\n`);
    assert.throws(
      () => mergeConfig({ rootDir: tmpDir, logger: () => {} }),
      /No profiles found under/
    );
  });
});
