import fs from 'node:fs';
import path from 'node:path';

/**
 * Atomically writes file content by writing to a temp file first and renaming it.
 */
export function atomicWriteFileSync(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
  try {
    fs.writeFileSync(tmpPath, content, 'utf8');
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      if (fs.existsSync(tmpPath)) {
        fs.unlinkSync(tmpPath);
      }
    } catch {
      // Ignore cleanup error
    }
    throw err;
  }
}

export interface EnsureSymlinkOptions {
  /**
   * Logger used for warnings about existing content being preserved.
   * Defaults to console.warn.
   */
  logger?: (msg: string) => void;
}

/**
 * Safely creates or updates a symbolic link.
 *
 * - If linkPath already is a symlink pointing at `target`, this is a no-op.
 * - If linkPath is a symlink pointing elsewhere, it is replaced.
 * - If linkPath is a real (non-symlink) directory, its contents are NEVER
 *   deleted: the directory is moved aside to a backup sibling path
 *   (`<linkPath>.hpm-backup.<timestamp>`) and a warning is logged.
 * - If linkPath is a plain file, it is removed (a single-file collision is
 *   low-risk) and the removal is logged.
 */
export function ensureSymlinkSync(target: string, linkPath: string, options: EnsureSymlinkOptions = {}): void {
  const log = options.logger || console.warn;
  const dir = path.dirname(linkPath);
  fs.mkdirSync(dir, { recursive: true });

  try {
    const lstat = fs.lstatSync(linkPath);
    if (lstat.isSymbolicLink()) {
      const currentTarget = fs.readlinkSync(linkPath);
      if (currentTarget === target) {
        return; // Already points to desired target
      }
      fs.unlinkSync(linkPath);
    } else if (lstat.isDirectory()) {
      // Real directory collision: never delete it, move it aside so its
      // contents are preserved for the user to review.
      const backupPath = uniqueBackupPath(linkPath);
      fs.renameSync(linkPath, backupPath);
      log(`WARNING: ${linkPath} exists as a real directory. It was preserved at ${backupPath} before the symlink was created. Review the backup before deleting it.`);
    } else {
      fs.unlinkSync(linkPath);
      log(`Removed existing file at ${linkPath} to create the symlink.`);
    }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err;
    }
  }

  fs.symlinkSync(target, linkPath);
}

/**
 * Builds a unique backup path beside linkPath, e.g.
 * `<linkPath>.hpm-backup.1730000000000` (with a numeric suffix if needed).
 */
function uniqueBackupPath(linkPath: string): string {
  const base = `${linkPath}.hpm-backup.${Date.now()}`;
  let candidate = base;
  let n = 0;
  while (fs.existsSync(candidate)) {
    n += 1;
    candidate = `${base}.${n}`;
  }
  return candidate;
}

/**
 * Discovers all profile directory names in profilesDir excluding 'common' and hidden dirs.
 */
export function getProfileNames(profilesDir: string): string[] {
  if (!fs.existsSync(profilesDir)) {
    return [];
  }

  return fs.readdirSync(profilesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== 'common' && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort();
}
