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
    const result = syncAll(opts);
    finishWithErrors('Synced all Hermes profiles successfully', result.config, result.jobs, result.soul);
  });

// Command: merge
program
  .command('merge [target]')
  .description('Merge profiles resources: all, config, jobs, or soul')
  .action((target, cmdOpts) => {
    const opts = getOptions(cmdOpts);
    switch (target || 'all') {
      case 'all': {
        const result = mergeAll(opts);
        finishWithErrors('Merged config, jobs, and SOUL for all profiles', result.config, result.jobs, result.soul);
        break;
      }
      case 'config':
        finishWithErrors('Merged config for all profiles', mergeConfig(opts));
        break;
      case 'jobs':
        finishWithErrors('Merged jobs for all profiles', mergeJobs(opts));
        break;
      case 'soul':
        finishWithErrors('Merged SOUL for all profiles', mergeSoul(opts));
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
      case 'all':
        linkAll(opts);
        if (!program.opts().quiet) {
          console.log('\u2713 Linked skills and plugins for all profiles');
        }
        break;
      case 'skills':
        linkSkills(opts);
        if (!program.opts().quiet) {
          console.log('\u2713 Linked common skills to all profiles');
        }
        break;
      case 'plugins':
        linkPlugins(opts);
        if (!program.opts().quiet) {
          console.log('\u2713 Linked common plugins to all profiles and ~/.hermes/plugins');
        }
        break;
      case 'hermes':
        linkHermes(opts);
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
    finishWithErrors('Merged config for all profiles', mergeConfig(getOptions(cmdOpts)));
  });

program
  .command('jobs-merge')
  .description('Alias for "merge jobs"')
  .action((cmdOpts) => {
    finishWithErrors('Merged jobs for all profiles', mergeJobs(getOptions(cmdOpts)));
  });

program
  .command('soul-merge')
  .description('Alias for "merge soul"')
  .action((cmdOpts) => {
    finishWithErrors('Merged SOUL for all profiles', mergeSoul(getOptions(cmdOpts)));
  });

program
  .command('skills-link')
  .description('Alias for "link skills"')
  .action((cmdOpts) => {
    linkSkills(getOptions(cmdOpts));
    if (!program.opts().quiet) console.log('\u2713 Linked common skills to all profiles');
  });

program
  .command('plugins-link')
  .description('Alias for "link plugins"')
  .action((cmdOpts) => {
    linkPlugins(getOptions(cmdOpts));
    if (!program.opts().quiet) console.log('\u2713 Linked common plugins to all profiles and ~/.hermes/plugins');
  });

program
  .command('hermes-link')
  .description('Alias for "link hermes"')
  .action((cmdOpts) => {
    linkHermes(getOptions(cmdOpts));
  });

program
  .command('merge-all')
  .description('Alias for "sync"')
  .action((cmdOpts) => {
    const result = syncAll(getOptions(cmdOpts));
    finishWithErrors(
      'Merged config, jobs, and SOUL, and linked skills and plugins for all profiles',
      result.config, result.jobs, result.soul
    );
  });

program.parse();
