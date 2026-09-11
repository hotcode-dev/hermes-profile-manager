#!/usr/bin/env node
import { Command } from 'commander';
import { findProjectRoot } from './utils/root-finder.js';
import { mergeConfig } from './core/config.js';
import { mergeJobs } from './core/jobs.js';
import { mergeSoul } from './core/soul.js';
import { linkSkills, linkPlugins, linkHermes } from './core/links.js';
import { mergeAll, linkAll, syncAll } from './core/sync.js';
import { initWorkspace } from './core/init.js';

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
      console.log(`\n✓ Successfully initialized Hermes profiles in ${result.targetDir}`);
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
    syncAll(opts);
    if (!program.opts().quiet) {
      console.log('✓ Synced all Hermes profiles successfully');
    }
  });

// Command: merge
program
  .command('merge [target]')
  .description('Merge profiles resources: all, config, jobs, or soul')
  .action((target, cmdOpts) => {
    const opts = getOptions(cmdOpts);
    switch (target || 'all') {
      case 'all':
        mergeAll(opts);
        if (!program.opts().quiet) {
          console.log('✓ Merged config, jobs, and SOUL for all profiles');
        }
        break;
      case 'config':
        mergeConfig(opts);
        if (!program.opts().quiet) {
          console.log('✓ Merged config for all profiles');
        }
        break;
      case 'jobs':
        mergeJobs(opts);
        if (!program.opts().quiet) {
          console.log('✓ Merged jobs for all profiles');
        }
        break;
      case 'soul':
        mergeSoul(opts);
        if (!program.opts().quiet) {
          console.log('✓ Merged SOUL for all profiles');
        }
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
          console.log('✓ Linked skills and plugins for all profiles');
        }
        break;
      case 'skills':
        linkSkills(opts);
        if (!program.opts().quiet) {
          console.log('✓ Linked common skills to all profiles');
        }
        break;
      case 'plugins':
        linkPlugins(opts);
        if (!program.opts().quiet) {
          console.log('✓ Linked common plugins to all profiles and ~/.hermes/plugins');
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
    mergeConfig(getOptions(cmdOpts));
    if (!program.opts().quiet) console.log('✓ Merged config for all profiles');
  });

program
  .command('jobs-merge')
  .description('Alias for "merge jobs"')
  .action((cmdOpts) => {
    mergeJobs(getOptions(cmdOpts));
    if (!program.opts().quiet) console.log('✓ Merged jobs for all profiles');
  });

program
  .command('soul-merge')
  .description('Alias for "merge soul"')
  .action((cmdOpts) => {
    mergeSoul(getOptions(cmdOpts));
    if (!program.opts().quiet) console.log('✓ Merged SOUL for all profiles');
  });

program
  .command('skills-link')
  .description('Alias for "link skills"')
  .action((cmdOpts) => {
    linkSkills(getOptions(cmdOpts));
    if (!program.opts().quiet) console.log('✓ Linked common skills to all profiles');
  });

program
  .command('plugins-link')
  .description('Alias for "link plugins"')
  .action((cmdOpts) => {
    linkPlugins(getOptions(cmdOpts));
    if (!program.opts().quiet) console.log('✓ Linked common plugins to all profiles and ~/.hermes/plugins');
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
    syncAll(getOptions(cmdOpts));
    if (!program.opts().quiet) {
      console.log('✓ Merged config, jobs, and SOUL, and linked skills and plugins for all profiles');
    }
  });

program.parse();
