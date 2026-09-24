import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parse as parseYaml } from 'yaml';
import { mergeConfig } from '../src/core/config.js';

describe('mergeConfig', () => {
  let tmpDir: string;
  // Shared escape target the path-traversal regression tests assert on:
  // path.dirname(tmpDir) is the OS temp dir, so <tmpdir>/pwned is SHARED
  // across runs. A stale artifact there would make the "wrote nothing
  // outside the workspace" assertion fail forever.
  const pwnedDir = () => path.join(path.dirname(tmpDir), 'pwned');

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-test-config-'));
    // Hermetic precondition: no stale escape artifact from an earlier run.
    fs.rmSync(pwnedDir(), { recursive: true, force: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    // Clean the shared escape target (see pwnedDir above).
    fs.rmSync(pwnedDir(), { recursive: true, force: true });
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

  it('rejects a path-traversal profile name BEFORE any filesystem side effect', () => {
    // SECURITY REGRESSION (path traversal via user-controlled -p/--profiles):
    // path.join(profilesDir, '../../pwned', 'config.yaml') resolves OUTSIDE
    // the workspace (to <tmpdir>/pwned/config.yaml). The name must be
    // rejected before any read of the pre-seeded source and before any
    // write to the escaped path.
    const escapeDir = pwnedDir();
    assert.ok(!fs.existsSync(escapeDir), 'precondition: shared escape target must not exist yet');
    // Pre-seed the attacker-controlled source: without the fix,
    // mergeConfig would READ this file and MERGE it into the escaped output.
    fs.mkdirSync(escapeDir, { recursive: true });
    fs.writeFileSync(path.join(escapeDir, 'config.custom.yaml'), `model: "pwned"\n`);

    assert.throws(
      () => mergeConfig({ rootDir: tmpDir, profiles: ['../../pwned'], logger: () => {} }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /Invalid profile name: "\.\.\/\.\.\/pwned"/);
        return true;
      }
    );
    // The escaped output file must NOT have been written...
    assert.ok(
      !fs.existsSync(path.join(escapeDir, 'config.yaml')),
      `no file may be written outside the workspace (found: ${escapeDir}/config.yaml)`
    );
    // ...and the workspace itself was not touched either (no profiles/ tree).
    assert.ok(!fs.existsSync(path.join(tmpDir, 'profiles')), 'workspace must not have been modified');
    // The pre-seeded source is untouched (not consumed by the rejected merge).
    assert.ok(fs.existsSync(path.join(escapeDir, 'config.custom.yaml')), 'pre-seeded source untouched');
  });

  it('rejects other traversal-shaped profile names (.., ./x, a/b) with the same clean error', () => {
    for (const name of ['..', './x', 'a/b']) {
      assert.throws(
        () => mergeConfig({ rootDir: tmpDir, profiles: [name], logger: () => {} }),
        /Invalid profile name/,
        `expected "${name}" to be rejected`
      );
    }
    assert.ok(!fs.existsSync(pwnedDir()), 'nothing may have been written outside the workspace');
    assert.ok(!fs.existsSync(path.join(tmpDir, 'profiles')), 'workspace must not have been modified');
  });

  it('returns a per-profile error entry (no top-level throw) when a DISCOVERED profile has an invalid config.custom.yaml', () => {
    // REGRESSION (divergence from mergeJobs/mergeSoul): the trailing
    // "nothing to merge" gate used to count only `status: 'merged'` entries,
    // so a DISCOVERED profile (no `profiles` option) whose
    // config.custom.yaml EXISTS but is INVALID (exists-but-invalid) made
    // mergeConfig throw the generic top-level
    // "No profiles with valid config.custom.yaml could be merged" error and
    // mask the specific per-profile diagnostic. mergeJobs/mergeSoul gate on
    // SOURCE EXISTENCE (foundAnyCustom), so the same failure shape returns a
    // per-profile `status: 'error'` entry instead. mergeConfig must now
    // return that per-profile error entry (the real failure carrier) rather
    // than throw, so the CLI/collectMergeErrors path can report the specific
    // diagnostic and exit 1 — identical to the jobs/soul behavior.
    const commonDir = path.join(tmpDir, 'profiles', 'common');
    fs.mkdirSync(commonDir, { recursive: true });
    fs.writeFileSync(path.join(commonDir, 'config.yaml'), `model: "base"\n`);
    // The ONLY profile, discovered (no `profiles` option), with an INVALID
    // custom source: a bare scalar is a valid YAML document but not an
    // object.
    const badDir = path.join(tmpDir, 'profiles', 'bad');
    fs.mkdirSync(badDir, { recursive: true });
    fs.writeFileSync(path.join(badDir, 'config.custom.yaml'), `just-a-scalar\n`);

    // Must NOT throw the generic top-level "nothing to merge" error...
    let results!: ReturnType<typeof mergeConfig>;
    assert.doesNotThrow(
      () => {
        results = mergeConfig({ rootDir: tmpDir, logger: () => {} });
      },
      /No profiles with valid config\.custom\.yaml/,
      'an exists-but-invalid custom source must not trigger the generic top-level throw'
    );
    // ...it must return the specific per-profile error entry instead.
    assert.equal(results.length, 1);
    assert.equal(results[0].profile, 'bad');
    assert.equal(results[0].status, 'error');
    assert.match(results[0].error ?? '', /not a valid YAML object/);
    // Nothing was written for the failing profile.
    assert.ok(!fs.existsSync(path.join(badDir, 'config.yaml')));
  });

  it('allowEmpty returns the per-profile error entry (no throw) for a discovered invalid source', () => {
    // The aggregate sync path relies on `allowEmpty` to turn "nothing to
    // merge" into a clean return; with the source-existence gate the
    // exists-but-invalid case now flows through the same path — the
    // per-profile `status: 'error'` entry is returned (not swallowed, not
    // thrown) so the aggregate path can surface it.
    const commonDir = path.join(tmpDir, 'profiles', 'common');
    fs.mkdirSync(commonDir, { recursive: true });
    fs.writeFileSync(path.join(commonDir, 'config.yaml'), `model: "base"\n`);
    const badDir = path.join(tmpDir, 'profiles', 'bad');
    fs.mkdirSync(badDir, { recursive: true });
    fs.writeFileSync(path.join(badDir, 'config.custom.yaml'), `just-a-scalar\n`);

    const results = mergeConfig({ rootDir: tmpDir, allowEmpty: true, logger: () => {} });
    assert.equal(results.length, 1);
    assert.equal(results[0].status, 'error');
    assert.match(results[0].error ?? '', /not a valid YAML object/);
  });

  it('records a ONE-LINE, path-including error entry when a custom config FAILS TO PARSE', () => {
    // REGRESSION (raw YAML parse error leak): a malformed
    // config.custom.yaml used to surface the raw multi-line YAMLParseError
    // (source snippet + caret, NO file name) as the per-profile `error`.
    // The entry must now be a single line that names the file.
    const commonDir = path.join(tmpDir, 'profiles', 'common');
    fs.mkdirSync(commonDir, { recursive: true });
    fs.writeFileSync(path.join(commonDir, 'config.yaml'), `model: "base"\n`);
    const badDir = path.join(tmpDir, 'profiles', 'bad');
    fs.mkdirSync(badDir, { recursive: true });
    const customPath = path.join(badDir, 'config.custom.yaml');
    fs.writeFileSync(customPath, `model: [unclosed\n`);

    const results = mergeConfig({ rootDir: tmpDir, logger: () => {} });
    assert.equal(results.length, 1);
    assert.equal(results[0].profile, 'bad');
    assert.equal(results[0].status, 'error');
    const err = results[0].error ?? '';
    assert.match(err, /Custom config is not valid YAML/);
    // The error must name the offending file ...
    assert.ok(err.includes(customPath), `error must include the absolute path:\n${err}`);
    // ... be a SINGLE line (the raw parse error spans 5+ lines) ...
    assert.ok(!err.includes('\n'), `error must be one line:\n${err}`);
    // ... and must not leak the raw source snippet or the caret line.
    assert.ok(!err.includes('model: [unclosed'), `no raw source snippet:\n${err}`);
    assert.ok(!/^\^$/m.test(err), `no raw caret line:\n${err}`);
    assert.ok(!fs.existsSync(path.join(badDir, 'config.yaml')), 'nothing written for the failing profile');
  });

  it('throws a ONE-LINE, path-including error when the COMMON config fails to parse', () => {
    // REGRESSION (top-level parse leak): malformed profiles/common/config.yaml
    // used to propagate the raw multi-line YAMLParseError with no file name.
    // mergeConfig must now throw a single-line error naming the file.
    const commonDir = path.join(tmpDir, 'profiles', 'common');
    fs.mkdirSync(commonDir, { recursive: true });
    const commonPath = path.join(commonDir, 'config.yaml');
    fs.writeFileSync(commonPath, `model: [unclosed\n`);

    assert.throws(
      () => mergeConfig({ rootDir: tmpDir, logger: () => {} }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /Common config is not valid YAML/);
        assert.ok(err.message.includes(commonPath), `must name the common config path:\n${err.message}`);
        assert.ok(!err.message.includes('\n'), `must be one line:\n${err.message}`);
        assert.ok(!err.message.includes('model: [unclosed'), `no raw source snippet:\n${err.message}`);
        assert.ok(!/^\^$/m.test(err.message), `no raw caret line:\n${err.message}`);
        return true;
      }
    );
  });
});
