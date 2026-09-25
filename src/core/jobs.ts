import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFileSync } from '../utils/fs-helpers.js';
import { assertProfilePathInWorkspace } from '../utils/profile-name.js';
import {
  validateExplicitProfiles,
  resolveTargetProfiles,
  assertNonEmptyTargetProfiles,
  runPerProfileMerge
} from '../utils/profile-targets.js';

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
 * True when `raw` carries a jobs list that `normalizeJobsDoc` preserves:
 * a top-level array, or a non-null object whose `jobs` property is an
 * array. Anything else gets its jobs list reset to `[]` by
 * `normalizeJobsDoc`, so callers can use this to surface that reset
 * instead of letting it happen silently.
 */
function isJobsDocShaped(raw: unknown): boolean {
  if (Array.isArray(raw)) {
    return true;
  }
  return (
    typeof raw === 'object' &&
    raw !== null &&
    Array.isArray((raw as Record<string, unknown>).jobs)
  );
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
      mergedJobs.push(bJob);
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

  // Explicit profile names (global -p/--profiles option) are a
  // path-traversal vector; validated BEFORE any filesystem access or write
  // (see validateExplicitProfiles). Discovered names come from readdirSync.
  validateExplicitProfiles(options.profiles);

  const profilesDir = path.join(rootDir, 'profiles');
  const targetProfiles = resolveTargetProfiles(options.profiles, profilesDir);

  assertNonEmptyTargetProfiles(targetProfiles, profilesDir, options.allowEmpty);

  return runPerProfileMerge(
    targetProfiles,
    profilesDir,
    options.profiles,
    options.allowEmpty,
    (dir) => `Error: no profiles with cron/jobs.custom.json found under ${dir}`,
    (profile, dir, found): MergeJobsResult => {
      const profileDir = path.join(dir, profile);
      // Defense in depth: the profile dir must stay strictly under
      // profilesDir (closes traversal even for non-explicit names).
      assertProfilePathInWorkspace(dir, profileDir);
      const cronDir = path.join(profileDir, 'cron');
      const customJobsPath = path.join(cronDir, 'jobs.custom.json');
      const outputJobsPath = path.join(cronDir, 'jobs.json');

      if (!fs.existsSync(customJobsPath)) {
        // Record a per-profile skipped entry instead of silently skipping:
        // an explicitly targeted profile (or any profile in the allowEmpty
        // aggregate path) whose custom source is missing is a visible no-op,
        // not an invisible one. `foundAnyCustom` stays driven only by real
        // custom sources below (see FoundAnyCustom).
        return {
          profile,
          outputPath: outputJobsPath,
          status: 'skipped',
          error: `Profile cron/jobs.custom.json not found: ${customJobsPath}`
        };
      }

      // The custom source EXISTS: flip the flag (even if the merge below
      // then fails — its failure rides on the per-profile `error` entry).
      found.foundAnyCustom = true;

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
          let baseOk = false;
          try {
            const baseRaw = fs.readFileSync(outputJobsPath, 'utf8');
            baseParsed = JSON.parse(baseRaw);
            baseOk = true;
          } catch {
            // Base file exists but does not parse. Fall back to an empty
            // document (the correct recovery behavior — an unparseable base
            // has no recoverable jobs) but make the data loss VISIBLE: the
            // next write below overwrites this file with custom jobs only,
            // dropping every previously merged base job.
            baseParsed = { jobs: [] };
          }
          if (baseOk && !isJobsDocShaped(baseParsed)) {
            // Valid JSON but not a jobs document (e.g. `42`, `"foo"`,
            // `{noJobs: true}`): normalizeJobsDoc resets its jobs list to
            // [] below, dropping every previously merged base job just as
            // silently as the parse-failure path above. Surface it the same
            // way.
            log(
              `Warning: base jobs file is not a jobs document at ${outputJobsPath} — ` +
                'resetting to empty base; previously merged jobs will be lost. ' +
                'Fix or restore the file before the next run.'
            );
          } else if (!baseOk) {
            log(
              `Warning: base jobs file is not valid JSON at ${outputJobsPath} — ` +
                'resetting to empty base; previously merged jobs will be lost. ' +
                'Fix or restore the file before the next run.'
            );
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
        return {
          profile,
          outputPath: outputJobsPath,
          status: 'merged'
        };
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        log(`Error merging jobs for ${profile}: ${errorMsg}`);
        return {
          profile,
          outputPath: outputJobsPath,
          status: 'error',
          error: errorMsg
        };
      }
    }
  );
}
