import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFileSync, getProfileNames } from '../utils/fs-helpers.js';

export interface MergeSoulOptions {
  rootDir?: string;
  profiles?: string[];
  logger?: (msg: string) => void;
  dryRun?: boolean;
  /**
   * When true, a run where no profile has a SOUL.custom.md source is treated
   * as a successful no-op (returns the per-profile skipped entries) instead
   * of throwing. Used by the aggregate sync path; standalone CLI calls keep
   * the default (false) and still surface the "nothing to merge" error.
   *
   * The throw is additionally exempted when `profiles` is EXPLICITLY
   * provided: an explicitly targeted profile that simply has no
   * SOUL.custom.md source is a per-profile `skipped` no-op (exit 0),
   * matching the `mergeConfig` contract — NOT a top-level "no profiles found"
   * failure.
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

  const results: MergeSoulResult[] = [];
  let foundAnyCustom = false;

  for (const profile of targetProfiles) {
    const profileDir = path.join(profilesDir, profile);
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

  // Only throw the aggregate "nothing to merge" error when no profiles were
  // explicitly targeted. With an explicit `profiles` list the run is a
  // per-profile no-op (skipped entries above), exactly like mergeConfig:
  // the user named a profile, so "no profiles found under <dir>" would be
  // both wrong and misleading. (Note: this mirrors mergeConfig's
  // `!options.profiles` truthiness exactly — a provided-but-empty array is
  // treated as explicitly provided and is likewise a clean no-op.)
  if (!foundAnyCustom && !options.profiles) {
    if (options.allowEmpty) {
      return results;
    }
    throw new Error(`Error: no profiles with SOUL.custom.md found under ${profilesDir}`);
  }

  return results;
}
