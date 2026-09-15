import { mergeConfig, MergeConfigOptions, MergeConfigResult } from './config.js';
import { mergeJobs, MergeJobsOptions, MergeJobsResult } from './jobs.js';
import { mergeSoul, MergeSoulOptions, MergeSoulResult } from './soul.js';
import { linkSkills, linkPlugins, linkHermes, LinkOptions, LinkResult } from './links.js';

export interface SyncOptions extends MergeConfigOptions, MergeJobsOptions, MergeSoulOptions, LinkOptions {
  includeHermesLink?: boolean;
}

export interface SyncAllResult {
  config: MergeConfigResult[];
  jobs: MergeJobsResult[];
  soul: MergeSoulResult[];
  skills: LinkResult[];
  plugins: LinkResult[];
  hermesLink?: LinkResult;
  /**
   * Errors from the link steps (skills / plugins / hermes), captured instead
   * of thrown so the aggregate never aborts before the CLI can report them.
   * Mirrors the merge path, where per-profile failures are recorded in the
   * returned arrays rather than thrown. Empty when every link step succeeded
   * (or was a no-op).
   */
  linkErrors: string[];
  /**
   * A top-level (pre-profile) failure of a merge step, captured instead of
   * thrown so the aggregate never aborts before the CLI can report it.
   *
   * The per-profile failures are recorded as `status: 'error'` entries in
   * the merge arrays, but a merge step can ALSO fail before it even reaches
   * its profiles - e.g. `mergeConfig` throws when
   * `profiles/common/config.yaml` is missing or not a YAML object. Those
   * are captured here (the merge arrays stay empty), and `syncAll` therefore
   * really does never throw: the CLI gates its success banner and exit code
   * on BOTH this field and the per-profile error entries.
   */
  syncError?: string;
}

/**
 * Runs the three sub-merges (config, jobs, soul) over all profiles.
 * Each sub-merge is run with `allowEmpty: true` so that a workspace that
 * happens to have no custom source for a given concern (e.g. no
 * cron/jobs.custom.json anywhere) is a successful no-op for that concern
 * rather than a hard error that aborts the rest of the aggregate.
 */
export function mergeAll(options: SyncOptions = {}): { config: MergeConfigResult[]; jobs: MergeJobsResult[]; soul: MergeSoulResult[] } {
  const baseOptions = { ...options, allowEmpty: true };
  const config = mergeConfig(baseOptions);
  const jobs = mergeJobs(baseOptions);
  const soul = mergeSoul(baseOptions);
  return { config, jobs, soul };
}

/**
 * Runs the link steps (skills, plugins, and optionally the Hermes profiles
 * link). Each step is run inside its own try/catch so that a failure in one
 * step (e.g. a missing `profiles/common/skills` source dir) is *captured*
 * into `linkErrors` instead of thrown. This mirrors the merge path, where
 * per-profile failures are recorded in the returned arrays rather than
 * thrown, and guarantees the aggregate (`syncAll`) always returns so the CLI
 * can report BOTH the merge results and any link failures in one pass.
 */
export function linkAll(options: SyncOptions = {}): { skills: LinkResult[]; plugins: LinkResult[]; hermesLink?: LinkResult; linkErrors: string[] } {
  const linkErrors: string[] = [];
  let skills: LinkResult[] = [];
  let plugins: LinkResult[] = [];
  let hermesLink: LinkResult | undefined;

  try {
    skills = linkSkills(options);
  } catch (err: unknown) {
    linkErrors.push(err instanceof Error ? err.message : String(err));
  }

  try {
    plugins = linkPlugins(options);
  } catch (err: unknown) {
    linkErrors.push(err instanceof Error ? err.message : String(err));
  }

  if (options.includeHermesLink) {
    try {
      hermesLink = linkHermes(options);
    } catch (err: unknown) {
      linkErrors.push(err instanceof Error ? err.message : String(err));
    }
  }

  return { skills, plugins, hermesLink, linkErrors };
}

export function syncAll(options: SyncOptions = {}): SyncAllResult {
  // mergeAll normally records per-profile failures as `status: 'error'`
  // entries (never thrown), but a top-level merge precondition - e.g. a
  // missing or non-object `profiles/common/config.yaml` in mergeConfig -
  // still throws. Capture it into `syncError` so syncAll really never
  // throws and the CLI can report the failure together with the link
  // results instead of dying with a raw stack trace.
  const baseOptions: SyncOptions = { ...options, allowEmpty: true };
  let config: MergeConfigResult[] = [];
  let jobs: MergeJobsResult[] = [];
  let soul: MergeSoulResult[] = [];
  let syncError: string | undefined;
  try {
    // mergeAll forces allowEmpty internally, so a genuinely empty workspace
    // is a benign no-op here; only real top-level failures reach the catch.
    ({ config, jobs, soul } = mergeAll(baseOptions));
  } catch (err: unknown) {
    syncError = err instanceof Error ? err.message : String(err);
  }
  const { skills, plugins, hermesLink, linkErrors } = linkAll(options);
  return { config, jobs, soul, skills, plugins, hermesLink, linkErrors, syncError };
}
