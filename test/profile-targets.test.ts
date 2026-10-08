import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  validateExplicitProfiles,
  resolveTargetProfiles,
  assertNonEmptyTargetProfiles,
  runPerProfileMerge,
  type FoundAnyCustom
} from '../src/utils/profile-targets.js';

describe('validateExplicitProfiles', () => {
  it('is a validated no-op for undefined input', () => {
    assert.doesNotThrow(() => validateExplicitProfiles(undefined));
  });

  it('is a validated no-op for an empty list', () => {
    assert.doesNotThrow(() => validateExplicitProfiles([]));
  });

  it('passes a list of valid names', () => {
    assert.doesNotThrow(() => validateExplicitProfiles(['main', 'worker.2', 'agent-profile_01']));
  });

  it('throws for a list containing a path-traversal name', () => {
    for (const bad of ['../x', 'a/b', 'a\\b', '..', '../../pwned']) {
      assert.throws(
        () => validateExplicitProfiles([bad]),
        /Invalid profile name/,
        `expected ["${bad}"] to throw`
      );
    }
  });

  it('throws for a list containing an empty string', () => {
    assert.throws(() => validateExplicitProfiles(['main', '']), /Invalid profile name/);
  });

  it('throws for the reserved "common" name and names the offending value', () => {
    assert.throws(
      () => validateExplicitProfiles(['common']),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /Invalid profile name: "common"/);
        assert.match(err.message, /reserved for the shared common profile directory/);
        return true;
      }
    );
  });

  it('validates EVERY explicit name, not just the first', () => {
    // A valid name followed by a bad one must still throw: the guard must
    // not stop at the first valid entry.
    assert.throws(() => validateExplicitProfiles(['main', 'a/b']), /Invalid profile name/);
  });
});

describe('resolveTargetProfiles', () => {
  let tmpDir: string;
  let profilesDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-test-pt-'));
    profilesDir = path.join(tmpDir, 'profiles');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const mkProfiles = (...names: string[]) => {
    for (const name of names) {
      fs.mkdirSync(path.join(profilesDir, name), { recursive: true });
    }
  };

  it('returns a non-empty explicit list verbatim, independent of discovered names', () => {
    mkProfiles('alpha', 'beta');
    const explicit = ['gamma', 'delta'];
    const targets = resolveTargetProfiles(explicit, profilesDir);
    assert.deepEqual(targets, ['gamma', 'delta']);
    // The returned list is a copy: mutating the caller's array must not
    // mutate the result (callers rely on a stable snapshot).
    explicit.push('epsilon');
    assert.deepEqual(targets, ['gamma', 'delta']);
  });

  it('falls back to discovered names when the explicit list is empty', () => {
    mkProfiles('alpha', 'beta');
    assert.deepEqual(resolveTargetProfiles([], profilesDir), ['alpha', 'beta']);
  });

  it('falls back to discovered names when explicit is undefined', () => {
    mkProfiles('alpha', 'beta');
    assert.deepEqual(resolveTargetProfiles(undefined, profilesDir), ['alpha', 'beta']);
  });

  it('yields an empty list on a profile-less dir for both undefined and empty explicit', () => {
    fs.mkdirSync(profilesDir, { recursive: true });
    assert.deepEqual(resolveTargetProfiles(undefined, profilesDir), []);
    assert.deepEqual(resolveTargetProfiles([], profilesDir), []);
  });

  it('yields an empty list when profilesDir does not exist and no explicit names are given', () => {
    assert.deepEqual(resolveTargetProfiles(undefined, path.join(tmpDir, 'nope')), []);
  });
});

describe('assertNonEmptyTargetProfiles', () => {
  const profilesDir = '/ws/profiles';

  it('throws "No profiles found under <dir>" for an empty list without allowEmpty', () => {
    for (const allowEmpty of [undefined, false] as const) {
      assert.throws(
        () => assertNonEmptyTargetProfiles([], profilesDir, allowEmpty),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.equal(err.message, `No profiles found under ${profilesDir}`);
          return true;
        },
        `expected empty list with allowEmpty=${String(allowEmpty)} to throw`
      );
    }
  });

  it('does not throw for an empty list when allowEmpty is set', () => {
    assert.doesNotThrow(() => assertNonEmptyTargetProfiles([], profilesDir, true));
  });

  it('never throws for a non-empty list, regardless of allowEmpty', () => {
    assert.doesNotThrow(() => assertNonEmptyTargetProfiles(['main'], profilesDir, undefined));
    assert.doesNotThrow(() => assertNonEmptyTargetProfiles(['main'], profilesDir, true));
  });
});

