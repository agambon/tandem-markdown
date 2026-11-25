// Which backups are deleted at activation: by age, and past the newest of those the user was told
// of and of those kept with nothing said, each counted apart.

import { describe, expect, it } from 'vitest';
import {
  BACKUP_MAX_AGE_DAYS,
  BACKUP_MAX_COUNT,
  QUIET_MAX_COUNT,
  backupsToDelete,
} from '../../../src/host/model/backupPrune';

const NOW = Date.UTC(2026, 10, 17, 12);
const DAY = 24 * 60 * 60 * 1000;

/** `count` backups, newest first, a minute apart. */
function files(count: number, quiet: boolean, from = NOW): { id: string; mtime: number; quiet: boolean }[] {
  return Array.from({ length: count }, (_, i) => ({ id: `${quiet ? 'q' : 't'}${i}`, mtime: from - i * 60_000, quiet }));
}

const newestFirst = <T extends { mtime: number }>(list: T[]) => [...list].sort((a, b) => b.mtime - a.mtime);

describe('which backups are deleted', () => {
  it('keeps the newest 200 the user was told of, however many copies were kept with nothing said', () => {
    const all = newestFirst([...files(BACKUP_MAX_COUNT, false), ...files(500, true, NOW + 30_000)]);
    const doomed = backupsToDelete(all, (f) => f.quiet, NOW);
    expect(doomed.filter((f) => !f.quiet)).toEqual([]);
    expect(doomed.filter((f) => f.quiet)).toHaveLength(500 - QUIET_MAX_COUNT);
  });

  it('keeps the newest 50 copies kept quietly and the newest 200 told ones, each counted apart', () => {
    const all = newestFirst([...files(BACKUP_MAX_COUNT + 3, false), ...files(QUIET_MAX_COUNT + 2, true)]);
    const doomed = backupsToDelete(all, (f) => f.quiet, NOW);
    expect(doomed.map((f) => f.id).sort()).toEqual(['q50', 'q51', 't200', 't201', 't202']);
  });

  it(`deletes either kind once older than ${BACKUP_MAX_AGE_DAYS} days`, () => {
    const old = NOW - (BACKUP_MAX_AGE_DAYS + 1) * DAY;
    const all = [
      { id: 'told', mtime: NOW, quiet: false },
      { id: 'quiet', mtime: NOW, quiet: true },
      { id: 'old told', mtime: old, quiet: false },
      { id: 'old quiet', mtime: old, quiet: true },
    ];
    expect(backupsToDelete(all, (f) => f.quiet, NOW).map((f) => f.id)).toEqual(['old told', 'old quiet']);
  });

  it('never deletes a backup an open conflict file part names, however old or many', () => {
    const old = NOW - (BACKUP_MAX_AGE_DAYS + 5) * DAY;
    const all = newestFirst([...files(QUIET_MAX_COUNT + 1, true), { id: 'named', mtime: old, quiet: true }]);
    const doomed = backupsToDelete(
      all,
      (f) => f.quiet,
      NOW,
      (f) => f.id === 'named',
    );
    expect(doomed.map((f) => f.id)).toEqual(['q50']);
  });
});
