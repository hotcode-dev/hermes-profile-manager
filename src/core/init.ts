import fs from 'node:fs';
import path from 'node:path';
import { syncAll, SyncAllResult } from './sync.js';

export interface InitOptions {
  targetDir?: string;
  profileName?: string;
  force?: boolean;
  runSync?: boolean;
  /**
   * When true, no filesystem side effects are made: the scaffolding files
   * and directories are only recorded (in `createdFiles`) and the initial
   * sync is skipped. Mirrors the side-effect-free `dryRun` contract of the
   * merge and link steps.
   */
  dryRun?: boolean;
  logger?: (msg: string) => void;
}

export interface InitResult {
  targetDir: string;
  profileName: string;
  createdFiles: string[];
  skippedFiles: string[];
  syncResult?: SyncAllResult;
}

const DEFAULT_COMMON_CONFIG = `# Common Hermes Configuration
# Inherited by all profiles. Profiles can override keys in config.custom.yaml.
model: "openai/gpt-4o"
temperature: 0.7
max_tokens: 4096
`;

const DEFAULT_COMMON_SOUL = `# Hermes Agent - Shared Guidelines

You are an autonomous AI assistant powered by Hermes Agent.
- Read instructions carefully and understand the requirements before taking action.
- Write clean, type-safe, and well-tested code.
- Verify your changes thoroughly before finishing tasks.
`;

const DEFAULT_CUSTOM_CONFIG = `# Profile Custom Configuration Overrides
# Values defined here override profiles/common/config.yaml
`;

const DEFAULT_CUSTOM_SOUL = (name: string) => `# ${name.charAt(0).toUpperCase() + name.slice(1)} Agent Identity

You are the ${name} agent. Focus on your assigned tasks, maintain context, and collaborate effectively.
`;

const DEFAULT_CUSTOM_JOBS = JSON.stringify({
  jobs: []
}, null, 2) + '\n';

/**
 * Initializes a new Hermes agent profile workspace:
 * - profiles/common/config.yaml
 * - profiles/common/SOUL.md
 * - profiles/common/skills/
 * - profiles/common/plugins/
 * - profiles/<profileName>/config.custom.yaml
 * - profiles/<profileName>/SOUL.custom.md
 * - profiles/<profileName>/cron/jobs.custom.json
 */
export function initWorkspace(options: InitOptions = {}): InitResult {
  const targetDir = path.resolve(options.targetDir || process.cwd());
  // An explicit `profileName` (even an empty string) is always honored and
  // validated; only an absent (undefined/null) name falls back to 'main'.
  // (Previously `|| 'main'` silently swallowed an empty-string name.)
  const profileName = (options.profileName ?? 'main').trim();
  const log = options.logger || console.log;
  const force = Boolean(options.force);
  const runSync = options.runSync !== false;
  const dryRun = Boolean(options.dryRun);

  // Validate profileName before it is used in any path construction.
  // A name containing path separators (`/`, `\`) or `.`/`..` segments would
  // cause path.join to resolve the profile dir OUTSIDE of profilesDir,
  // letting scaffolding files be written outside the target workspace.
  // The allowlist `^[a-zA-Z0-9._-]+$` plus the explicit `.`/`..` guard
  // rejects every known traversal vector.
  if (
    !profileName ||
    profileName === '.' ||
    profileName === '..' ||
    profileName.includes('/') ||
    profileName.includes('\\') ||
    !/^[a-zA-Z0-9._-]+$/.test(profileName)
  ) {
    throw new Error(
      `Invalid profile name: "${profileName}" — must be a single path-safe segment ` +
      `(letters, digits, dots, hyphens, underscores)`
    );
  }

  const profilesDir = path.join(targetDir, 'profiles');
  const commonDir = path.join(profilesDir, 'common');
  const profileDir = path.join(profilesDir, profileName);

  // Defense in depth: assert the resolved profile directory stays under
  // profilesDir. The allowlist above already guarantees this, but this
  // catches any future path-construction changes that might bypass it.
  const resolvedProfilesDir = path.resolve(profilesDir);
  const resolvedProfileDir = path.resolve(profileDir);
  if (!resolvedProfileDir.startsWith(resolvedProfilesDir + path.sep)) {
    throw new Error(
      `Profile directory "${resolvedProfileDir}" escapes the workspace boundary "${resolvedProfilesDir}"`
    );
  }

  const createdFiles: string[] = [];
  const skippedFiles: string[] = [];

  function ensureFile(filePath: string, content: string): void {
    // Dry-run: record the would-be creation without touching the disk
    // (neither the parent directories nor the file itself).
    if (dryRun) {
      createdFiles.push(filePath);
      log(`Would create: ${path.relative(targetDir, filePath)}`);
      return;
    }

    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });

    if (fs.existsSync(filePath) && !force) {
      skippedFiles.push(filePath);
      return;
    }

    fs.writeFileSync(filePath, content, 'utf8');
    createdFiles.push(filePath);
    log(`Created: ${path.relative(targetDir, filePath)}`);
  }

  // Common scaffolding
  ensureFile(path.join(commonDir, 'config.yaml'), DEFAULT_COMMON_CONFIG);
  ensureFile(path.join(commonDir, 'SOUL.md'), DEFAULT_COMMON_SOUL);

  // Common directories
  if (!dryRun) {
    fs.mkdirSync(path.join(commonDir, 'skills'), { recursive: true });
    fs.mkdirSync(path.join(commonDir, 'plugins'), { recursive: true });
  }

  // Initial profile scaffolding
  ensureFile(path.join(profileDir, 'config.custom.yaml'), DEFAULT_CUSTOM_CONFIG);
  ensureFile(path.join(profileDir, 'SOUL.custom.md'), DEFAULT_CUSTOM_SOUL(profileName));
  ensureFile(path.join(profileDir, 'cron', 'jobs.custom.json'), DEFAULT_CUSTOM_JOBS);

  const result: InitResult = {
    targetDir,
    profileName,
    createdFiles,
    skippedFiles
  };

  if (runSync && !dryRun) {
    log('\nRunning initial sync to compile profile configurations...');
    // syncAll records per-profile merge failures as `status: 'error'` entries
    // in the returned arrays and captures link failures into
    // `result.linkErrors` (it does not abort on those), so the result here is
    // the failure signal: the CLI inspects it to gate the success banner and
    // exit code, matching the `sync` / `merge-all` contract.
    //
    // Skipped under dryRun: the scaffolding files above were NOT written to
    // disk, so the sources the sync reads (profiles/common/config.yaml,
    // profiles/common/SOUL.md, profiles/<p>/config.custom.yaml, ...) do not
    // exist yet — running the sync would both fail those preconditions AND
    // violate the side-effect-free dry-run contract by writing compiled
    // outputs (config.yaml, cron/jobs.json, SOUL.md, symlinks). The dry-run
    // is a pure preview: it reports the would-be scaffold and stops.
    result.syncResult = syncAll({
      rootDir: targetDir,
      logger: log
    });
  } else if (dryRun && runSync) {
    log('\nDry run: initial sync skipped (no files were written to disk).');
  }

  return result;
}
