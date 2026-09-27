import fs from 'node:fs';
import path from 'node:path';
import { syncAll, SyncAllResult } from './sync.js';
import { validateProfileName, assertProfilePathInWorkspace } from '../utils/profile-name.js';

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

/**
 * Thrown when a filesystem operation during init scaffolding fails
 * (EEXIST collision, EACCES permission, EISDIR, ENOSPC, ...).
 *
 * Profile-name validation failures ({@link validateProfileName}) throw a
 * plain `Error` with the `Invalid profile name:` prefix; this typed error is
 * the UNAMBIGUOUS marker for every other, non-validation failure. The CLI's
 * `init` handler branches on it so a filesystem errno is never mislabeled as
 * "invalid profile name".
 */
export class InitFilesystemError extends Error {
  /** Workspace-relative path of the offending file or directory. */
  readonly targetPath: string;
  /** The filesystem operation that failed ('mkdir' | 'writeFile'). */
  readonly operation: string;

  constructor(relativePath: string, operation: string, cause: Error) {
    super(`Failed to ${operation} ${relativePath}: ${cause.message}`, { cause });
    this.name = 'InitFilesystemError';
    this.targetPath = relativePath;
    this.operation = operation;
  }
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
  // The shared allowlist `^[a-zA-Z0-9._-]+$` plus the explicit `.`/`..`
  // guard rejects every known traversal vector.
  validateProfileName(profileName);

  const profilesDir = path.join(targetDir, 'profiles');
  const commonDir = path.join(profilesDir, 'common');
  const profileDir = path.join(profilesDir, profileName);

  // Defense in depth: assert the resolved profile directory stays under
  // profilesDir. The allowlist above already guarantees this, but this
  // catches any future path-construction changes that might bypass it.
  assertProfilePathInWorkspace(profilesDir, profileDir);

  const createdFiles: string[] = [];
  const skippedFiles: string[] = [];

  // Wrap a raw filesystem errno (EEXIST, EACCES, EISDIR, ENOSPC, ...) into
  // an InitFilesystemError naming the offending workspace-relative path.
  // Without this, a raw NodeJS.ErrnoException escapes initWorkspace with no
  // context about WHICH scaffolding file failed, and the CLI used to label
  // every init throw as an "invalid profile name" (which is factually wrong
  // for a filesystem collision/permission/disk-full condition).
  function failFs(
    relativePath: string,
    operation: 'mkdir' | 'writeFile',
    err: unknown
  ): never {
    throw new InitFilesystemError(relativePath, operation, err as Error);
  }

  function ensureFile(filePath: string, content: string): void {
    const relPath = path.relative(targetDir, filePath);
    const dir = path.dirname(filePath);

    // A path that exists as something OTHER than a regular file (a directory,
    // a symlink to a directory, a device node, ...) is NOT a legitimate
    // "existing file": existsSync would silently skip it, and writeFileSync
    // would then fail with a bare EISDIR far from the cause. Report it up
    // front with the offending path instead — in dry-run too, since the
    // preview must surface the same collision a real run would hit.
    if (fs.existsSync(filePath) && !fs.statSync(filePath).isFile()) {
      failFs(relPath, 'writeFile', {
        name: 'EISDIR',
        code: 'EISDIR',
        message: 'EISDIR: is a directory (a non-file exists at the scaffolding path)'
      } as NodeJS.ErrnoException);
    }

    // The exists/!force skip contract applies to dry-run as well: an
    // existing file (without force) is skipped, never reported as a
    // would-be create. Otherwise `init --dry-run` on a pre-seeded
    // workspace would list every existing file under `createdFiles`
    // ("Would create") and the CLI's "Files to create" count would
    // overstate what a real run would actually create.
    if (fs.existsSync(filePath) && !force) {
      skippedFiles.push(filePath);
      return;
    }

    if (dryRun) {
      // Record the would-be creation without touching the disk (neither
      // the parent directories nor the file itself).
      createdFiles.push(filePath);
      log(`Would create: ${relPath}`);
      return;
    }

    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (err) {
      failFs(path.relative(targetDir, dir), 'mkdir', err);
    }

    try {
      fs.writeFileSync(filePath, content, 'utf8');
    } catch (err) {
      failFs(relPath, 'writeFile', err);
    }
    createdFiles.push(filePath);
    log(`Created: ${relPath}`);
  }

  // Common scaffolding
  ensureFile(path.join(commonDir, 'config.yaml'), DEFAULT_COMMON_CONFIG);
  ensureFile(path.join(commonDir, 'SOUL.md'), DEFAULT_COMMON_SOUL);

  // Common directories
  if (!dryRun) {
    for (const subDir of ['skills', 'plugins']) {
      const dirPath = path.join(commonDir, subDir);
      try {
        fs.mkdirSync(dirPath, { recursive: true });
      } catch (err) {
        failFs(path.relative(targetDir, dirPath), 'mkdir', err);
      }
    }
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
