import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { parse as parseYaml } from 'yaml';
import { mergeConfig } from '../src/core/config.js';
import { mergeJobs } from '../src/core/jobs.js';
import { mergeSoul } from '../src/core/soul.js';
import { collectMergeErrors, decideMergeExit, MergeStatusResult } from '../src/utils/merge-results.js';

const CLI_PATH = path.join(import.meta.dirname, '..', 'src', 'cli.ts');
// Absolute path to the tsx ESM loader: the CLI is spawned with a cwd inside
// the temporary workspace, where the bare 'tsx' specifier would not resolve.
const TSX_LOADER = createRequire(path.join(import.meta.dirname, '..', 'package.json')).resolve('tsx');

/**
 * Builds a minimal valid workspace:
 *   profiles/common/config.yaml
 *   profiles/common/SOUL.md
 *   profiles/common/skills/   (so linkSkills is a no-op)
 *   profiles/common/plugins/  (so linkPlugins is a no-op)
 */
function scaffoldWorkspace(rootDir: string): void {
  const commonDir = path.join(rootDir, 'profiles', 'common');
  fs.mkdirSync(path.join(commonDir, 'skills'), { recursive: true });
  fs.mkdirSync(path.join(commonDir, 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(commonDir, 'config.yaml'), `model: "default"\ntemperature: 0.5\n`);
  fs.writeFileSync(path.join(commonDir, 'SOUL.md'), '# Common Base\n');
}

function runCli(args: string[], opts: { cwd?: string; quiet?: boolean } = {}): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const cliArgs = opts.quiet ? ['-q', ...args] : args;
  const result = spawnSync(process.execPath, ['--import', TSX_LOADER, CLI_PATH, ...cliArgs], {
    cwd: opts.cwd ?? process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      // Keep the child away from the developer's real Hermes home.
      HERMES_HOME: opts.cwd ? path.join(opts.cwd, 'fake-hermes') : os.tmpdir()
    }
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? ''
  };
}

describe('merge-results helper (pure decision logic)', () => {
  it('collectMergeErrors returns only status === "error" entries, across multiple arrays', () => {
    const config: MergeStatusResult[] = [
      { profile: 'good', outputPath: '/x', status: 'merged' },
      { profile: 'bad', outputPath: '/y', status: 'error', error: 'Custom config is not a valid YAML object: /y' }
    ];
    const jobs: MergeStatusResult[] = [
      { profile: 'none', outputPath: '/z', status: 'skipped' },
      { profile: 'broken', outputPath: '/w', status: 'error', error: 'Jobs custom file is not valid JSON: /w' }
    ];
    const errors = collectMergeErrors(config, jobs, []);
    assert.equal(errors.length, 2);
    assert.deepEqual(
      errors.map((e) => e.profile).sort(),
      ['bad', 'broken']
    );
  });

  it('collectMergeErrors treats skipped entries as non-failures', () => {
    const skipped: MergeStatusResult[] = [
      { profile: 'a', outputPath: '/a', status: 'skipped' },
      { profile: 'b', outputPath: '/b', status: 'skipped', error: 'Profile custom config not found: /b' }
    ];
    assert.deepEqual(collectMergeErrors(skipped), []);
  });

  it('decideMergeExit: all-clean / merged-only → success, exit 0', () => {
    assert.deepEqual(
      decideMergeExit([
        { profile: 'a', outputPath: '/a', status: 'merged' }
      ]),
      { success: true, exitCode: 0 }
    );
  });

  it('decideMergeExit: skipped-only (intended no-op) → success, exit 0', () => {
    assert.deepEqual(
      decideMergeExit(
        [{ profile: 'a', outputPath: '/a', status: 'skipped' }],
        [],
        []
      ),
      { success: true, exitCode: 0 }
    );
  });

  it('decideMergeExit: any error entry → failure, exit 1', () => {
    assert.deepEqual(
      decideMergeExit(
        [{ profile: 'a', outputPath: '/a', status: 'merged' }],
        [{ profile: 'b', outputPath: '/b', status: 'skipped' }],
        [{ profile: 'c', outputPath: '/c', status: 'error', error: 'boom' }]
      ),
      { success: false, exitCode: 1 }
    );
  });
});

