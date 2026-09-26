import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { deepMerge, isPlainObject } from '../utils/deep-merge.js';
import { atomicWriteFileSync } from '../utils/fs-helpers.js';
import { assertProfilePathInWorkspace } from '../utils/profile-name.js';
import {
  validateExplicitProfiles,
  resolveTargetProfiles,
  assertNonEmptyTargetProfiles,
  runPerProfileMerge
} from '../utils/profile-targets.js';

export interface MergeConfigOptions {
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
   * The "nothing to merge" check is source-existence based (mirrors
   * mergeJobs/mergeSoul): it triggers only when no discovered profile has a
   * config.custom.yaml AT ALL. A discovered profile whose source exists but
   * is invalid carries its failure in a per-profile `status: 'error'` entry
   * and never triggers this throw — that entry is the real failure carrier.
   *
   * Two "no targets" situations, both governed by this flag:
   * - An EMPTY target list (no profile subdirs found, or an explicit
   *   `profiles: []` on a profile-less workspace) throws
   *   `No profiles found under <dir>` unless `allowEmpty` — identical to
   *   mergeJobs/mergeSoul. An empty list names no profile, so it is NOT
   *   exempted.
   * - A NON-EMPTY explicit `profiles` list is exempted from the
   *   "nothing merged" throw: an explicitly targeted profile that simply
   *   has no config.custom.yaml source is a per-profile `skipped` no-op
   *   (exit 0), not a top-level failure.
   */
  allowEmpty?: boolean;
}

export interface MergeConfigResult {
  profile: string;
  outputPath: string;
  status: 'merged' | 'skipped' | 'error';
  error?: string;
}

/**
 * Merges common config (profiles/common/config.yaml) with profile custom config (profiles/<profile>/config.custom.yaml)
 * into profiles/<profile>/config.yaml.
 */
export function mergeConfig(options: MergeConfigOptions = {}): MergeConfigResult[] {
  const rootDir = options.rootDir || process.cwd();
  const log = options.logger || console.log;

  // Explicit profile names (global -p/--profiles option) are a
  // path-traversal vector; validated BEFORE any filesystem access or write
  // (see validateExplicitProfiles). Discovered names come from readdirSync.
  validateExplicitProfiles(options.profiles);

  const commonConfigPath = path.join(rootDir, 'profiles', 'common', 'config.yaml');

  if (!fs.existsSync(commonConfigPath)) {
    throw new Error(`Common config not found: ${commonConfigPath}`);
  }

  const commonRaw = fs.readFileSync(commonConfigPath, 'utf8');
  let commonParsed: unknown;
  try {
    commonParsed = parseYaml(commonRaw);
  } catch (err: unknown) {
    // Flatten the multi-line YAMLParseError (which embeds a source snippet
    // and caret) to its first line and name the file: the CLI's one-line
    // error contract must hold, and the raw parse error carries no path.
    const reason = err instanceof Error ? err.message.split('\n')[0] : String(err);
    throw new Error(`Common config is not valid YAML: ${commonConfigPath} — ${reason}`);
  }
  if (!isPlainObject(commonParsed)) {
    throw new Error(`Common config must be a YAML object: ${commonConfigPath}`);
  }

  const profilesDir = path.join(rootDir, 'profiles');
  const targetProfiles = resolveTargetProfiles(options.profiles, profilesDir);

  assertNonEmptyTargetProfiles(targetProfiles, profilesDir, options.allowEmpty);

  return runPerProfileMerge(
    targetProfiles,
    profilesDir,
    options.profiles,
    options.allowEmpty,
    (dir) => `No profiles with valid config.custom.yaml could be merged under ${dir}`,
    (profile, dir, found): MergeConfigResult => {
      const profileDir = path.join(dir, profile);
      // Defense in depth: the profile dir must stay strictly under
      // profilesDir (closes traversal even for non-explicit names).
      assertProfilePathInWorkspace(dir, profileDir);
      const customConfigPath = path.join(profileDir, 'config.custom.yaml');
      const outputPath = path.join(profileDir, 'config.yaml');

      if (!fs.existsSync(customConfigPath)) {
        // Record a per-profile skipped entry instead of silently skipping: an
        // explicitly targeted profile (or any profile in the allowEmpty
        // aggregate path) whose custom source is missing is a visible no-op,
        // not an invisible one. `foundAnyCustom` stays driven only by real
        // custom sources below (see FoundAnyCustom).
        return {
          profile,
          outputPath,
          status: 'skipped',
          error: `Profile custom config not found: ${customConfigPath}`
        };
      }

      // The custom source EXISTS: flip the flag (even if the merge below then
      // fails — its failure rides on the per-profile `error` entry).
      found.foundAnyCustom = true;

      try {
        const customRaw = fs.readFileSync(customConfigPath, 'utf8');
        let customParsed: unknown;
        try {
          customParsed = parseYaml(customRaw) ?? {};
        } catch (err: unknown) {
          // Same one-line, path-including wrap as the top-level common parse
          // above: the raw multi-line parse error would leak the source
          // snippet into the CLI report and name no file.
          const reason = err instanceof Error ? err.message.split('\n')[0] : String(err);
          throw new Error(`Custom config is not valid YAML: ${customConfigPath} — ${reason}`);
        }

        if (!isPlainObject(customParsed)) {
          throw new Error(`Custom config is not a valid YAML object: ${customConfigPath}`);
        }

        // Base first, custom overrides second
        const merged = deepMerge(commonParsed, customParsed);
        const mergedYaml = stringifyYaml(merged);

        if (!options.dryRun) {
          atomicWriteFileSync(outputPath, mergedYaml);
        }

        // Under --dry-run the file was not written, so phrase the line as a
        // preview rather than asserting a side effect that did not happen.
        log(
          options.dryRun
            ? `Would merge config to: ${outputPath}`
            : `Merged config written to: ${outputPath}`
        );
        return {
          profile,
          outputPath,
          status: 'merged'
        };
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        log(`Error merging config for ${profile}: ${errorMsg}`);
        return {
          profile,
          outputPath,
          status: 'error' as const,
          error: errorMsg
        };
      }
    }
  );
}
