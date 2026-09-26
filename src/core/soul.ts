import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFileSync } from '../utils/fs-helpers.js';
import { assertProfilePathInWorkspace } from '../utils/profile-name.js';
import {
  validateExplicitProfiles,
  resolveTargetProfiles,
  assertNonEmptyTargetProfiles,
  runPerProfileMerge
} from '../utils/profile-targets.js';

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

  // Explicit profile names (global -p/--profiles option) are a
  // path-traversal vector; validated BEFORE any filesystem access or write
  // (see validateExplicitProfiles). Discovered names come from readdirSync.
  validateExplicitProfiles(options.profiles);

  const commonSoulPath = path.join(rootDir, 'profiles', 'common', 'SOUL.md');

  if (!fs.existsSync(commonSoulPath)) {
    throw new Error(`Common SOUL file not found: ${commonSoulPath}`);
  }

  const commonSoulContent = fs.readFileSync(commonSoulPath, 'utf8').trim();
  const profilesDir = path.join(rootDir, 'profiles');
  const targetProfiles = resolveTargetProfiles(options.profiles, profilesDir);

  assertNonEmptyTargetProfiles(targetProfiles, profilesDir, options.allowEmpty);

  return runPerProfileMerge(
    targetProfiles,
    profilesDir,
    options.profiles,
    options.allowEmpty,
    (dir) => `Error: no profiles with SOUL.custom.md found under ${dir}`,
    (profile, dir, found): MergeSoulResult => {
      const profileDir = path.join(dir, profile);
      // Defense in depth: the profile dir must stay strictly under
      // profilesDir (closes traversal even for non-explicit names).
      assertProfilePathInWorkspace(dir, profileDir);
      const customSoulPath = path.join(profileDir, 'SOUL.custom.md');
      const outputSoulPath = path.join(profileDir, 'SOUL.md');

      if (!fs.existsSync(customSoulPath)) {
        // Record a per-profile skipped entry instead of silently skipping:
        // an explicitly targeted profile (or any profile in the allowEmpty
        // aggregate path) whose custom source is missing is a visible no-op,
        // not an invisible one. `foundAnyCustom` stays driven only by real
        // custom sources below (see FoundAnyCustom).
        return {
          profile,
          outputPath: outputSoulPath,
          status: 'skipped',
          error: `Profile SOUL.custom.md not found: ${customSoulPath}`
        };
      }

      // The custom source EXISTS: flip the flag (even if the merge below
      // then fails — its failure rides on the per-profile `error` entry).
      found.foundAnyCustom = true;

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
        return {
          profile,
          outputPath: outputSoulPath,
          status: 'merged'
        };
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        log(`Error merging SOUL for ${profile}: ${errorMsg}`);
        return {
          profile,
          outputPath: outputSoulPath,
          status: 'error',
          error: errorMsg
        };
      }
    }
  );
}
