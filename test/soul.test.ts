import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { mergeSoul } from '../src/core/soul.js';

describe('mergeSoul', () => {
  let tmpDir: string;
  // Shared escape target the path-traversal regression tests assert on:
  // path.dirname(tmpDir) is the OS temp dir, so <tmpdir>/pwned is SHARED
  // across runs. A stale artifact there would make the "wrote nothing
  // outside the workspace" assertion fail forever.
  const pwnedDir = () => path.join(path.dirname(tmpDir), 'pwned');

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-test-soul-'));
    // Hermetic precondition: no stale escape artifact from an earlier run.
    fs.rmSync(pwnedDir(), { recursive: true, force: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    // Clean the shared escape target (see pwnedDir above).
    fs.rmSync(pwnedDir(), { recursive: true, force: true });
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

  it('dry run writes no file and reports a preview, not a completed write', () => {
    const commonDir = path.join(tmpDir, 'profiles', 'common');
    fs.mkdirSync(commonDir, { recursive: true });
    fs.writeFileSync(path.join(commonDir, 'SOUL.md'), '# Common Base');

    const workerDir = path.join(tmpDir, 'profiles', 'worker');
    fs.mkdirSync(workerDir, { recursive: true });
    fs.writeFileSync(path.join(workerDir, 'SOUL.custom.md'), '# Worker Personality');

    const lines: string[] = [];
    const results = mergeSoul({ rootDir: tmpDir, dryRun: true, logger: (m) => lines.push(m) });
    assert.equal(results.length, 1);
    assert.equal(results[0].status, 'merged');

    // No output file was written.
    assert.ok(!fs.existsSync(path.join(workerDir, 'SOUL.md')), 'dry-run must not write SOUL.md');
    // The log line must not claim the file was written.
    assert.ok(!lines.some((l) => l.includes('written to')), `no "written to" claim in:\n${lines.join('\n')}`);
    // And it phrases the write as a preview.
    assert.ok(lines.some((l) => l.includes('Would merge SOUL to:')), `preview wording missing in:\n${lines.join('\n')}`);
  });

  it('rejects a path-traversal profile name BEFORE any filesystem side effect', () => {
    // SECURITY REGRESSION (path traversal via user-controlled -p/--profiles):
    // path.join(profilesDir, '../../pwned', 'SOUL.md') resolves OUTSIDE the
    // workspace (to <tmpdir>/pwned/SOUL.md). The name must be rejected
    // before any read/write, so no escaped file is created.
    const escapeDir = pwnedDir();
    assert.ok(!fs.existsSync(escapeDir), 'precondition: shared escape target must not exist yet');
    // Pre-seed the attacker-controlled source so a pre-fix run would have
    // READ this and concatenated it into the escaped SOUL.md.
    fs.mkdirSync(escapeDir, { recursive: true });
    fs.writeFileSync(path.join(escapeDir, 'SOUL.custom.md'), '# Pwned Soul\n');

    assert.throws(
      () => mergeSoul({ rootDir: tmpDir, profiles: ['../../pwned'], logger: () => {} }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /Invalid profile name: "\.\.\/\.\.\/pwned"/);
        return true;
      }
    );
    // No escaped output was written...
    assert.ok(
      !fs.existsSync(path.join(escapeDir, 'SOUL.md')),
      `no file may be written outside the workspace (found: ${escapeDir}/SOUL.md)`
    );
    // ...and the workspace was not modified either.
    assert.ok(!fs.existsSync(path.join(tmpDir, 'profiles')), 'workspace must not have been modified');
  });

  it('rejects other traversal-shaped profile names (.., ./x, a/b) with the same clean error', () => {
    for (const name of ['..', './x', 'a/b']) {
      assert.throws(
        () => mergeSoul({ rootDir: tmpDir, profiles: [name], logger: () => {} }),
        /Invalid profile name/,
        `expected "${name}" to be rejected`
      );
    }
    assert.ok(!fs.existsSync(pwnedDir()), 'nothing may have been written outside the workspace');
    assert.ok(!fs.existsSync(path.join(tmpDir, 'profiles')), 'workspace must not have been modified');
  });
});
