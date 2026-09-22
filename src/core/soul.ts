import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFileSync, getProfileNames } from '../utils/fs-helpers.js';
import { validateProfileName, assertProfilePathInWorkspace } from '../utils/profile-name.js';

export interface MergeSoulOptions {
  rootDir?: string;
  profiles?: string[];
  logger?: (msg: string) => void;
  dryRun?: boolean;
  /**
   * When true, a run with nothing to merge is a successful no-op (returns
   * the per-profile skipped entries, or `[]` for an empty target list)
   * instead of throwing. Used by the aggregate sync path; standalone CLI
   * calls keep the default (false) and still surface the "nothing to merge"
   * error.
   *
   * Two "no targets" situations, both governed by this flag:
   * - An EMPTY target list (no profile subdirs found, or an explicit
   *   `profiles: []` on a profile-less workspace) throws
   *   `No profiles found under <dir>` unless `allowEmpty` — identical to
   *   mergeConfig/mergeJobs. An empty list names no profile, so it is NOT
   *   exempted.
   * - A NON-EMPTY explicit `profiles` list is exempted from the
   *   "nothing to merge" throw: an explicitly targeted profile that simply
   *   has no SOUL.custom.md source is a per-profile `skipped` no-op (exit
   *   0), not a top-level failure.
   */
  allowEmpty?: boolean;
}

export interface MergeSoulResult {
  profile: string;
  outputPath: string;
  status: 'merged' | 'skipped' | 'error';
  error?: string;
}

/**
 * Merges profile custom SOUL (profiles/<profile>/SOUL.custom.md)
 * with common SOUL (profiles/common/SOUL.md)
 * into profiles/<profile>/SOUL.md.
 * Order: Profile custom SOUL comes first; common SOUL is appended last.
 */
export function mergeSoul(options: MergeSoulOptions = {}): MergeSoulResult[] {
  const rootDir = options.rootDir || process.cwd();
  const log = options.logger || console.log;

  // User-controlled profile names (global -p/--profiles option) are a
  // path-traversal vector: path.join(profilesDir, '../../x') resolves
  // OUTSIDE the workspace. Validate every explicitly targeted name BEFORE
  // any filesystem access or write, mirroring initWorkspace's "validated
  // before path construction" contract. (Discovered names come from
  // readdirSync, not user input.)
  for (const profile of options.profiles ?? []) {
    validateProfileName(profile);
  }

  const commonSoulPath = path.join(rootDir, 'profiles', 'common', 'SOUL.md');

  if (!fs.existsSync(commonSoulPath)) {
    throw new Error(`Common SOUL file not found: ${commonSoulPath}`);
  }

  const commonSoulContent = fs.readFileSync(commonSoulPath, 'utf8').trim();
  const profilesDir = path.join(rootDir, 'profiles');
  const availableProfiles = getProfileNames(profilesDir);
  const targetProfiles = options.profiles && options.profiles.length > 0
    ? options.profiles
    : availableProfiles;

  // No-targets guard, shared with mergeConfig/mergeJobs: an empty target
  // list (no profile subdirs, or an explicit `profiles: []` on a profile-less
  // workspace) is a hard "no profiles found" failure unless `allowEmpty`. An
  // empty list names no profile, so it is NOT exempted the way a non-empty
  // explicit list is.
  if (targetProfiles.length === 0 && !options.allowEmpty) {
    throw new Error(`No profiles found under ${profilesDir}`);
  }

  const results: MergeSoulResult[] = [];
  let foundAnyCustom = false;

  for (const profile of targetProfiles) {
    const profileDir = path.join(profilesDir, profile);
    // Defense in depth: the profile dir must stay strictly under
    // profilesDir (closes traversal even for non-explicit names).
    assertProfilePathInWorkspace(profilesDir, profileDir);
    const customSoulPath = path.join(profileDir, 'SOUL.custom.md');
    const outputSoulPath = path.join(profileDir, 'SOUL.md');

    if (!fs.existsSync(customSoulPath)) {
      // Record a per-profile skipped entry instead of silently skipping,
      // mirroring mergeConfig: an explicitly targeted profile (or any
      // profile in the allowEmpty aggregate path) whose custom source is
      // missing is a visible no-op, not an invisible one. `foundAnyCustom`
      // stays driven only by real custom sources below.
      results.push({
        profile,
        outputPath: outputSoulPath,
        status: 'skipped',
        error: `Profile SOUL.custom.md not found: ${customSoulPath}`
      });
      continue;
    }

    foundAnyCustom = true;

    try {
      const customSoulContent = fs.readFileSync(customSoulPath, 'utf8').trim();
      const combined = `${customSoulContent}\n\n${commonSoulContent}\n`;

      if (!options.dryRun) {
        atomicWriteFileSync(outputSoulPath, combined);
      }

      // Under --dry-run the file was not written, so phrase the line as a
      // preview rather than asserting a side effect that did not happen.
      log(
        options.dryRun
          ? `Would merge SOUL to: ${outputSoulPath}`
          : `Merged SOUL written to: ${outputSoulPath}`
      );
      results.push({
        profile,
        outputPath: outputSoulPath,
        status: 'merged'
      });
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      log(`Error merging SOUL for ${profile}: ${errorMsg}`);
      results.push({
        profile,
        outputPath: outputSoulPath,
        status: 'error',
        error: errorMsg
      });
    }
  }

  // Reached only with a non-empty target list (an empty one is caught by the
  // `No profiles found under` guard above). Throw the aggregate "nothing to
  // merge" error only when no profiles were EXPLICITLY targeted. With a
  // non-empty explicit `profiles` list each named profile already got a
  // per-profile `skipped` entry above, so a top-level "no profiles with
  // SOUL.custom.md found" failure would be wrong and misleading — exactly
  // mergeConfig's `!options.profiles` gate.
  if (!foundAnyCustom && !options.profiles) {
    if (options.allowEmpty) {
      return results;
    }
    throw new Error(`Error: no profiles with SOUL.custom.md found under ${profilesDir}`);
  }

  return results;
}
