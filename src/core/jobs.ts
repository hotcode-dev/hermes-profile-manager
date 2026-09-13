import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFileSync, getProfileNames } from '../utils/fs-helpers.js';

export interface MergeJobsOptions {
  rootDir?: string;
  profiles?: string[];
  logger?: (msg: string) => void;
  dryRun?: boolean;
}

export interface MergeJobsResult {
  profile: string;
  outputPath: string;
  status: 'merged' | 'skipped' | 'error';
  error?: string;
}

interface JobItem {
  id?: string | number;
  [key: string]: unknown;
}

interface JobsDocument {
  jobs?: JobItem[];
  [key: string]: unknown;
}

function normalizeJobsDoc(raw: unknown): JobsDocument {
  if (Array.isArray(raw)) {
    return { jobs: raw as JobItem[] };
  }
  if (typeof raw === 'object' && raw !== null) {
    const doc = { ...(raw as Record<string, unknown>) };
    if (!Array.isArray(doc.jobs)) {
      doc.jobs = [];
    }
    return doc as JobsDocument;
  }
  return { jobs: [] };
}

/**
 * Merges base jobs and custom jobs matching the original jq logic:
 * - Top-level properties: custom overrides base.
 * - Jobs with matching 'id' are merged (custom properties override base job properties).
 * - Jobs only in custom are appended.
 * - Base jobs order is preserved.
 */
export function mergeJobsDocuments(baseDoc: JobsDocument, customDoc: JobsDocument): JobsDocument {
  const mergedRoot = { ...baseDoc, ...customDoc };
  const baseJobs = Array.isArray(baseDoc.jobs) ? baseDoc.jobs : [];
  const customJobs = Array.isArray(customDoc.jobs) ? customDoc.jobs : [];

  const customById = new Map<string, JobItem>();
  for (const job of customJobs) {
    if (job && job.id != null) {
      customById.set(String(job.id), job);
    }
  }

  const baseIds = new Set<string>();
  const mergedJobs: JobItem[] = [];

  for (const bJob of baseJobs) {
    if (bJob && bJob.id != null) {
      const idStr = String(bJob.id);
      baseIds.add(idStr);
      if (customById.has(idStr)) {
        mergedJobs.push({ ...bJob, ...customById.get(idStr) });
      } else {
        mergedJobs.push({ ...bJob });
      }
    } else {
      mergedJobs.push(bJob);
    }
  }

  for (const cJob of customJobs) {
    if (!cJob) continue;
    if (cJob.id == null) {
      // Jobs without an id cannot be matched against base ids; always keep them.
      mergedJobs.push({ ...cJob });
      continue;
    }
    if (!baseIds.has(String(cJob.id))) {
      mergedJobs.push({ ...cJob });
    }
  }

  mergedRoot.jobs = mergedJobs;
  return mergedRoot;
}

/**
 * Merges cron jobs for profiles:
 * Base: profiles/<profile>/cron/jobs.json (or defaults to { jobs: [] } if absent/invalid)
 * Custom: profiles/<profile>/cron/jobs.custom.json
 * Output: profiles/<profile>/cron/jobs.json
 */
export function mergeJobs(options: MergeJobsOptions = {}): MergeJobsResult[] {
  const rootDir = options.rootDir || process.cwd();
  const log = options.logger || console.log;
  const profilesDir = path.join(rootDir, 'profiles');
  const availableProfiles = getProfileNames(profilesDir);
  const targetProfiles = options.profiles && options.profiles.length > 0
    ? options.profiles
    : availableProfiles;

  const results: MergeJobsResult[] = [];
  let foundAnyCustom = false;

  for (const profile of targetProfiles) {
    const profileDir = path.join(profilesDir, profile);
    const cronDir = path.join(profileDir, 'cron');
    const customJobsPath = path.join(cronDir, 'jobs.custom.json');
    const outputJobsPath = path.join(cronDir, 'jobs.json');

    if (!fs.existsSync(customJobsPath)) {
      continue;
    }

    foundAnyCustom = true;

    try {
      const customRaw = fs.readFileSync(customJobsPath, 'utf8');
      let customParsed: unknown;
      try {
        customParsed = JSON.parse(customRaw);
      } catch {
        throw new Error(`Jobs custom file is not valid JSON: ${customJobsPath}`);
      }

      let baseParsed: unknown = { jobs: [] };
      if (fs.existsSync(outputJobsPath)) {
        try {
          const baseRaw = fs.readFileSync(outputJobsPath, 'utf8');
          baseParsed = JSON.parse(baseRaw);
        } catch {
          // If base file is corrupt or empty, fallback cleanly to empty document
          baseParsed = { jobs: [] };
        }
      }

      const mergedDoc = mergeJobsDocuments(
        normalizeJobsDoc(baseParsed),
        normalizeJobsDoc(customParsed)
      );

      const formattedJson = JSON.stringify(mergedDoc, null, 2) + '\n';

      if (!options.dryRun) {
        atomicWriteFileSync(outputJobsPath, formattedJson);
      }

      log(`Merged jobs written to: ${outputJobsPath}`);
      results.push({
        profile,
        outputPath: outputJobsPath,
        status: 'merged'
      });
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      log(`Error merging jobs for ${profile}: ${errorMsg}`);
      results.push({
        profile,
        outputPath: outputJobsPath,
        status: 'error',
        error: errorMsg
      });
    }
  }

  if (!foundAnyCustom) {
    throw new Error(`Error: no profiles with cron/jobs.custom.json found under ${profilesDir}`);
  }

  return results;
}
