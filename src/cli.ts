#!/usr/bin/env node
import { Command } from 'commander';
import { findProjectRoot } from './utils/root-finder.js';
import { mergeConfig } from './core/config.js';
import { mergeJobs } from './core/jobs.js';
import { mergeSoul } from './core/soul.js';
import { linkSkills, linkPlugins, linkHermes } from './core/links.js';
import { mergeAll, linkAll, syncAll } from './core/sync.js';
import { initWorkspace } from './core/init.js';
import { collectMergeErrors, MergeStatusResult } from './utils/merge-results.js';

const program = new Command();

program
  .name('hermes-profile-manager')
  .description('Hermes agent profile manager: merge configs, jobs, SOUL prompts, and manage symlinks')
  .version('0.1.0')
  .option('-r, --root <path>', 'Path to repository root (auto-detected by default)')
  .option('--hermes-dir <path>', 'Path to Hermes home directory (default: ~/.hermes)')
  .option('-p, --profiles <profiles...>', 'Specific profile names to target')
  .option('-d, --dry-run', 'Run without writing changes to disk')
  .option('-q, --quiet', 'Suppress normal output');

function getOptions(cmd: any) {
  const globalOpts = program.opts();
  const rootDir = globalOpts.root ? findProjectRoot(globalOpts.root) : findProjectRoot();
  const logger = globalOpts.quiet ? () => {} : console.log;
  return {
    rootDir,
    hermesDir: globalOpts.hermesDir,
    profiles: globalOpts.profiles,
    dryRun: Boolean(globalOpts.dryRun),
    logger
  };
}

/**
 * Reports per-profile merge failures and exits non-zero when any concern
 * produced `status: 'error'` entries.
 *
 * The core modules catch per-profile errors and record them in the returned
 * arrays instead of throwing, and their own error `log(...)` lines are
 * suppressed under `--quiet`. This is the single place where the CLI turns
 * that information into a visible report and a failing exit code.
 *
 * `skipped` entries (no custom source for the profile) are NOT failures - the
 * banner and exit 0 are still produced when only `skipped`/`merged` exist.
 */
function finishWithErrors(banner: string, ...arrays: MergeStatusResult[][]): void {
  const errors = collectMergeErrors(...arrays);
  if (errors.length > 0) {
    for (const entry of errors) {
      console.error(`\u2717 ${entry.profile}: ${entry.error ?? 'merge failed'}`);
    }
    console.error(`Failed: ${errors.length} profile(s) had merge errors. Fix the sources above and re-run.`);
    process.exit(1);
  }
  if (!program.opts().quiet) {
    console.log(`\u2713 ${banner}`);
  }
}

/**
 * Runs a standalone merge step (mergeAll / mergeConfig / mergeJobs /
 * mergeSoul) and gives the merge command family the same "never throw,
 * always report cleanly" contract as the sync path.
 *
 * A TOP-LEVEL merge precondition - e.g. `mergeConfig` throwing when
 * `profiles/common/config.yaml` is missing or not a YAML object, `mergeSoul`
 * throwing when `profiles/common/SOUL.md` is absent, or `mergeJobs` /
 * `mergeSoul` throwing when no profile has the custom source - escapes the
 * core function before any per-profile results exist. The operation thunk is
 * wrapped in a try/catch: that thrown error is converted to a single one-line
 * error on stderr, a `Failed:` summary, and a controlled `process.exit(1)` -
 * never a raw stack trace, and with no success banner. This mirrors
 * {@link safeLink} and the `syncAll` / `reportSyncErrors` contract of the
 * sync path.
 *
 * Per-profile behavior is UNCHANGED: on a clean (non-throwing) run the
 * returned arrays are passed straight to {@link finishWithErrors}, which
 * still inspects only `status: 'error'` entries and prints the banner on
 * success. Only the pre-profile throw is captured here.
 */
