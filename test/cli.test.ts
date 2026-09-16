import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mergeConfig } from '../src/core/config.js';
import { mergeJobs } from '../src/core/jobs.js';
import { mergeSoul } from '../src/core/soul.js';
import { collectMergeErrors, MergeStatusResult } from '../src/utils/merge-results.js';

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

describe('CLI link-failure paths (missing link source directory)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-test-cli-link-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * Workspace with a valid profile config plus BROKEN link sources:
   *   - profiles/common/skills   is deleted (linkSkills throws)
   *   - profiles/common/plugins   is deleted (linkPlugins throws)
   *   - profiles/                  is deleted (linkHermes would throw)
   * scaffoldWorkspace already created the common/skills + common/plugins dirs,
   * so this strips them out. No custom sources → the merge step is a benign
   * no-op (all skipped), isolating the link behavior.
   */
  function scaffoldBrokenLinkWorkspace(): void {
    scaffoldWorkspace(tmpDir);
    const goodDir = path.join(tmpDir, 'profiles', 'good');
    fs.mkdirSync(goodDir, { recursive: true });
    fs.writeFileSync(path.join(goodDir, 'config.custom.yaml'), `model: "good"\n`);
    fs.rmSync(path.join(tmpDir, 'profiles', 'common', 'skills'), { recursive: true, force: true });
    fs.rmSync(path.join(tmpDir, 'profiles', 'common', 'plugins'), { recursive: true, force: true });
  }

  /** A clean profile dir with a valid custom config (config merges cleanly). */
  function makeLinkableProfile(name: string): void {
    const dir = path.join(tmpDir, 'profiles', name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.custom.yaml'), `model: "${name}"\n`);
  }

  function assertLinkFailureRun(r: { status: number | null; stdout: string; stderr: string }, label: string): void {
    const shown = r.stdout + r.stderr;
    // Non-zero exit ...
    assert.equal(r.status, 1, `${label}: expected exit 1, got ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    // ... no success banner ...
    assert.ok(!r.stdout.includes('✓'), `${label}: success banner must not print on failure:\n${r.stdout}`);
    // ... no raw stack trace (the whole point of the fix) ...
    assert.ok(!/at [^\n]+\(/.test(r.stderr), `${label}: stderr must not contain a stack trace:\n${r.stderr}`);
    // ... and a readable, one-line link error on stderr ...
    assert.ok(shown.toLowerCase().includes('link'), `${label}: failure must mention the link failure:\n${shown}`);
    assert.ok(r.stderr.includes('Failed:'), `${label}: failure summary missing:\n${r.stderr}`);
  }

  it('link skills prints a clean one-line error and exits 1 when profiles/common/skills is missing', () => {
    scaffoldBrokenLinkWorkspace();
    const r = runCli(['link', 'skills'], { cwd: tmpDir });
    assertLinkFailureRun(r, 'link skills');
    assert.match(r.stderr, /Common skills directory not found/);
  });

  it('skills-link alias prints a clean one-line error and exits 1 when the skills dir is missing', () => {
    scaffoldBrokenLinkWorkspace();
    const r = runCli(['skills-link'], { cwd: tmpDir });
    assertLinkFailureRun(r, 'skills-link');
    assert.match(r.stderr, /Common skills directory not found/);
  });

  it('link plugins prints a clean one-line error and exits 1 when profiles/common/plugins is missing', () => {
    scaffoldBrokenLinkWorkspace();
    const r = runCli(['link', 'plugins'], { cwd: tmpDir });
    assertLinkFailureRun(r, 'link plugins');
    assert.match(r.stderr, /Common plugins directory not found/);
  });

  it('plugins-link alias prints a clean one-line error and exits 1 when the plugins dir is missing', () => {
    scaffoldBrokenLinkWorkspace();
    const r = runCli(['plugins-link'], { cwd: tmpDir });
    assertLinkFailureRun(r, 'plugins-link');
    assert.match(r.stderr, /Common plugins directory not found/);
  });

  it('link hermes prints a clean one-line error and exits 1 when the profiles source dir is missing', () => {
    scaffoldWorkspace(tmpDir);
    // Profiles source dir must not exist for linkHermes to throw.
    fs.rmSync(path.join(tmpDir, 'profiles'), { recursive: true, force: true });
    const r = runCli(['link', 'hermes'], { cwd: tmpDir });
    assertLinkFailureRun(r, 'link hermes');
    assert.match(r.stderr, /Profiles source directory not found/);
  });

  it('hermes-link alias prints a clean one-line error and exits 1 when the profiles dir is missing', () => {
    scaffoldWorkspace(tmpDir);
    fs.rmSync(path.join(tmpDir, 'profiles'), { recursive: true, force: true });
    const r = runCli(['hermes-link'], { cwd: tmpDir });
    assertLinkFailureRun(r, 'hermes-link');
    assert.match(r.stderr, /Profiles source directory not found/);
  });

  it('link (default "all") reports both link failures and exits 1 without a stack trace', () => {
    scaffoldBrokenLinkWorkspace();
    const r = runCli(['link'], { cwd: tmpDir });
    assertLinkFailureRun(r, 'link');
    assert.match(r.stderr, /Common skills directory not found/);
    assert.match(r.stderr, /Common plugins directory not found/);
  });

  it('link -q still exits 1 and prints the link error (banner suppressed) when the link source is missing', () => {
    scaffoldBrokenLinkWorkspace();
    const r = runCli(['link'], { cwd: tmpDir, quiet: true });
    assertLinkFailureRun(r, 'link -q');
    assert.equal(r.stdout, '', 'quiet link failure prints nothing on stdout');
    assert.match(r.stderr, /Failed:/);
    assert.match(r.stderr, /link step/);
  });

  it('sync still reports the per-profile merge result when the link source dirs are missing', () => {
    // A genuinely failing merge + broken link sources: the merge error and
    // the link failures must both be reported in a single run.
    scaffoldWorkspace(tmpDir);
    makeLinkableProfile('good');
    const badDir = path.join(tmpDir, 'profiles', 'bad');
    fs.mkdirSync(badDir, { recursive: true });
    fs.writeFileSync(path.join(badDir, 'config.custom.yaml'), `just-a-scalar\n`);
    fs.rmSync(path.join(tmpDir, 'profiles', 'common', 'skills'), { recursive: true, force: true });
    fs.rmSync(path.join(tmpDir, 'profiles', 'common', 'plugins'), { recursive: true, force: true });

    const r = runCli(['sync'], { cwd: tmpDir });
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.ok(!r.stdout.includes('✓'), `success banner must not print:\n${r.stdout}`);
    // The pre-computed merge result is still reported (the bug this fixes).
    assert.match(r.stderr, /bad: Custom config is not a valid YAML object/);
    // The link failure is reported too.
    assert.match(r.stderr, /Common skills directory not found/);
    assert.match(r.stderr, /Common plugins directory not found/);
    // The summary names BOTH the merge and the link failures.
    assert.match(r.stderr, /1 profile\(s\) had merge errors and 2 link step\(s\) failed/);
    // No raw stack trace.
    assert.ok(!/at [^\n]+\(/.test(r.stderr), `sync: no stack trace allowed:\n${r.stderr}`);
  });

  it('all (sync alias) still reports merge + link results and exits 1 when the link source is missing', () => {
    scaffoldWorkspace(tmpDir);
    makeLinkableProfile('good');
    fs.rmSync(path.join(tmpDir, 'profiles', 'common', 'skills'), { recursive: true, force: true });
    fs.rmSync(path.join(tmpDir, 'profiles', 'common', 'plugins'), { recursive: true, force: true });

    const r = runCli(['all'], { cwd: tmpDir });
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.ok(!r.stdout.includes('✓'), r.stdout);
    // Merge succeeded (only skipped) but the link failures still force a
    // non-zero exit with a clear message.
    assert.match(r.stderr, /Common skills directory not found/);
    assert.match(r.stderr, /2 link step\(s\) failed/);
  });

  it('merge-all still reports merge + link results and exits 1 when the link source is missing', () => {
    scaffoldWorkspace(tmpDir);
    makeLinkableProfile('good');
    const badDir = path.join(tmpDir, 'profiles', 'bad');
    fs.mkdirSync(badDir, { recursive: true });
    fs.writeFileSync(path.join(badDir, 'config.custom.yaml'), `just-a-scalar\n`);
    fs.rmSync(path.join(tmpDir, 'profiles', 'common', 'skills'), { recursive: true, force: true });
    fs.rmSync(path.join(tmpDir, 'profiles', 'common', 'plugins'), { recursive: true, force: true });

    const r = runCli(['merge-all'], { cwd: tmpDir });
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.ok(!r.stdout.includes('✓'), r.stdout);
    assert.match(r.stderr, /bad: Custom config is not a valid YAML object/);
    assert.match(r.stderr, /Common skills directory not found/);
    assert.match(r.stderr, /1 profile\(s\) had merge errors and 2 link step\(s\) failed/);
  });

  it('sync exits 0 with the banner when the link sources are present (regression guard)', () => {
    scaffoldWorkspace(tmpDir);
    makeLinkableProfile('good');
    const r = runCli(['sync'], { cwd: tmpDir });
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.ok(r.stdout.includes('✓ Synced all Hermes profiles successfully'), r.stdout);
  });
});

describe('CLI init exit status reflects initial-sync failures', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-test-cli-init-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Shared failure assertions: non-zero exit, no banner, readable stderr. */
  function assertFailingInit(r: { status: number | null; stdout: string; stderr: string }, label: string): void {
    assert.equal(r.status, 1, `${label}: expected exit 1, got ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.ok(!r.stdout.includes('✓'), `${label}: success banner must not print on failure:\n${r.stdout}`);
    assert.ok(!/at [^\n]+\(/.test(r.stderr), `${label}: stderr must not contain a stack trace:\n${r.stderr}`);
    assert.match(r.stderr, /Failed:/);
  }

  it('init exits 1 without a success banner when profiles/common/config.yaml is broken', () => {
    // Pre-existing workspace with a CORRUPT common config (a YAML list).
    // init must not overwrite it (no --force), and the initial sync must
    // fail cleanly with a non-zero exit instead of a false success banner.
    scaffoldWorkspace(tmpDir);
    fs.writeFileSync(
      path.join(tmpDir, 'profiles', 'common', 'config.yaml'),
      `- just\n- a\n- list\n`
    );

    const r = runCli(['init'], { cwd: tmpDir });
    assertFailingInit(r, 'init');
    // The specific top-level merge error is reported on stderr.
    assert.match(r.stderr, /Common config must be a YAML object/);
    assert.match(r.stderr, /Failed: the sync run failed/);
    // init without force preserved the broken file instead of silently
    // repairing it and claiming success.
    assert.match(
      fs.readFileSync(path.join(tmpDir, 'profiles', 'common', 'config.yaml'), 'utf8'),
      /- just/
    );
  });

  it('init -q exits 1 and still reports the broken common config on stderr', () => {
    scaffoldWorkspace(tmpDir);
    fs.writeFileSync(
      path.join(tmpDir, 'profiles', 'common', 'config.yaml'),
      `- just\n- a\n- list\n`
    );

    const r = runCli(['init'], { cwd: tmpDir, quiet: true });
    assertFailingInit(r, 'init -q');
    assert.ok(!r.stdout.includes('✓'), `init -q: no banner on stdout:\n${r.stdout}`);
    assert.match(r.stderr, /Common config must be a YAML object/);
  });

  it('init exits 1 without a success banner when the initial sync has a per-profile merge error', () => {
    // A pre-existing profile with an invalid custom config: the initial
    // sync records it as a status:'error' entry, and init must surface it.
    scaffoldWorkspace(tmpDir);
    const badDir = path.join(tmpDir, 'profiles', 'bad');
    fs.mkdirSync(badDir, { recursive: true });
    fs.writeFileSync(path.join(badDir, 'config.custom.yaml'), `just-a-scalar\n`);

    const r = runCli(['init'], { cwd: tmpDir });
    assertFailingInit(r, 'init per-profile');
    const shown = r.stdout + r.stderr;
    assert.ok(
      shown.includes('bad') && shown.toLowerCase().includes('error'),
      `init: failure output must name the failing profile:\n${shown}`
    );
    assert.match(r.stderr, /bad: Custom config is not a valid YAML object/);
  });

  it('init exits 0 with the success banner and compiled outputs on a clean workspace', () => {
    const r = runCli(['init'], { cwd: tmpDir });
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.ok(r.stdout.includes('✓ Successfully initialized Hermes profiles'), r.stdout);
    assert.ok(fs.existsSync(path.join(tmpDir, 'profiles', 'main', 'config.yaml')));
    assert.ok(fs.existsSync(path.join(tmpDir, 'profiles', 'main', 'SOUL.md')));
    assert.ok(fs.existsSync(path.join(tmpDir, 'profiles', 'main', 'cron', 'jobs.json')));
  });

  it('init --no-sync exits 0 even with a broken common config (no sync was run)', () => {
    // With --no-sync the initial sync does not run, so there is no sync
    // result to gate on: the scaffold itself succeeded.
    scaffoldWorkspace(tmpDir);
    fs.writeFileSync(
      path.join(tmpDir, 'profiles', 'common', 'config.yaml'),
      `- just\n- a\n- list\n`
    );

    const r = runCli(['init', '--no-sync'], { cwd: tmpDir });
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.ok(r.stdout.includes('✓ Successfully initialized Hermes profiles'), r.stdout);
  });
});

describe('CLI sync/all/merge-all exit status reflects top-level sync failures', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-test-cli-synctoplevel-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * Valid workspace whose top-level `profiles/common/config.yaml` parses to a
   * YAML LIST, so mergeConfig throws the top-level precondition
   * "Common config must be a YAML object" — captured by syncAll into
   * `result.syncError` instead of thrown.
   */
  function scaffoldBrokenTopLevelWorkspace(): void {
    scaffoldWorkspace(tmpDir);
    fs.writeFileSync(
      path.join(tmpDir, 'profiles', 'common', 'config.yaml'),
      `- just\n- a\n- list\n`
    );
  }

  /** Shared failure assertions: exit 1, no banner, readable top-level error. */
  function assertFailingTopLevelRun(r: { status: number | null; stdout: string; stderr: string }, label: string): void {
    assert.equal(r.status, 1, `${label}: expected exit 1, got ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.ok(!r.stdout.includes('✓'), `${label}: success banner must not print on failure:\n${r.stdout}`);
    assert.ok(!/at [^\n]+\(/.test(r.stderr), `${label}: stderr must not contain a stack trace:\n${r.stderr}`);
    assert.match(r.stderr, /the sync run failed/);
    assert.match(r.stderr, /Common config must be a YAML object/);
  }

  it('sync exits 1 and reports the top-level failure when profiles/common/config.yaml is not a YAML object', () => {
    scaffoldBrokenTopLevelWorkspace();
    const r = runCli(['sync'], { cwd: tmpDir });
    assertFailingTopLevelRun(r, 'sync');
  });

  it('all (sync alias) exits 1 and reports the top-level failure when the common config is not a YAML object', () => {
    scaffoldBrokenTopLevelWorkspace();
    const r = runCli(['all'], { cwd: tmpDir });
    assertFailingTopLevelRun(r, 'all');
  });

  it('merge-all exits 1 and reports the top-level failure when the common config is not a YAML object', () => {
    scaffoldBrokenTopLevelWorkspace();
    const r = runCli(['merge-all'], { cwd: tmpDir });
    assertFailingTopLevelRun(r, 'merge-all');
  });

  it('sync -q still exits 1 and writes the top-level failure to stderr (banner suppressed)', () => {
    scaffoldBrokenTopLevelWorkspace();
    const r = runCli(['sync'], { cwd: tmpDir, quiet: true });
    assert.equal(r.status, 1, `sync -q: expected exit 1, got ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.equal(r.stdout, '', 'sync -q prints nothing on stdout');
    assert.match(r.stderr, /the sync run failed/);
    assert.match(r.stderr, /Common config must be a YAML object/);
  });

  it('sync exits 0 with the success banner when the workspace is genuinely valid (regression guard)', () => {
    scaffoldWorkspace(tmpDir);
    const r = runCli(['sync'], { cwd: tmpDir });
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.ok(r.stdout.includes('✓ Synced all Hermes profiles successfully'), r.stdout);
  });
});

describe('CLI standalone merge family handles top-level merge preconditions cleanly', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-test-cli-mergetoplevel-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * Valid workspace whose top-level `profiles/common/config.yaml` parses to a
   * YAML LIST, so mergeConfig throws the top-level precondition
   * "Common config must be a YAML object" — the same failure shape used by
   * the PR #8 sync suite, now exercised through the STANDALONE merge commands
   * (which previously had no try/catch and died with a raw stack trace).
   */
  function scaffoldBrokenTopLevelWorkspace(): void {
    scaffoldWorkspace(tmpDir);
    fs.writeFileSync(
      path.join(tmpDir, 'profiles', 'common', 'config.yaml'),
      `- just\n- a\n- list\n`
    );
  }

  /**
   * Shared failure assertions for a top-level merge precondition: exit 1, no
   * success banner, no raw stack trace, the readable precondition message,
   * and the shared `Failed: the merge run failed.` summary.
   */
  function assertFailingTopLevelMergeRun(
    r: { status: number | null; stdout: string; stderr: string },
    label: string
  ): void {
    assert.equal(r.status, 1, `${label}: expected exit 1, got ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.ok(!r.stdout.includes('✓'), `${label}: success banner must not print on failure:\n${r.stdout}`);
    assert.ok(!/at [^\n]+\(/.test(r.stderr), `${label}: stderr must not contain a stack trace:\n${r.stderr}`);
    assert.match(r.stderr, /Common config must be a YAML object/);
    assert.match(r.stderr, /Failed: the merge run failed/);
  }

  it('merge config exits 1 and reports the top-level failure when the common config is not a YAML object', () => {
    scaffoldBrokenTopLevelWorkspace();
    const r = runCli(['merge', 'config'], { cwd: tmpDir });
    assertFailingTopLevelMergeRun(r, 'merge config');
  });

  it('config-merge alias exits 1 and reports the top-level failure when the common config is not a YAML object', () => {
    scaffoldBrokenTopLevelWorkspace();
    const r = runCli(['config-merge'], { cwd: tmpDir });
    assertFailingTopLevelMergeRun(r, 'config-merge');
  });

  it('merge all exits 1 and reports the top-level failure when the common config is not a YAML object', () => {
    // mergeAll calls mergeConfig first, so the same top-level precondition
    // hits `merge all` too (previously a raw stack trace).
    scaffoldBrokenTopLevelWorkspace();
    const r = runCli(['merge', 'all'], { cwd: tmpDir });
    assertFailingTopLevelMergeRun(r, 'merge all');
  });

  it('merge config -q still exits 1 and writes the top-level failure to stderr (banner suppressed)', () => {
    scaffoldBrokenTopLevelWorkspace();
    const r = runCli(['merge', 'config'], { cwd: tmpDir, quiet: true });
    assert.equal(r.status, 1, `merge config -q: expected exit 1, got ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.equal(r.stdout, '', 'merge config -q prints nothing on stdout');
    assert.match(r.stderr, /Common config must be a YAML object/);
    assert.match(r.stderr, /Failed: the merge run failed/);
  });

  it('merge config exits 0 with the banner when the workspace is genuinely valid (regression guard)', () => {
    scaffoldWorkspace(tmpDir);
    const goodDir = path.join(tmpDir, 'profiles', 'good');
    fs.mkdirSync(goodDir, { recursive: true });
    fs.writeFileSync(path.join(goodDir, 'config.custom.yaml'), `model: "good"\n`);

    const r = runCli(['merge', 'config'], { cwd: tmpDir });
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.ok(r.stdout.includes('✓ Merged config for all profiles'), r.stdout);
    assert.equal(r.stderr, '', 'clean merge config prints nothing on stderr');
  });

  it('merge soul exits 1 cleanly when profiles/common/SOUL.md is absent (top-level precondition)', () => {
    scaffoldWorkspace(tmpDir);
    fs.rmSync(path.join(tmpDir, 'profiles', 'common', 'SOUL.md'), { force: true });
    const r = runCli(['merge', 'soul'], { cwd: tmpDir });
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.ok(!r.stdout.includes('✓'), `no banner:\n${r.stdout}`);
    assert.ok(!/at [^\n]+\(/.test(r.stderr), `no stack trace:\n${r.stderr}`);
    assert.match(r.stderr, /Common SOUL file not found/);
    assert.match(r.stderr, /Failed: the merge run failed/);
  });

  it('soul-merge alias exits 1 cleanly when profiles/common/SOUL.md is absent (top-level precondition)', () => {
    scaffoldWorkspace(tmpDir);
    fs.rmSync(path.join(tmpDir, 'profiles', 'common', 'SOUL.md'), { force: true });
    const r = runCli(['soul-merge'], { cwd: tmpDir });
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.ok(!r.stdout.includes('✓'), `no banner:\n${r.stdout}`);
    assert.ok(!/at [^\n]+\(/.test(r.stderr), `no stack trace:\n${r.stderr}`);
    assert.match(r.stderr, /Common SOUL file not found/);
    assert.match(r.stderr, /Failed: the merge run failed/);
  });

  it('merge jobs exits 1 cleanly when no profile has cron/jobs.custom.json (top-level precondition)', () => {
    // scaffoldWorkspace creates the common sources but no profiles and no
    // cron/jobs.custom.json, so the standalone mergeJobs (allowEmpty=false)
    // throws the "nothing to merge" precondition.
    scaffoldWorkspace(tmpDir);
    const r = runCli(['merge', 'jobs'], { cwd: tmpDir });
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.ok(!r.stdout.includes('✓'), `no banner:\n${r.stdout}`);
    assert.ok(!/at [^\n]+\(/.test(r.stderr), `no stack trace:\n${r.stderr}`);
    assert.match(r.stderr, /no profiles with cron\/jobs\.custom\.json found/);
    assert.match(r.stderr, /Failed: the merge run failed/);
  });

  it('jobs-merge alias exits 1 cleanly when no profile has cron/jobs.custom.json (top-level precondition)', () => {
    scaffoldWorkspace(tmpDir);
    const r = runCli(['jobs-merge'], { cwd: tmpDir });
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.ok(!r.stdout.includes('✓'), `no banner:\n${r.stdout}`);
    assert.ok(!/at [^\n]+\(/.test(r.stderr), `no stack trace:\n${r.stderr}`);
    assert.match(r.stderr, /no profiles with cron\/jobs\.custom\.json found/);
    assert.match(r.stderr, /Failed: the merge run failed/);
  });
});
