import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFileSync, getProfileNames } from '../utils/fs-helpers.js';
import { validateProfileName, assertProfilePathInWorkspace } from '../utils/profile-name.js';

export interface MergeJobsOptions {
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
   *   mergeConfig/mergeSoul. An empty list names no profile, so it is NOT
   *   exempted.
   * - A NON-EMPTY explicit `profiles` list is exempted from the
   *   "nothing to merge" throw: an explicitly targeted profile that simply
   *   has no cron/jobs.custom.json source is a per-profile `skipped` no-op
   *   (exit 0), not a top-level failure.
   */
  allowEmpty?: boolean;
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

/**
 * Canonical JSON serialization (object keys sorted recursively) so id-less
 * jobs can be compared by deep content equality regardless of key order.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
  return `{${entries.join(',')}}`;
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
 *
 * Idempotent for id-less jobs: because `mergeJobs` feeds a previous run's
 * OUTPUT file back in as the base, every custom job — with or without an id —
 * is already present in the base on the next run. Id-matched jobs stay
 * deduped via `baseIds`; id-less custom jobs are deduped by deep content
 * equality (canonical serialization), so f(f(base, custom), custom) ===
 * f(base, custom) and repeated merges never grow the jobs list.
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
  // Canonical content fingerprints of every job kept in the merged document.
  // Id-less custom jobs cannot be matched by id, so they are deduplicated by
  // deep content equality instead: a custom job whose serialized content is
  // already present (because the base file was itself a previous merge
  // output, or the custom doc repeats the job) is NOT re-appended. This is
  // what makes re-runs stable: f(f(b, c), c) === f(b, c).
  const mergedCanons = new Set<string>();

  for (const bJob of baseJobs) {
    if (bJob && bJob.id != null) {
      const idStr = String(bJob.id);
      baseIds.add(idStr);
      if (customById.has(idStr)) {
        const merged = { ...bJob, ...customById.get(idStr) };
        mergedJobs.push(merged);
        mergedCanons.add(canonicalJson(merged));
      } else {
        mergedJobs.push({ ...bJob });
        mergedCanons.add(canonicalJson(bJob));
      }
    } else if (bJob) {
      // Copy like the sibling branches: pushing the reference would alias the
      // caller's base job into the merged output, so a post-call mutation of
      // the returned document would silently corrupt the input object.
      mergedJobs.push({ ...bJob });
      mergedCanons.add(canonicalJson(bJob));
    }
  }

  for (const cJob of customJobs) {
    if (!cJob) continue;
    if (cJob.id != null && baseIds.has(String(cJob.id))) {
      // Already matched a base job by id in the loop above.
      continue;
    }
    const canon = canonicalJson(cJob);
    if (mergedCanons.has(canon)) {
      // Content already present in the merged document — an id-less copy
      // surviving from a previous merge, or a repeated entry. Skip to keep
      // repeated runs idempotent.
      continue;
    }
    mergedJobs.push({ ...cJob });
    mergedCanons.add(canon);
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

  // User-controlled profile names (global -p/--profiles option) are a
  // path-traversal vector: path.join(profilesDir, '../../x') resolves
  // OUTSIDE the workspace. Validate every explicitly targeted name BEFORE
  // any filesystem access or write, mirroring initWorkspace's "validated
  // before path construction" contract. (Discovered names come from
  // readdirSync, not user input.)
  for (const profile of options.profiles ?? []) {
    validateProfileName(profile);
  }

  const profilesDir = path.join(rootDir, 'profiles');
  const availableProfiles = getProfileNames(profilesDir);
  const targetProfiles = options.profiles && options.profiles.length > 0
    ? options.profiles
    : availableProfiles;

  // No-targets guard, shared with mergeConfig/mergeSoul: an empty target
  // list (no profile subdirs, or an explicit `profiles: []` on a profile-less
  // workspace) is a hard "no profiles found" failure unless `allowEmpty`. An
  // empty list names no profile, so it is NOT exempted the way a non-empty
  // explicit list is.
  if (targetProfiles.length === 0 && !options.allowEmpty) {
    throw new Error(`No profiles found under ${profilesDir}`);
  }

  const results: MergeJobsResult[] = [];
  let foundAnyCustom = false;

  for (const profile of targetProfiles) {
    const profileDir = path.join(profilesDir, profile);
    // Defense in depth: the profile dir must stay strictly under
    // profilesDir (closes traversal even for non-explicit names).
    assertProfilePathInWorkspace(profilesDir, profileDir);
    const cronDir = path.join(profileDir, 'cron');
    const customJobsPath = path.join(cronDir, 'jobs.custom.json');
    const outputJobsPath = path.join(cronDir, 'jobs.json');

    if (!fs.existsSync(customJobsPath)) {
      // Record a per-profile skipped entry instead of silently skipping,
      // mirroring mergeConfig: an explicitly targeted profile (or any
      // profile in the allowEmpty aggregate path) whose custom source is
      // missing is a visible no-op, not an invisible one. `foundAnyCustom`
      // stays driven only by real custom sources below.
      results.push({
        profile,
        outputPath: outputJobsPath,
        status: 'skipped',
        error: `Profile cron/jobs.custom.json not found: ${customJobsPath}`
      });
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

      // Under --dry-run the file was not written, so phrase the line as a
      // preview rather than asserting a side effect that did not happen.
      log(
        options.dryRun
          ? `Would merge jobs to: ${outputJobsPath}`
          : `Merged jobs written to: ${outputJobsPath}`
      );
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

  // Reached only with a non-empty target list (an empty one is caught by the
  // `No profiles found under` guard above). Throw the aggregate "nothing to
  // merge" error only when no profiles were EXPLICITLY targeted. With a
  // non-empty explicit `profiles` list each named profile already got a
  // per-profile `skipped` entry above, so a top-level "no profiles with
  // cron/jobs.custom.json found" failure would be wrong and misleading —
  // exactly mergeConfig's `!options.profiles` gate.
  if (!foundAnyCustom && !options.profiles) {
    if (options.allowEmpty) {
      return results;
    }
    throw new Error(`Error: no profiles with cron/jobs.custom.json found under ${profilesDir}`);
  }

  return results;
}