function finishMerge(banner: string, operation: () => MergeStatusResult[][]): void {
  let arrays: MergeStatusResult[][];
  try {
    arrays = operation();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`\u2717 ${message}`);
    console.error('Failed: the merge run failed. Fix the sources above and re-run.');
    process.exit(1);
  }
  finishWithErrors(banner, ...arrays);
}

/**
 * Reports an initial-sync failure and exits non-zero. Returns true only
 * when the run was CLEAN (no top-level sync error, no per-profile merge
 * errors, no link failures) so the caller knows it may print its success
 * banner. On failure this function never returns (process.exit(1)).
 *
 * The three failure classes are reported in the order the run executes
 * them: the top-level `syncError` first (a pre-profile precondition like a
 * broken `profiles/common/config.yaml` aborts the merge step entirely,
 * leaving the per-profile arrays empty), then the per-profile merge
 * errors, then the link-step failures.
 *
 * This is the single shared reporting path behind {@link finishSync} and
 * the `init` command, so the merge-error / link-error / top-level error
 * formatting and exit-code contract is implemented exactly once.
 */
function reportSyncErrors(
  arrays: MergeStatusResult[][],
  linkErrors: string[],
  syncError?: string
): boolean {
  const errors = collectMergeErrors(...arrays);
  if (errors.length > 0 || linkErrors.length > 0 || syncError) {
    if (syncError) {
      console.error(`\u2717 ${syncError}`);
    }
    for (const entry of errors) {
      console.error(`\u2717 ${entry.profile}: ${entry.error ?? 'merge failed'}`);
    }
    for (const message of linkErrors) {
      console.error(`\u2717 ${message}`);
    }
    const parts: string[] = [];
    if (syncError) parts.push('the sync run failed');
    if (errors.length > 0) parts.push(`${errors.length} profile(s) had merge errors`);
    if (linkErrors.length > 0) parts.push(`${linkErrors.length} link step(s) failed`);
    console.error(`Failed: ${parts.join(' and ')}. Fix the sources above and re-run.`);
    process.exit(1);
  }
  return true;
}

/**
 * Reports BOTH per-profile merge failures AND link-step failures (plus an
 * optional top-level sync failure), and exits non-zero when any is present.
 *
 * This is the aggregate counterpart to {@link finishWithErrors}, used by
 * `sync`, `all`, `merge-all`, and `init` (which run the full aggregate and
 * report it through this shared path). The merges record `status: 'error'`
 * entries instead of throwing, the link steps capture failures into
 * `result.linkErrors` instead of throwing, and a top-level merge
 * precondition failure (e.g. a missing or non-object
 * `profiles/common/config.yaml`) is captured into `result.syncError`
 * instead of throwing (see `syncAll` in core/sync.ts). Because nothing
 * throws, the already-computed merge results are ALWAYS reported here - a
 * link or top-level failure can no longer preempt the merge report (the
 * bug this module set out to fix).
 *
 * The success banner is suppressed under `--quiet`; the error report is
 * always shown (on stderr), matching the merge-path contract.
 */
function finishSync(banner: string, arrays: MergeStatusResult[][], linkErrors: string[], syncError?: string): void {
  if (reportSyncErrors(arrays, linkErrors, syncError) && !program.opts().quiet) {
    console.log(`\u2713 ${banner}`);
  }
}

/**
 * Reports link-step failures and exits non-zero.
 *
 * Used by the standalone `link` command (default target `all`), whose link
 * step is `linkAll` - which, unlike the individual link functions, captures
 * its failures into the returned `linkErrors` array instead of throwing.
 */
function finishLinkErrors(linkErrors: string[]): void {
  for (const message of linkErrors) {
    console.error(`\u2717 ${message}`);
  }
  console.error(
    linkErrors.length === 1
      ? 'Failed: 1 link step failed. Fix the source above and re-run.'
      : `Failed: ${linkErrors.length} link steps failed. Fix the sources above and re-run.`
  );
  process.exit(1);
}

