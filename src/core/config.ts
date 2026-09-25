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
  const availableProfiles = getProfileNames(profilesDir);
  const targetProfiles = options.profiles && options.profiles.length > 0
    ? options.profiles
    : availableProfiles;

  if (targetProfiles.length === 0 && !options.allowEmpty) {
    throw new Error(`No profiles found under ${profilesDir}`);
  }

  const results: MergeConfigResult[] = [];
  let foundAnyCustom = false;

  for (const profile of targetProfiles) {
    const profileDir = path.join(profilesDir, profile);
    // Defense in depth: the profile dir must stay strictly under
    // profilesDir (closes traversal even for non-explicit names).
    assertProfilePathInWorkspace(profilesDir, profileDir);
    const customConfigPath = path.join(profileDir, 'config.custom.yaml');
    const outputPath = path.join(profileDir, 'config.yaml');

    if (!fs.existsSync(customConfigPath)) {
      // Record a per-profile skipped entry instead of silently skipping: an
      // explicitly targeted profile (or any profile in the allowEmpty
      // aggregate path) whose custom source is missing is a visible no-op,
      // not an invisible one. `foundAnyCustom` stays driven only by real
      // custom sources below, exactly as mergeJobs/mergeSoul do.
      results.push({
        profile,
        outputPath,
        status: 'skipped',
        error: `Profile custom config not found: ${customConfigPath}`
      });
      continue;
    }

    foundAnyCustom = true;

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

  // Reached only with a non-empty target list (an empty one is caught by the
  // `No profiles found under` guard above). Throw the aggregate "nothing to
  // merge" error only when NO custom source EXISTS anywhere in the
  // DISCOVERED set and no profiles were EXPLICITLY targeted — driven by
  // source existence, NOT by merge success: a discovered profile whose
  // config.custom.yaml exists but is invalid carries its failure in the
  // per-profile `status: 'error'` entry (the real failure carrier), exactly
  // as mergeJobs/mergeSoul gate on their `foundAnyCustom` flag. With a
  // non-empty explicit `profiles` list each named profile already got a
  // per-profile `skipped`/`error` entry above, so a top-level failure would
  // be wrong and misleading.
  if (!foundAnyCustom && !options.profiles) {
    if (options.allowEmpty) {
      return results;
    }
    throw new Error(`No profiles with valid config.custom.yaml could be merged under ${profilesDir}`);
  }

  return results;
}
