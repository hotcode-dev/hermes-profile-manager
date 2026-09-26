import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { validateProfileName, assertProfilePathInWorkspace, assertPathInBase } from '../src/utils/profile-name.js';

describe('validateProfileName', () => {
  it('accepts valid single-segment profile names', () => {
    for (const name of ['main', 'a.b-c_1', 'A123', 'x', 'worker.2', 'agent-profile_01']) {
      assert.equal(validateProfileName(name), name, `expected "${name}" to be valid`);
    }
  });

  it('rejects empty and dot-only names', () => {
    for (const name of ['', '.', '..']) {
      assert.throws(() => validateProfileName(name), /Invalid profile name/, `expected "${name}" to throw`);
    }
  });

  it('rejects names with path separators or other punctuation', () => {
    for (const name of ['a/b', 'a\\b', 'a b', '../../pwned', 'a!b', 'a?b', '..', 'a/b/c']) {
      assert.throws(
        () => validateProfileName(name),
        /Invalid profile name/,
        `expected "${name}" to throw`
      );
    }
  });

  it('rejects non-ASCII names', () => {
    assert.throws(() => validateProfileName('üñïcode'), /Invalid profile name/);
    assert.throws(() => validateProfileName('日本語'), /Invalid profile name/);
  });

  it('names the offending value in the error message', () => {
    assert.throws(
      () => validateProfileName('../../pwned'),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /Invalid profile name: "\.\.\/\.\.\/pwned"/);
        assert.match(err.message, /must be a single path-safe segment/);
        return true;
      }
    );
  });

  it('rejects the reserved name "common" (the shared common profile dir)', () => {
    // RESERVED-NAME REGRESSION: profiles/common/ is the SHARED common profile
    // directory (base source for every merge/link step), not a per-profile
    // dir. "common" must be rejected so init/merge/link never treat the
    // shared base as a regular profile (self-merge, self-symlink).
    assert.throws(
      () => validateProfileName('common'),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /Invalid profile name: "common"/);
        assert.match(err.message, /reserved for the shared common profile directory/);
        return true;
      }
    );
  });

  it('still accepts names that merely contain "common" as a segment (exact-match reservation)', () => {
    for (const name of ['common-worker', 'my.common', 'common_1', 'COM', 'Common']) {
      assert.equal(validateProfileName(name), name, `expected "${name}" to be valid`);
    }
  });
});

describe('assertProfilePathInWorkspace', () => {
  const profilesDir = '/ws/profiles';

  it('accepts paths strictly under the profiles dir', () => {
    assert.doesNotThrow(() => assertProfilePathInWorkspace(profilesDir, '/ws/profiles/main'));
    assert.doesNotThrow(() => assertProfilePathInWorkspace(profilesDir, '/ws/profiles/main/cron/jobs.json'));
    assert.doesNotThrow(() => assertProfilePathInWorkspace(profilesDir, path.join('/ws', 'profiles', 'main', 'skills')));
  });

  it('rejects the profiles dir itself and any path outside it', () => {
    assert.throws(() => assertProfilePathInWorkspace(profilesDir, '/ws/profiles'), /escapes the workspace boundary/);
    assert.throws(() => assertProfilePathInWorkspace(profilesDir, '/ws/profiles2'), /escapes the workspace boundary/);
    assert.throws(() => assertProfilePathInWorkspace(profilesDir, '/pwned/config.yaml'), /escapes the workspace boundary/);
    assert.throws(() => assertProfilePathInWorkspace(profilesDir, '/ws/profiles/../pwned'), /escapes the workspace boundary/);
  });

  it('rejects paths targeting the reserved shared common dir (defense in depth)', () => {
    assert.throws(
      () => assertProfilePathInWorkspace(profilesDir, '/ws/profiles/common'),
      /reserved shared "common" directory/
    );
    assert.throws(
      () => assertProfilePathInWorkspace(profilesDir, '/ws/profiles/common/SOUL.md'),
      /reserved shared "common" directory/
    );
    // Legitimate per-profile paths under other names still pass.
    assert.doesNotThrow(() => assertProfilePathInWorkspace(profilesDir, '/ws/profiles/common-worker/SOUL.md'));
  });
});

describe('assertPathInBase', () => {
  const base = '/home/u/.hermes';

  it('accepts paths strictly under the base dir', () => {
    assert.doesNotThrow(() => assertPathInBase(base, '/home/u/.hermes/plugins'));
    assert.doesNotThrow(() => assertPathInBase(base, path.join(base, 'profiles', 'main')));
    // The candidate is built from the base at call sites; the guard must
    // hold even when the base itself is a relative path.
    assert.doesNotThrow(() => assertPathInBase('.hermes', path.join('.hermes', 'plugins')));
  });

  it('rejects the base dir itself and any path outside it', () => {
    assert.throws(() => assertPathInBase(base, '/home/u/.hermes'), /escapes the boundary/);
    assert.throws(() => assertPathInBase(base, '/home/u/.hermes2/plugins'), /escapes the boundary/);
    assert.throws(() => assertPathInBase(base, '/pwned/plugins'), /escapes the boundary/);
    assert.throws(() => assertPathInBase(base, '/home/u/.hermes/../pwned/plugins'), /escapes the boundary/);
  });

  it('rejects relative candidates that resolve outside the base', () => {
    // A relative base resolves against the process cwd; a relative
    // candidate that escapes it must be rejected, not accepted.
    assert.throws(
      () => assertPathInBase('/tmp/somebase', path.join('/tmp/somebase', '..', 'pwned')),
      /escapes the boundary/
    );
  });
});
