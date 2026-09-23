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
 */

/**
 * Validates a user-supplied profile name BEFORE it is used in any path
 * construction. Throws `Invalid profile name: "<name>" — must be a single
 * path-safe segment (letters, digits, dots, hyphens, underscores)` for an
 * invalid name; valid names are returned unchanged.
 */
export function validateProfileName(name: string): string {
  if (!name || name === '.' || name === '..' || !/^[a-zA-Z0-9._-]+$/.test(name)) {
    throw new Error(
      `Invalid profile name: "${name}" — must be a single path-safe segment ` +
      `(letters, digits, dots, hyphens, underscores)`
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
}
