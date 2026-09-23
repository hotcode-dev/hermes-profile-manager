import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { deepMerge, isPlainObject } from '../utils/deep-merge.js';
import { atomicWriteFileSync, getProfileNames } from '../utils/fs-helpers.js';
import { validateProfileName, assertProfilePathInWorkspace } from '../utils/profile-name.js';

export interface MergeConfigOptions {
  rootDir?: string;
  profiles?: string[];
  logger?: (msg: string) => void;
  dryRun?: boolean;
  /**
   * When true, a run with nothing to merge is a successful no-op (returns
   * the per-profile skipped/error results, or `[]` for an empty target list)
   * instead of throwing. Used by the aggregate sync path; standalone CLI
   * calls keep the default (false) and still surface the "nothing to merge"
   * error.
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

  // User-controlled profile names (global -p/--profiles option) are a
  // path-traversal vector: path.join(profilesDir, '../../x') resolves
  // OUTSIDE the workspace. Validate every explicitly targeted name BEFORE
  // any filesystem access or write, mirroring initWorkspace's "validated
  // before path construction" contract. (Discovered names come from
  // readdirSync, not user input.)
  for (const profile of options.profiles ?? []) {
    validateProfileName(profile);
  }

  const commonConfigPath = path.join(rootDir, 'profiles', 'common', 'config.yaml');

  if (!fs.existsSync(commonConfigPath)) {
    throw new Error(`Common config not found: ${commonConfigPath}`);
  }

  const commonRaw = fs.readFileSync(commonConfigPath, 'utf8');
  const commonParsed = parseYaml(commonRaw);
  if (!isPlainObject(commonParsed)) {
    throw new Error(`Common config must be a YAML object: ${commonConfigPath}`);
  }

  const profilesDir = path.join(rootDir, 'profiles');
  const availableProfiles = getProfileNames(profilesDir);
  const targetProfiles = options.profiles && options.profiles.length > 0
    ? options.profiles
    : availableProfiles;

  if (targetProfiles.length === 0 && !options.allowEmpty) {
    throw new Error(`No profiles found under ${profilesDir}`);
  }

  const results: MergeConfigResult[] = [];

  for (const profile of targetProfiles) {
    const profileDir = path.join(profilesDir, profile);
    // Defense in depth: the profile dir must stay strictly under
    // profilesDir (closes traversal even for non-explicit names).
    assertProfilePathInWorkspace(profilesDir, profileDir);
    const customConfigPath = path.join(profileDir, 'config.custom.yaml');
    const outputPath = path.join(profileDir, 'config.yaml');

    if (!fs.existsSync(customConfigPath)) {
      results.push({
        profile,
        outputPath,
        status: 'skipped',
        error: `Profile custom config not found: ${customConfigPath}`
      });
      continue;
    }

    try {
      const customRaw = fs.readFileSync(customConfigPath, 'utf8');
      const customParsed = parseYaml(customRaw) ?? {};

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
      results.push({
        profile,
        outputPath,
        status: 'merged'
      });
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      log(`Error merging config for ${profile}: ${errorMsg}`);
      results.push({
        profile,
        outputPath,
        status: 'error',
        error: errorMsg
      });
    }
  }

  const mergedCount = results.filter((r) => r.status === 'merged').length;
  if (mergedCount === 0 && !options.profiles) {
    if (options.allowEmpty) {
      return results;
    }
    throw new Error(`No profiles with valid config.custom.yaml could be merged under ${profilesDir}`);
  }

  return results;
}