describe('core modules emit status:"error" entries without throwing', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-test-cli-core-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('mergeConfig records an error entry (not a throw) for an invalid config.custom.yaml', () => {
    scaffoldWorkspace(tmpDir);
    const goodDir = path.join(tmpDir, 'profiles', 'good');
    const badDir = path.join(tmpDir, 'profiles', 'bad');
    fs.mkdirSync(goodDir, { recursive: true });
    fs.mkdirSync(badDir, { recursive: true });
    fs.writeFileSync(path.join(goodDir, 'config.custom.yaml'), `model: "ok"\n`);
    // A bare scalar is a valid YAML document but not an object.
    fs.writeFileSync(path.join(badDir, 'config.custom.yaml'), `just-a-scalar\n`);

    const results = mergeConfig({ rootDir: tmpDir, logger: () => {} });
    const bad = results.find((r) => r.profile === 'bad');
    const good = results.find((r) => r.profile === 'good');
    assert.equal(bad?.status, 'error');
    assert.match(bad?.error ?? '', /not a valid YAML object/);
    assert.equal(good?.status, 'merged');
  });

  it('mergeJobs records an error entry (not a throw) for invalid jobs.custom.json', () => {
    fs.mkdirSync(path.join(tmpDir, 'profiles'), { recursive: true });
    const badDir = path.join(tmpDir, 'profiles', 'bad', 'cron');
    const goodDir = path.join(tmpDir, 'profiles', 'good', 'cron');
    fs.mkdirSync(badDir, { recursive: true });
    fs.mkdirSync(goodDir, { recursive: true });
    fs.writeFileSync(path.join(goodDir, 'jobs.custom.json'), JSON.stringify({ jobs: [{ id: '1' }] }) + '\n');
    fs.writeFileSync(path.join(badDir, 'jobs.custom.json'), '{ not valid json');

    const results = mergeJobs({ rootDir: tmpDir, logger: () => {} });
    const bad = results.find((r) => r.profile === 'bad');
    const good = results.find((r) => r.profile === 'good');
    assert.equal(bad?.status, 'error');
    assert.match(bad?.error ?? '', /not valid JSON/);
    assert.equal(good?.status, 'merged');
  });

  it('mergeSoul records an error entry (not a throw) for an unreadable SOUL.custom.md', () => {
    scaffoldWorkspace(tmpDir);
    const badDir = path.join(tmpDir, 'profiles', 'bad');
    fs.mkdirSync(badDir, { recursive: true });
    // A file that looks like a directory: readFileSync fails with EISDIR,
    // exercising the catch path that records status:"error".
    fs.mkdirSync(path.join(badDir, 'SOUL.custom.md'));

    const results = mergeSoul({ rootDir: tmpDir, logger: () => {} });
    const bad = results.find((r) => r.profile === 'bad');
    assert.equal(bad?.status, 'error');
    assert.ok(bad?.error);
  });
});