/**
 * Runs a single link operation (linkSkills / linkPlugins / linkHermes), all
 * of which throw when their required source directory is missing or a symlink
 * cannot be created, and converts any thrown error into a readable one-line
 * error on stderr and a controlled non-zero exit - never a raw stack trace.
 *
 * On success the given banner is printed (suppressed under `--quiet`),
 * matching the success-banner contract of the merge commands.
 */
function safeLink(banner: string, operation: () => void): void {
  try {
    operation();
  } catch (err: unknown) {
    console.error(`\u2717 ${err instanceof Error ? err.message : String(err)}`);
    console.error('Failed: 1 link step failed. Fix the source above and re-run.');
    process.exit(1);
  }
  if (!program.opts().quiet) {
    console.log(`\u2713 ${banner}`);
  }
}

// Command: init
program
  .command('init [targetDir]')
  .description('Initialize a new Hermes profile workspace scaffolding')
  .option('-p, --profile <name>', 'Initial agent profile name', 'main')
  .option('-f, --force', 'Overwrite existing files if they exist', false)
  .option('--no-sync', 'Do not run sync immediately after initialization')
  .action((targetDir, cmdOpts) => {
    const logger = program.opts().quiet ? () => {} : console.log;
    const result = initWorkspace({
      targetDir: targetDir || process.cwd(),
      profileName: cmdOpts.profile,
      force: cmdOpts.force,
      runSync: cmdOpts.sync,
      logger
    });

    // The initial sync never throws: per-profile merge failures are recorded
    // as `status: 'error'` entries, a broken top-level source (e.g. a
    // non-object profiles/common/config.yaml) is captured into
    // `syncResult.syncError`, and link failures into `syncResult.linkErrors`.
    // Gate the success banner and exit code on ALL of them, through the same
    // shared reporting path as `sync` / `merge-all`.
    if (result.syncResult) {
      const clean = reportSyncErrors(
        [result.syncResult.config, result.syncResult.jobs, result.syncResult.soul],
        result.syncResult.linkErrors,
        result.syncResult.syncError
      );
      if (!clean) {
        return;
      }
    }

    if (!program.opts().quiet) {
      console.log(`\n\u2713 Successfully initialized Hermes profiles in ${result.targetDir}`);
      console.log(`  - Profile created: ${result.profileName}`);
      console.log(`  - Files created: ${result.createdFiles.length}`);
      if (result.skippedFiles.length > 0) {
        console.log(`  - Files skipped (already existed): ${result.skippedFiles.length}`);
      }
      console.log('\nNext steps:');
      console.log(`  1. Customize profiles/common/config.yaml and profiles/${result.profileName}/config.custom.yaml`);
      console.log(`  2. Customize profiles/${result.profileName}/SOUL.custom.md`);
      console.log('  3. Run "hpm sync" to recompile when modifying configuration files.');
    }
  });

// Command: sync / all
program
  .command('sync')
  .alias('all')
  .description('Run all merges (config, jobs, soul) and links (skills, plugins)')
  .option('--include-hermes-link', 'Also link profiles directory to ~/.hermes/profiles', false)
  .action((cmdOpts) => {
    const opts = { ...getOptions(cmdOpts), includeHermesLink: cmdOpts.includeHermesLink };
    // syncAll runs the merges (recorded as status:'error' entries, never
    // thrown) and then the link steps (captured into result.linkErrors,
    // never thrown). It never throws, so both the merge results and any link
    // failures reach finishSync and are reported together.
    const result = syncAll(opts);
    finishSync(
      'Synced all Hermes profiles successfully',
      [result.config, result.jobs, result.soul],
      result.linkErrors,
      result.syncError
    );
  });

