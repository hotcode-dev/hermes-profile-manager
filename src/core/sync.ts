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

export function mergeAll(options: SyncOptions = {}): { config: MergeConfigResult[]; jobs: MergeJobsResult[]; soul: MergeSoulResult[] } {
  const config = mergeConfig(options);
  const jobs = mergeJobs(options);
  const soul = mergeSoul(options);
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
