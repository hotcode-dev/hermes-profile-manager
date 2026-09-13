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

export function linkAll(options: SyncOptions = {}): { skills: LinkResult[]; plugins: LinkResult[]; hermesLink?: LinkResult } {
  const skills = linkSkills(options);
  const plugins = linkPlugins(options);
  let hermesLink: LinkResult | undefined;
  if (options.includeHermesLink) {
    hermesLink = linkHermes(options);
  }
  return { skills, plugins, hermesLink };
}

export function syncAll(options: SyncOptions = {}): SyncAllResult {
  const { config, jobs, soul } = mergeAll(options);
  const { skills, plugins, hermesLink } = linkAll(options);
  return { config, jobs, soul, skills, plugins, hermesLink };
}