describe('runPerProfileMerge', () => {
  let tmpDir: string;
  let profilesDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-test-pt-'));
    profilesDir = path.join(tmpDir, 'profiles');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const customSourcePath = (profile: string) => path.join(profilesDir, profile, 'config.yaml');

  /**
   * Fake merge body mirroring the real modules' per-profile unit: when a
   * custom source exists it flips foundAnyCustom and returns a `merged`
   * entry; when it is absent it returns a `skipped` entry WITHOUT flipping
   * the flag.
   */
  const fakeBody = (profile: string, _profilesDir: string, found: FoundAnyCustom) => {
    if (fs.existsSync(customSourcePath(profile))) {
      found.foundAnyCustom = true;
      return { profile, status: 'merged' as const };
    }
    return { profile, status: 'skipped' as const };
  };

  const msg = (dir: string) => `No custom config found under ${dir}`;

  it('throws the "nothing to merge" error when no custom source exists and nothing is explicit', () => {
    fs.mkdirSync(path.join(profilesDir, 'main'), { recursive: true }); // profile dir, no source
    fs.mkdirSync(path.join(profilesDir, 'worker'), { recursive: true });

    assert.throws(
      () => runPerProfileMerge(['main', 'worker'], profilesDir, undefined, undefined, msg, fakeBody),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal(err.message, msg(profilesDir));
        return true;
      }
    );
  });

  it('does not throw when a custom source exists (even if only one profile has one)', () => {
    fs.mkdirSync(path.join(profilesDir, 'main'), { recursive: true });
    fs.writeFileSync(customSourcePath('main'), 'model: "base"\n');
    fs.mkdirSync(path.join(profilesDir, 'worker'), { recursive: true });

    const results = runPerProfileMerge(['main', 'worker'], profilesDir, undefined, undefined, msg, fakeBody);
    assert.deepEqual(results, [
      { profile: 'main', status: 'merged' },
      { profile: 'worker', status: 'skipped' }
    ]);
  });

  it('exempts the throw when a non-empty explicit list was supplied (each named profile gets an entry)', () => {
    fs.mkdirSync(path.join(profilesDir, 'main'), { recursive: true });
    fs.mkdirSync(path.join(profilesDir, 'worker'), { recursive: true });

    // No custom source anywhere: with no explicit targeting this would
    // throw, but an explicit -p list names what to target, so the runner
    // must return the per-profile entries instead.
    const results = runPerProfileMerge(
      ['main', 'worker'],
      profilesDir,
      ['main', 'worker'],
      undefined,
      msg,
      fakeBody
    );
    assert.deepEqual(results, [
      { profile: 'main', status: 'skipped' },
      { profile: 'worker', status: 'skipped' }
    ]);
  });

  it('turns the would-be throw into a successful return of the collected results when allowEmpty is set', () => {
    fs.mkdirSync(path.join(profilesDir, 'main'), { recursive: true });
    fs.mkdirSync(path.join(profilesDir, 'worker'), { recursive: true });

    const results = runPerProfileMerge(['main', 'worker'], profilesDir, undefined, true, msg, fakeBody);
    assert.deepEqual(results, [
      { profile: 'main', status: 'skipped' },
      { profile: 'worker', status: 'skipped' }
    ]);
  });

  it('collects only defined body returns (undefined is skipped)', () => {
    fs.mkdirSync(path.join(profilesDir, 'main'), { recursive: true });
    fs.writeFileSync(customSourcePath('main'), 'model: "base"\n');
    fs.mkdirSync(path.join(profilesDir, 'worker'), { recursive: true });

    // main's unit records an entry; worker's unit returns undefined.
    const body = (profile: string, _profilesDir: string, found: FoundAnyCustom) => {
      if (profile === 'main') {
        found.foundAnyCustom = true;
        return { profile, status: 'merged' as const };
      }
      return undefined;
    };

    const results = runPerProfileMerge(['main', 'worker'], profilesDir, undefined, undefined, msg, body);
    assert.deepEqual(results, [{ profile: 'main', status: 'merged' }]);
  });

  it('passes each target profile name and the shared found flag to the body, in target order', () => {
    fs.mkdirSync(path.join(profilesDir, 'main'), { recursive: true });
    fs.mkdirSync(path.join(profilesDir, 'worker'), { recursive: true });

    const seen: Array<{ profile: string; profilesDir: string; found: FoundAnyCustom }> = [];
    let sharedFlag: FoundAnyCustom | undefined;
    const body = (profile: string, dir: string, found: FoundAnyCustom) => {
      seen.push({ profile, profilesDir: dir, found });
      if (!sharedFlag) {
        sharedFlag = found;
      }
      found.foundAnyCustom = true;
    };

    runPerProfileMerge(['main', 'worker'], profilesDir, undefined, undefined, msg, body);
    assert.deepEqual(
      seen.map((s) => s.profile),
      ['main', 'worker']
    );
    assert.ok(seen.every((s) => s.profilesDir === profilesDir));
    // All calls share the same mutable flag object.
    assert.ok(seen.every((s) => s.found === sharedFlag));
    assert.equal(sharedFlag?.foundAnyCustom, true);
  });
});