describe('CLI exit status reflects per-profile merge failures', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-test-cli-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Workspace: good (valid config) + bad (invalid config) + empty (no custom at all). */
  function scaffoldFailingWorkspace(): void {
    scaffoldWorkspace(tmpDir);
    const goodDir = path.join(tmpDir, 'profiles', 'good');
    const badDir = path.join(tmpDir, 'profiles', 'bad');
    const emptyDir = path.join(tmpDir, 'profiles', 'empty');
    fs.mkdirSync(goodDir, { recursive: true });
    fs.mkdirSync(badDir, { recursive: true });
    fs.mkdirSync(emptyDir, { recursive: true });
    fs.writeFileSync(path.join(goodDir, 'config.custom.yaml'), `model: "good"\n`);
    fs.writeFileSync(path.join(badDir, 'config.custom.yaml'), `just-a-scalar\n`);
    // empty: no config.custom.yaml / jobs.custom.json / SOUL.custom.md (intended no-op).
  }

  /** Workspace with only valid / absent sources: everything merged or skipped, no errors. */
  function scaffoldCleanWorkspace(): void {
    scaffoldWorkspace(tmpDir);
    const goodDir = path.join(tmpDir, 'profiles', 'good');
    const emptyDir = path.join(tmpDir, 'profiles', 'empty');
    fs.mkdirSync(goodDir, { recursive: true });
    fs.mkdirSync(emptyDir, { recursive: true });
    fs.writeFileSync(path.join(goodDir, 'config.custom.yaml'), `model: "good"\n`);
    fs.writeFileSync(path.join(goodDir, 'SOUL.custom.md'), '# good custom soul\n');
  }

  function assertFailingRun(r: { status: number | null; stdout: string; stderr: string }, label: string): void {
    // Non-zero exit ...
    assert.equal(r.status, 1, `${label}: expected exit 1, got ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    // ... no success banner ...
    assert.ok(!r.stdout.includes('✓'), `${label}: success banner must not print on failure:\n${r.stdout}`);
    // ... and the per-profile error is visible.
    const shown = r.stdout + r.stderr;
    assert.ok(
      shown.includes('bad') && shown.toLowerCase().includes('error'),
      `${label}: failure output must name the failing profile:\n${shown}`
    );
  }

  it('sync exits 1 without a success banner when a profile config merge fails', () => {
    scaffoldFailingWorkspace();
    const r = runCli(['sync'], { cwd: tmpDir });
    assertFailingRun(r, 'sync');
  });

  it('sync -q still exits 1 and reports the error on stderr when a merge fails', () => {
    scaffoldFailingWorkspace();
    const r = runCli(['sync'], { cwd: tmpDir, quiet: true });
    assertFailingRun(r, 'sync -q');
    assert.ok(!r.stdout.includes('✓'), `sync -q: no banner on stdout:\n${r.stdout}`);
    assert.match(r.stderr, /Failed: 1 profile\(s\) had merge errors/);
    assert.match(r.stderr, /bad: Custom config is not a valid YAML object/);
  });

  it('sync exits 0 with the success banner when all entries are merged or skipped', () => {
    scaffoldCleanWorkspace();
    const r = runCli(['sync'], { cwd: tmpDir });
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.ok(r.stdout.includes('✓ Synced all Hermes profiles successfully'), r.stdout);
  });

  it('sync -q with only skipped entries exits 0 and prints nothing', () => {
    scaffoldCleanWorkspace();
    const r = runCli(['sync'], { cwd: tmpDir, quiet: true });
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}\nstderr: ${r.stderr}`);
    assert.equal(r.stdout, '', 'quiet success prints nothing on stdout');
  });

  it('merge config exits 1 when a profile config merge fails', () => {
    scaffoldFailingWorkspace();
    const r = runCli(['merge', 'config'], { cwd: tmpDir });
    assertFailingRun(r, 'merge config');
  });

  it('merge config exits 0 with the banner when only skipped entries remain', () => {
    scaffoldCleanWorkspace();
    const r = runCli(['merge', 'config'], { cwd: tmpDir });
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.ok(r.stdout.includes('✓ Merged config for all profiles'), r.stdout);
  });

  it('config-merge alias exits 1 when a profile config merge fails', () => {
    scaffoldFailingWorkspace();
    const r = runCli(['config-merge'], { cwd: tmpDir });
    assertFailingRun(r, 'config-merge');
  });

  it('merge-all alias exits 1 when a profile config merge fails', () => {
    scaffoldFailingWorkspace();
    const r = runCli(['merge-all'], { cwd: tmpDir });
    assertFailingRun(r, 'merge-all');
  });

  it('merge jobs exits 1 when a profile jobs merge fails', () => {
    scaffoldWorkspace(tmpDir);
    const badDir = path.join(tmpDir, 'profiles', 'bad', 'cron');
    const goodDir = path.join(tmpDir, 'profiles', 'good', 'cron');
    fs.mkdirSync(badDir, { recursive: true });
    fs.mkdirSync(goodDir, { recursive: true });
    fs.writeFileSync(path.join(goodDir, 'jobs.custom.json'), JSON.stringify({ jobs: [{ id: '1' }] }) + '\n');
    fs.writeFileSync(path.join(badDir, 'jobs.custom.json'), '{ not valid json');

    const r = runCli(['merge', 'jobs'], { cwd: tmpDir });
    assertFailingRun(r, 'merge jobs');
  });

  it('jobs-merge alias exits 0 with the banner for a valid jobs merge', () => {
    scaffoldWorkspace(tmpDir);
    const goodDir = path.join(tmpDir, 'profiles', 'good', 'cron');
    fs.mkdirSync(goodDir, { recursive: true });
    fs.writeFileSync(path.join(goodDir, 'jobs.custom.json'), JSON.stringify({ jobs: [{ id: '1' }] }) + '\n');

    const r = runCli(['jobs-merge'], { cwd: tmpDir });
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.ok(r.stdout.includes('✓ Merged jobs for all profiles'), r.stdout);
  });

  it('merge soul exits 1 when a profile SOUL merge fails', () => {
    scaffoldWorkspace(tmpDir);
    const badDir = path.join(tmpDir, 'profiles', 'bad');
    fs.mkdirSync(path.join(badDir, 'SOUL.custom.md'), { recursive: true });

    const r = runCli(['merge', 'soul'], { cwd: tmpDir });
    assertFailingRun(r, 'merge soul');
  });

  it('soul-merge alias exits 0 with the banner for a valid SOUL merge', () => {
    scaffoldWorkspace(tmpDir);
    const goodDir = path.join(tmpDir, 'profiles', 'good');
    fs.mkdirSync(goodDir, { recursive: true });
    fs.writeFileSync(path.join(goodDir, 'SOUL.custom.md'), '# good custom soul\n');

    const r = runCli(['soul-merge'], { cwd: tmpDir });
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.ok(r.stdout.includes('✓ Merged SOUL for all profiles'), r.stdout);
  });
});
