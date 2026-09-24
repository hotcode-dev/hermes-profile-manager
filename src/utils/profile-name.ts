import path from 'node:path';

/**
 * Shared profile-name validation.
 *
 * Profile names flow from user-controlled input (the CLI's global
 * `-p, --profiles <profiles...>` option or the `init` command's
 * `--profile` option) directly into `path.join(profilesDir, name, ...)`.
 * A name containing a path separator (`/`, `\`) or a `.`/`..` segment
 * would make path.join resolve the profile directory OUTSIDE the
 * workspace, letting the init/merge/link steps write files or symlinks
 * at an attacker-chosen location (path traversal).
 *
 * The allowlist `^[a-zA-Z0-9._-]+$` plus an explicit `.`/`..` guard
 * rejects every known traversal vector and guarantees the name is a
 * single, path-safe directory segment.
 *
 * The name `common` is additionally reserved: `profiles/common/` is the
 * SHARED common profile directory (the BASE source every merge/link step
 * reads and every profile links into), not a per-profile directory.
 * Accepting it as a profile name would make a step treat the shared base
 * as a regular profile — self-merging common sources onto themselves
 * (non-convergent) and self-symlinking shared skills/plugins.
 * `getProfileNames` (src/utils/fs-helpers.ts) deliberately excludes
 * `common` from the discovered profile list; this validator applies the
 * same rule to explicitly targeted names.
 */

/**
 * Validates a user-supplied profile name BEFORE it is used in any path
 * construction. Throws `Invalid profile name: "<name>" — must be a single
 * path-safe segment (letters, digits, dots, hyphens, underscores)` for an
 * invalid name; valid names are returned unchanged. The reserved name
 * `common` is rejected with a dedicated message.
 */
export function validateProfileName(name: string): string {
  if (!name || name === '.' || name === '..' || !/^[a-zA-Z0-9._-]+$/.test(name)) {
    throw new Error(
      `Invalid profile name: "${name}" — must be a single path-safe segment ` +
      `(letters, digits, dots, hyphens, underscores)`
    );
  }
  if (name === 'common') {
    throw new Error(
      `Invalid profile name: "common" — "common" is reserved for the shared common profile directory`
    );
  }
  return name;
}

/**
 * Defense in depth: assert that a constructed profile path stays strictly
 * under the profiles/ directory. The allowlist in
 * {@link validateProfileName} already guarantees this, but this catches
 * any future path-construction change that might bypass it (e.g. a raw
 * path passed in instead of a bare name).
 */
export function assertProfilePathInWorkspace(profilesDir: string, candidatePath: string): void {
  const resolvedProfilesDir = path.resolve(profilesDir);
  const resolvedCandidate = path.resolve(candidatePath);
  if (!resolvedCandidate.startsWith(resolvedProfilesDir + path.sep)) {
    throw new Error(
      `Profile path "${resolvedCandidate}" escapes the workspace boundary "${resolvedProfilesDir}"`
    );
  }
  // Defense in depth: per-profile paths must not target the shared common
  // directory (profiles/common). The reserved-name check in
  // validateProfileName already guarantees this for bare names, but this
  // catches any future path-construction change that passes a raw path.
  const firstSegment = path.relative(resolvedProfilesDir, resolvedCandidate).split(path.sep)[0];
  if (firstSegment === 'common') {
    throw new Error(
      `Profile path "${resolvedCandidate}" targets the reserved shared "common" directory`
    );
  }
}
