// Which backups are deleted at activation (backups.ts): those older than BACKUP_MAX_AGE_DAYS,
// and those beyond the newest BACKUP_MAX_COUNT. The copies kept with nothing said (the core's
// `beforeRemoval`), written far more often than the backups the user is told of, are counted on
// their own and kept to the newest QUIET_MAX_COUNT, so that they never push those out.

export const BACKUP_MAX_AGE_DAYS = 30;
export const BACKUP_MAX_COUNT = 200;
export const QUIET_MAX_COUNT = 50;

/**
 * The backups to delete, of `files` (newest first). `isQuiet`: a copy kept with nothing said.
 * `isNamed`: a backup an open conflict file part names, which is never deleted and not counted.
 */
export function backupsToDelete<T extends { mtime: number }>(
  files: readonly T[],
  isQuiet: (file: T) => boolean,
  now: number,
  isNamed: (file: T) => boolean = () => false,
): T[] {
  const oldest = now - BACKUP_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  let told = 0;
  let quiet = 0;
  return files.filter((f) => {
    if (isNamed(f)) return false;
    const beyond = isQuiet(f) ? quiet++ >= QUIET_MAX_COUNT : told++ >= BACKUP_MAX_COUNT;
    return beyond || f.mtime < oldest;
  });
}
