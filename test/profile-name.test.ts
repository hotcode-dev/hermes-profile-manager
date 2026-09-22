import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { validateProfileName, assertProfilePathInWorkspace } from '../src/utils/profile-name.js';

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
});
