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
    // Also clean the shared escape target the path-traversal regression
    // test asserts on: path.dirname(tmpDir) is the OS temp dir, so
    // <tmpdir>/pwned is a SHARED path across runs. A stale artifact there
    // (e.g. leftover from a run before the validation fix shipped) would
    // make the !existsSync assertion fail forever. Hermetic: remove it
    // here, not only in the test itself.
    fs.rmSync(path.join(path.dirname(tmpDir), 'pwned'), { recursive: true, force: true });
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

  it('init --profile with a path-traversal name exits 1 with a clean error and writes no files', () => {
    // The CLI exposes --profile directly; a malicious or typoed name must
    // be rejected BEFORE any side effect, not turn into a write outside the
    // target workspace.
    //
    // NOTE: the SHORT form `-p` is deliberately NOT exercised here. The
    // program-wide `-p, --profiles <names...>` global option shadows the
    // subcommand-level `-p, --profile` alias (commander resolves a `-p` on
    // `init` to the global variadic `profiles` option), so `init -p X` never
    // reaches the profile-name code path. The long `--profile` form is the
    // documented CLI spelling for this option.
    // The escape target that path.join(tmpDir, 'profiles', '../../pwned')
    // actually resolves to is <shared-tmpdir>/pwned — the SAME path for
    // every run, because tmpDir lives under os.tmpdir(). Clean it up in
    // afterEach (see above) so this precondition holds hermetically.
    const escapeDir = path.join(path.dirname(tmpDir), 'pwned');
    assert.ok(!fs.existsSync(escapeDir), 'precondition: shared escape target must not exist yet');

    const r = runCli(['init', '--profile', '../../pwned'], { cwd: tmpDir });
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    // No success banner...
    assert.ok(!r.stdout.includes('✓'), `no success banner on failure:\n${r.stdout}`);
    // ...no raw stack trace...
    assert.ok(!/at [^\n]+\(/.test(r.stderr), `stderr must not contain a stack trace:\n${r.stderr}`);
    // ...the invalid name is named on stderr, with the Failed: summary...
    assert.match(r.stderr, /Invalid profile name: "\.\.\/\.\.\/pwned"/);
    assert.match(r.stderr, /Failed: invalid profile name/);
    // ...and NOTHING was written outside the workspace.
    assert.ok(
      !fs.existsSync(escapeDir),
      `no files may escape the workspace (found: ${escapeDir})`
    );
    assert.ok(
      !fs.existsSync(path.join(tmpDir, 'profiles')),
      'the rejected init must not create the workspace profiles/ tree'
    );
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

  it('merge jobs exits 1 cleanly when there are no profiles (top-level precondition)', () => {
    // scaffoldWorkspace creates the common sources but no profile subdirs, so
    // the standalone mergeJobs (allowEmpty=false) throws the shared
    // "No profiles found under" no-targets precondition — the same error
    // mergeConfig throws, so the sub-commands no longer diverge.
    scaffoldWorkspace(tmpDir);
    const r = runCli(['merge', 'jobs'], { cwd: tmpDir });
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.ok(!r.stdout.includes('✓'), `no banner:\n${r.stdout}`);
    assert.ok(!/at [^\n]+\(/.test(r.stderr), `no stack trace:\n${r.stderr}`);
    assert.match(r.stderr, /No profiles found under/);
    assert.match(r.stderr, /Failed: the merge run failed/);
  });

  it('jobs-merge alias exits 1 cleanly when there are no profiles (top-level precondition)', () => {
    scaffoldWorkspace(tmpDir);
    const r = runCli(['jobs-merge'], { cwd: tmpDir });
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.ok(!r.stdout.includes('✓'), `no banner:\n${r.stdout}`);
    assert.ok(!/at [^\n]+\(/.test(r.stderr), `no stack trace:\n${r.stderr}`);
    assert.match(r.stderr, /No profiles found under/);
    assert.match(r.stderr, /Failed: the merge run failed/);
  });

  it('merge config -p <name> with no custom source exits 0 with the banner (explicit target is a no-op, not a failure)', () => {
    // Reference behavior for the -p contract: explicitly naming a profile
    // that lacks a custom source is a per-profile skipped no-op (exit 0).
    //
    // NOTE on flag placement: `-p, --profiles <names...>` is a VARIADIC
    // program-level option, so `hpm -p real merge config` makes the
    // variadic swallow `merge config` as more profile names (commander
    // then errors out with usage, exit 1). The working placements are
    // `-p <name> -- merge config` and `merge config -p <name>`; these
    // tests pin the flag-after-subcommand form.
    scaffoldWorkspace(tmpDir);
    fs.mkdirSync(path.join(tmpDir, 'profiles', 'real'), { recursive: true });
    const r = runCli(['merge', 'config', '-p', 'real'], { cwd: tmpDir });
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.ok(r.stdout.includes('✓ Merged config for all profiles'), r.stdout);
    assert.equal(r.stderr, '', 'clean -p merge config prints nothing on stderr');
  });

  it('merge jobs -p <name> with no cron source exits 0 with the banner (no "no profiles found" failure)', () => {
    // Regression target: `merge jobs -p <name>` used to exit 1 with
    // "no profiles with cron/jobs.custom.json found under ..." when the
    // named profile had no cron source. It must now behave like merge
    // config: a per-profile skipped no-op, exit 0.
    // (Flag-after-subcommand placement: the variadic `-p` swallows a
    // following subcommand, see the merge config -p test above.)
    scaffoldWorkspace(tmpDir);
    fs.mkdirSync(path.join(tmpDir, 'profiles', 'real'), { recursive: true });
    const r = runCli(['merge', 'jobs', '-p', 'real'], { cwd: tmpDir });
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.ok(r.stdout.includes('✓ Merged jobs for all profiles'), r.stdout);
    assert.ok(!/no profiles with cron\/jobs\.custom\.json found/.test(r.stderr), `no top-level failure:\n${r.stderr}`);
    assert.equal(r.stderr, '', 'clean -p merge jobs prints nothing on stderr');
  });

  it('merge soul -p <name> with no SOUL source exits 0 with the banner (no "no profiles found" failure)', () => {
    // Mirror of the merge jobs -p regression, for the SOUL concern.
    scaffoldWorkspace(tmpDir);
    fs.mkdirSync(path.join(tmpDir, 'profiles', 'real'), { recursive: true });
    const r = runCli(['merge', 'soul', '-p', 'real'], { cwd: tmpDir });
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.ok(r.stdout.includes('✓ Merged SOUL for all profiles'), r.stdout);
    assert.ok(!/no profiles with SOUL\.custom\.md found/.test(r.stderr), `no top-level failure:\n${r.stderr}`);
    assert.equal(r.stderr, '', 'clean -p merge soul prints nothing on stderr');
  });

  it('jobs-merge -p <name> and soul-merge -p <name> aliases exit 0 with no source (no "no profiles found" failure)', () => {
    // The Make-alias commands (jobs-merge / soul-merge) share the same
    // standalone mergeJobs/mergeSoul path, so the explicit -p no-op
    // contract must hold for the aliases too.
    scaffoldWorkspace(tmpDir);
    fs.mkdirSync(path.join(tmpDir, 'profiles', 'real'), { recursive: true });

    const rJobs = runCli(['jobs-merge', '-p', 'real'], { cwd: tmpDir });
    assert.equal(rJobs.status, 0, `jobs-merge -p expected exit 0, got ${rJobs.status}\nstdout: ${rJobs.stdout}\nstderr: ${rJobs.stderr}`);
    assert.ok(rJobs.stdout.includes('✓ Merged jobs for all profiles'), rJobs.stdout);
    assert.equal(rJobs.stderr, '', 'clean -p jobs-merge prints nothing on stderr');

    const rSoul = runCli(['soul-merge', '-p', 'real'], { cwd: tmpDir });
    assert.equal(rSoul.status, 0, `soul-merge -p expected exit 0, got ${rSoul.status}\nstdout: ${rSoul.stdout}\nstderr: ${rSoul.stderr}`);
    assert.ok(rSoul.stdout.includes('✓ Merged SOUL for all profiles'), rSoul.stdout);
    assert.equal(rSoul.stderr, '', 'clean -p soul-merge prints nothing on stderr');
  });
});

describe('CLI --dry-run reports results without writing to disk', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-test-cli-dryrun-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * The global `-d, --dry-run` flag is a program-level commander option
   * (src/cli.ts), so it must be placed BEFORE the subcommand:
   * `hpm --dry-run sync`, not `hpm sync --dry-run`. These tests pin that
   * placement at the CLI boundary.
   *
   * The side-effect-free contract these tests lock in:
   *   1. no output files written (profiles/<p>/config.yaml,
   *      profiles/<p>/cron/jobs.json, profiles/<p>/SOUL.md)
   *   2. no symlinks created (profiles/<p>/skills|plugins,
   *      $HERMES_HOME/plugins, $HERMES_HOME/profiles)
   *   3. exit code and reporting identical to a real run (dry-run never
   *      masks errors)
   *   4. a real (non-dry) run on the same workspace DOES write, proving the
   *      absence assertions above are meaningful
   *   5. stdout stays honest about the dry run: no "written to" claims and
   *      success banners are preview-worded (prefixed "Would "), so the
   *      output never asserts a side effect that did not happen
   */

  /** Walks dir and returns the paths of every symlink found inside it. */
  function collectSymlinks(dir: string): string[] {
    if (!fs.existsSync(dir)) {
      return [];
    }
    const found: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      const lstat = fs.lstatSync(p);
      if (lstat.isSymbolicLink()) {
        found.push(p);
      } else if (lstat.isDirectory()) {
        found.push(...collectSymlinks(p));
      }
    }
    return found;
  }

  it('sync --dry-run exits 0, prints the success banner, and writes nothing', () => {
    scaffoldWorkspace(tmpDir);
    const goodDir = path.join(tmpDir, 'profiles', 'good');
    const emptyDir = path.join(tmpDir, 'profiles', 'empty');
    fs.mkdirSync(goodDir, { recursive: true });
    fs.mkdirSync(emptyDir, { recursive: true });
    fs.writeFileSync(path.join(goodDir, 'config.custom.yaml'), `model: "good"\n`);
    fs.writeFileSync(path.join(goodDir, 'SOUL.custom.md'), '# good custom soul\n');

    const r = runCli(['--dry-run', 'sync'], { cwd: tmpDir });
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    // Honest preview wording: the dry-run banner is prefixed "Would ", and no
    // merge line claims a file was written.
    assert.ok(r.stdout.includes('✓ Would Synced all Hermes profiles successfully'), r.stdout);
    assert.ok(!r.stdout.includes('written to'), `dry-run stdout must not claim files were written:\n${r.stdout}`);
    assert.ok(!fs.existsSync(path.join(goodDir, 'config.yaml')), 'dry-run must not write config.yaml');
    assert.ok(!fs.existsSync(path.join(goodDir, 'cron', 'jobs.json')), 'dry-run must not write jobs.json');
    assert.ok(!fs.existsSync(path.join(goodDir, 'SOUL.md')), 'dry-run must not write SOUL.md');
    // No symlinks were created (skills/plugins sources are empty no-ops, so
    // this also proves the link step itself produced no side effects).
    assert.deepEqual(collectSymlinks(path.join(tmpDir, 'profiles')), [], 'no symlinks under profiles/');
    // $HERMES_HOME (pinned to <cwd>/fake-hermes by runCli) was not touched.
    assert.ok(!fs.existsSync(path.join(tmpDir, 'fake-hermes')), 'dry-run must not create symlinks in HERMES_HOME');
  });

  it('sync --dry-run -q exits 0 and prints nothing on stdout', () => {
    scaffoldWorkspace(tmpDir);
    const goodDir = path.join(tmpDir, 'profiles', 'good');
    fs.mkdirSync(goodDir, { recursive: true });
    fs.writeFileSync(path.join(goodDir, 'config.custom.yaml'), `model: "good"\n`);

    const r = runCli(['--dry-run', 'sync'], { cwd: tmpDir, quiet: true });
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}\nstderr: ${r.stderr}`);
    assert.equal(r.stdout, '', 'quiet dry-run prints nothing on stdout');
    assert.ok(!fs.existsSync(path.join(goodDir, 'config.yaml')), 'dry-run must not write config.yaml');
  });

  it('merge config --dry-run reports merged (exit 0) but leaves config.yaml absent', () => {
    scaffoldWorkspace(tmpDir);
    const goodDir = path.join(tmpDir, 'profiles', 'good');
    fs.mkdirSync(goodDir, { recursive: true });
    fs.writeFileSync(path.join(goodDir, 'config.custom.yaml'), `model: "good"\n`);

    const r = runCli(['--dry-run', 'merge', 'config'], { cwd: tmpDir });
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    // Honest preview wording: the dry-run banner is prefixed "Would " and the
    // merge line phrases the write as a preview, not a completed action.
    assert.ok(r.stdout.includes('✓ Would Merged config for all profiles'), r.stdout);
    assert.ok(!r.stdout.includes('written to'), `dry-run stdout must not claim files were written:\n${r.stdout}`);
    assert.ok(r.stdout.includes('Would merge config to:'), `dry-run merge line should be preview-worded:\n${r.stdout}`);
    assert.ok(!fs.existsSync(path.join(goodDir, 'config.yaml')), 'dry-run must not write config.yaml');
  });

  it('link --dry-run (default all) creates no symlink yet exits 0 with the banner', () => {
    scaffoldWorkspace(tmpDir);
    // Real common skill + plugin sources, so a live run WOULD create links.
    const goodDir = path.join(tmpDir, 'profiles', 'good');
    fs.mkdirSync(goodDir, { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'profiles', 'common', 'skills', 'demo-skill'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'profiles', 'common', 'plugins', 'demo-plugin'), { recursive: true });

    const r = runCli(['--dry-run', 'link'], { cwd: tmpDir });
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    // Honest preview wording: the dry-run banner is prefixed "Would ", and no
    // line claims a link was created.
    assert.ok(r.stdout.includes('✓ Would Linked skills and plugins for all profiles'), r.stdout);
    // Honest preview wording on the per-item lines: the banner is the only
    // line mentioning "Linked", and every other line phrases the link as a
    // preview ("Would link ..."), never a completed action.
    const nonBannerLines = r.stdout.split('\n').filter((l) => l.trim() !== '' && !l.includes('✓'));
    assert.ok(!nonBannerLines.some((l) => l.includes('Linked ')), `no "Linked" claim in per-item lines:\n${r.stdout}`);
    assert.ok(nonBannerLines.every((l) => l.startsWith('Would link ')), `dry-run link lines should be preview-worded:\n${r.stdout}`);
    // No symlinks anywhere under profiles/ ...
    assert.deepEqual(collectSymlinks(path.join(tmpDir, 'profiles')), [], 'no symlinks under profiles/');
    // ... and none in $HERMES_HOME/plugins either.
    assert.ok(
      !fs.existsSync(path.join(tmpDir, 'fake-hermes', 'plugins')),
      'dry-run must not create symlinks in HERMES_HOME/plugins'
    );
  });

  it('sync --dry-run on a failing workspace still exits 1 and reports the error (dry-run does not mask errors)', () => {
    scaffoldWorkspace(tmpDir);
    const goodDir = path.join(tmpDir, 'profiles', 'good');
    const badDir = path.join(tmpDir, 'profiles', 'bad');
    fs.mkdirSync(goodDir, { recursive: true });
    fs.mkdirSync(badDir, { recursive: true });
    fs.writeFileSync(path.join(goodDir, 'config.custom.yaml'), `model: "good"\n`);
    // A bare scalar is valid YAML but not an object → status:'error'.
    fs.writeFileSync(path.join(badDir, 'config.custom.yaml'), `just-a-scalar\n`);

    const r = runCli(['--dry-run', 'sync'], { cwd: tmpDir });
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.ok(!r.stdout.includes('✓'), `success banner must not print on failure:\n${r.stdout}`);
    assert.match(r.stderr, /bad: Custom config is not a valid YAML object/);
    assert.match(r.stderr, /Failed: 1 profile\(s\) had merge errors/);
    // The run only skipped the writes: nothing was mutated.
    assert.ok(!fs.existsSync(path.join(goodDir, 'config.yaml')), 'dry-run must not write config.yaml');
    assert.ok(!fs.existsSync(path.join(badDir, 'config.yaml')), 'dry-run must not write config.yaml');
  });

  it('(guard) a non-dry sync on the same workspace DOES write the outputs', () => {
    // Proves the absence assertions above are meaningful: the identical
    // workspace without --dry-run writes every expected artifact.
    scaffoldWorkspace(tmpDir);
    const goodDir = path.join(tmpDir, 'profiles', 'good');
    fs.mkdirSync(goodDir, { recursive: true });
    fs.writeFileSync(path.join(goodDir, 'config.custom.yaml'), `model: "good"\n`);
    fs.writeFileSync(path.join(goodDir, 'SOUL.custom.md'), '# good custom soul\n');
    fs.mkdirSync(path.join(goodDir, 'cron'), { recursive: true });
    fs.writeFileSync(
      path.join(goodDir, 'cron', 'jobs.custom.json'),
      JSON.stringify({ jobs: [{ id: '1' }] }) + '\n'
    );

    const r = runCli(['sync'], { cwd: tmpDir });
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.ok(fs.existsSync(path.join(goodDir, 'config.yaml')), 'real sync must write config.yaml');
    assert.ok(fs.existsSync(path.join(goodDir, 'cron', 'jobs.json')), 'real sync must write jobs.json');
    assert.ok(fs.existsSync(path.join(goodDir, 'SOUL.md')), 'real sync must write SOUL.md');
  });

  it('init --dry-run exits 0, prints the preview banner, and writes nothing under the target dir', () => {
    const targetDir = path.join(tmpDir, 'dry-init');
    fs.mkdirSync(targetDir, { recursive: true });

    const r = runCli(['--dry-run', 'init', targetDir], { cwd: tmpDir });
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    // The banner is a preview under --dry-run: it must NOT assert the
    // workspace was initialized or the profile was created.
    assert.ok(
      r.stdout.includes('✓ Would initialize Hermes profiles in'),
      `dry-run preview banner missing:\n${r.stdout}`
    );
    assert.ok(
      !r.stdout.includes('Successfully initialized Hermes profiles in'),
      `dry-run banner must not claim the workspace was initialized:\n${r.stdout}`
    );
    assert.ok(
      r.stdout.includes('Profile to create:'),
      `dry-run banner must preview the profile as "to create":\n${r.stdout}`
    );
    assert.ok(
      !r.stdout.includes('Profile created:'),
      `dry-run banner must not claim the profile was created:\n${r.stdout}`
    );
    // The banner phrases the count as a preview (nothing was written).
    assert.ok(
      r.stdout.includes('Files to create: 5'),
      `dry-run banner must report "Files to create":\n${r.stdout}`
    );
    assert.ok(
      !r.stdout.includes('Files created:'),
      `dry-run banner must not claim files were created:\n${r.stdout}`
    );
    // Nothing at all was written: no profiles/ tree, no common sources, no
    // per-profile custom sources, no compiled sync outputs, no symlinks.
    assert.ok(
      !fs.existsSync(path.join(targetDir, 'profiles')),
      'dry-run init must not create the profiles/ tree at all'
    );
    // $HERMES_HOME (pinned to <cwd>/fake-hermes by runCli) was not touched.
    assert.ok(!fs.existsSync(path.join(tmpDir, 'fake-hermes')), 'dry-run init must not touch HERMES_HOME');
  });

  it('init --dry-run -q exits 0 and prints nothing on stdout', () => {
    const targetDir = path.join(tmpDir, 'quiet-dry-init');
    fs.mkdirSync(targetDir, { recursive: true });

    const r = runCli(['--dry-run', 'init', targetDir], { cwd: tmpDir, quiet: true });
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}\nstderr: ${r.stderr}`);
    assert.equal(r.stdout, '', 'quiet dry-run prints nothing on stdout');
    assert.ok(
      !fs.existsSync(path.join(targetDir, 'profiles')),
      'quiet dry-run init must not create the profiles/ tree'
    );
  });

  it('(guard) a real (non-dry) init on the same target DOES create the files', () => {
    // Proves the absence assertions above are meaningful: the identical
    // target without --dry-run scaffolds the full profile tree AND runs the
    // initial sync (compiled outputs appear).
    const targetDir = path.join(tmpDir, 'real-init');
    fs.mkdirSync(targetDir, { recursive: true });

    // Use the LONG form of the profile option: the short form `-p` is
    // shadowed by the program-level `-p, --profiles <profiles...>` option
    // (commander routes it to the parent), a pre-existing CLI quirk
    // unrelated to this test's contract.
    const r = runCli(['init', targetDir, '--profile', 'agent-1'], { cwd: tmpDir });
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    // A real init reports the files it actually wrote.
    assert.ok(r.stdout.includes('Files created: 5'), r.stdout);
    assert.ok(!r.stdout.includes('Files to create:'), r.stdout);
    // Common sources
    assert.ok(fs.existsSync(path.join(targetDir, 'profiles', 'common', 'config.yaml')), 'real init must write common config.yaml');
    assert.ok(fs.existsSync(path.join(targetDir, 'profiles', 'common', 'SOUL.md')), 'real init must write common SOUL.md');
    assert.ok(fs.existsSync(path.join(targetDir, 'profiles', 'common', 'skills')), 'real init must create skills dir');
    assert.ok(fs.existsSync(path.join(targetDir, 'profiles', 'common', 'plugins')), 'real init must create plugins dir');
    // Per-profile custom sources
    const agentDir = path.join(targetDir, 'profiles', 'agent-1');
    assert.ok(fs.existsSync(path.join(agentDir, 'config.custom.yaml')), 'real init must write config.custom.yaml');
    assert.ok(fs.existsSync(path.join(agentDir, 'SOUL.custom.md')), 'real init must write SOUL.custom.md');
    assert.ok(fs.existsSync(path.join(agentDir, 'cron', 'jobs.custom.json')), 'real init must write jobs.custom.json');
    // Compiled outputs from the real initial sync
    assert.ok(fs.existsSync(path.join(agentDir, 'config.yaml')), 'real initial sync must write config.yaml');
    assert.ok(fs.existsSync(path.join(agentDir, 'SOUL.md')), 'real initial sync must write SOUL.md');
    assert.ok(fs.existsSync(path.join(agentDir, 'cron', 'jobs.json')), 'real initial sync must write jobs.json');
  });
});
