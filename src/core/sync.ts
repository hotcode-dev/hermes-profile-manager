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
  const { config, jobs, soul } = mergeAll(options);
  const { skills, plugins, hermesLink, linkErrors } = linkAll(options);
  return { config, jobs, soul, skills, plugins, hermesLink, linkErrors };
}