// Command: merge
program
  .command('merge [target]')
  .description('Merge profiles resources: all, config, jobs, or soul')
  .action((target, cmdOpts) => {
    const opts = getOptions(cmdOpts);
    switch (target || 'all') {
      case 'all': {
        // finishMerge captures a top-level mergeAll throw (e.g. a missing or
        // non-object profiles/common/config.yaml) so it is reported cleanly
        // instead of escaping as a raw stack trace.
        finishMerge('Merged config, jobs, and SOUL for all profiles', () => {
          const result = mergeAll(opts);
          return [result.config, result.jobs, result.soul];
        });
        break;
      }
      case 'config':
        finishMerge('Merged config for all profiles', () => [mergeConfig(opts)]);
        break;
      case 'jobs':
        finishMerge('Merged jobs for all profiles', () => [mergeJobs(opts)]);
        break;
      case 'soul':
        finishMerge('Merged SOUL for all profiles', () => [mergeSoul(opts)]);
        break;
      default:
        console.error(`Unknown merge target: ${target}. Valid options: all, config, jobs, soul`);
        process.exit(1);
    }
  });

// Command: link
program
  .command('link [target]')
  .description('Link shared resources: all, skills, plugins, or hermes')
  .action((target, cmdOpts) => {
    const opts = getOptions(cmdOpts);
    switch (target || 'all') {
      case 'all': {
        // linkAll captures its failures into linkErrors (it does not throw),
        // so report them through finishLinkErrors rather than a try/catch.
        const result = linkAll(opts);
        if (result.linkErrors.length > 0) {
          finishLinkErrors(result.linkErrors);
        }
        if (!program.opts().quiet) {
          console.log('\u2713 Linked skills and plugins for all profiles');
        }
        break;
      }
      case 'skills':
        safeLink('Linked common skills to all profiles', () => linkSkills(opts));
        break;
      case 'plugins':
        safeLink('Linked common plugins to all profiles and ~/.hermes/plugins', () => linkPlugins(opts));
        break;
      case 'hermes':
        safeLink('Linked Hermes profiles to the Hermes home directory', () => linkHermes(opts));
        break;
      default:
        console.error(`Unknown link target: ${target}. Valid options: all, skills, plugins, hermes`);
        process.exit(1);
    }
  });

// Direct aliases matching Make targets for seamless migration
program
  .command('config-merge')
  .description('Alias for "merge config"')
  .action((cmdOpts) => {
    finishMerge('Merged config for all profiles', () => [mergeConfig(getOptions(cmdOpts))]);
  });

program
  .command('jobs-merge')
  .description('Alias for "merge jobs"')
  .action((cmdOpts) => {
    finishMerge('Merged jobs for all profiles', () => [mergeJobs(getOptions(cmdOpts))]);
  });

program
  .command('soul-merge')
  .description('Alias for "merge soul"')
  .action((cmdOpts) => {
    finishMerge('Merged SOUL for all profiles', () => [mergeSoul(getOptions(cmdOpts))]);
  });

program
  .command('skills-link')
  .description('Alias for "link skills"')
  .action((cmdOpts) => {
    safeLink('Linked common skills to all profiles', () => linkSkills(getOptions(cmdOpts)));
  });

program
  .command('plugins-link')
  .description('Alias for "link plugins"')
  .action((cmdOpts) => {
    safeLink('Linked common plugins to all profiles and ~/.hermes/plugins', () => linkPlugins(getOptions(cmdOpts)));
  });

program
  .command('hermes-link')
  .description('Alias for "link hermes"')
  .action((cmdOpts) => {
    safeLink('Linked Hermes profiles to the Hermes home directory', () => linkHermes(getOptions(cmdOpts)));
  });

program
  .command('merge-all')
  .description('Alias for "sync"')
  .action((cmdOpts) => {
    // Same contract as `sync`: syncAll never throws, so the merge results are
    // always reported together with any link failure.
    const result = syncAll(getOptions(cmdOpts));
    finishSync(
      'Merged config, jobs, and SOUL, and linked skills and plugins for all profiles',
      [result.config, result.jobs, result.soul],
      result.linkErrors,
      result.syncError
    );
  });

program.parse();
