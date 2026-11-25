// Calibrated invariant simulation: realistic Claude Code / git / sync-tool actors paired with
// measured real VS Code timings (T1-T11 from Window_Run_2026-11-21.md).
// Checks the 3 real product invariants across thousands of seeded runs:
//   1. No silent loss of unsaved user typing.
//   2. No silent loss of settled external writes outside the ~2 ms save-write gap.
//   3. No doubled markers, full convergence across panel/document/disk, zero gate violations.

import { describe, expect, it } from 'vitest';
import { Rng, SyncWorld, markersIn, safePositions } from './world';

const DEFAULT_RUNS = 2000;
const RUNS = Number(process.env.SIM_RUNS ?? DEFAULT_RUNS);
const FIRST_SEED = Number(process.env.SIM_FIRST ?? 1);
const TRACE = process.env.SIM_TRACE === '1';

const INITIAL_LINES = [
  '# Field notes',
  '',
  'Section alpha opening paragraph.',
  '',
  'Section beta working notes.',
  '',
  'Section gamma closing checklist.',
  '',
];

interface RunResult {
  seed: number;
  failures: string[];
}

async function runSeed(seed: number): Promise<RunResult> {
  const rng = new Rng(seed);
  const w = new SyncWorld({
    text: INITIAL_LINES.join('\n'),
    eol: rng.chance(0.3) ? '\r\n' : '\n',
    autoSave: rng.chance(0.4),
    whenBothChanged: rng.chance(0.25) ? 'keepTheirs' : 'keepMine',
    savesEmptyFirst: rng.chance(0.4),
    // Real VS Code T2 reload timing: 78-152 ms.
    vsReloadDelayMs: 80 + rng.int(75),
    watcherDelayMs: 10 + rng.int(30),
  });

  await w.settle();

  let seq = 0;
  const origin = new Map<string, 'user' | 'outside'>();
  const explicitlyRemoved = new Set<string>();
  const wroteDuringSave = new Set<string>();
  const makeMarker = (who: 'user' | 'outside'): string => {
    const m = `⟦${++seq}⟧`;
    origin.set(m, who);
    return m;
  };

  // Track any markers intentionally removed by user delete/undo or by a subsequent outside rewrite.
  const steps = 10 + rng.int(12);
  const trace: string[] = [];
  for (let step = 0; step < steps; step++) {
    const roll = rng.next();
    if (roll < 0.28) {
      // User types in the rich panel.
      const panel = w.panels[0]!;
      const text = panel.text ?? '';
      const pos = rng.pick(safePositions(text));
      const m = makeMarker('user');
      panel.type(pos, ` ${m} `);
      if (rng.chance(0.5)) void panel.sync.flush();
      if (TRACE) trace.push(`t=${w.clock.now()} panel ${m} at ${pos}`);
    } else if (roll < 0.5) {
      // User types in VS Code's text editor (Source).
      const text = w.doc.lf;
      const pos = rng.pick(safePositions(text));
      const m = makeMarker('user');
      w.editInSource({ from: pos, to: pos, insert: ` ${m} ` });
      if (TRACE) trace.push(`t=${w.clock.now()} source ${m} at ${pos}`);
    } else if (roll < 0.78) {
      // Realistic external actor (Claude Code / sync tool / git): reads current disk and edits a line.
      const disk = w.disk.textLenient();
      if (disk !== null) {
        const lines = disk.split('\n');
        const idx = rng.int(lines.length);
        const m = makeMarker('outside');
        if (w.doc.saving) wroteDuringSave.add(m);
        if (rng.chance(0.65)) {
          // Insert or append on a line (non-destructive edit).
          lines[idx] = `${lines[idx]} ${m}`;
        } else {
          // Insert a new line.
          lines.splice(idx, 0, `agent ${m}`);
        }
        w.writeOutside(lines.join('\n'));
        if (TRACE) trace.push(`t=${w.clock.now()} outside ${m} line=${idx} saving=${w.doc.saving}`);
      }
    } else if (roll < 0.92) {
      // User saves (explicit or occasional Save without Formatting).
      const kind = rng.chance(0.1) ? 'noFormat' : 'explicit';
      if (kind === 'noFormat') {
        // Any outside write currently pending on disk without willSave is outside the save-step promise.
        const disk = w.disk.textLenient() ?? '';
        for (const m of markersIn(disk)) {
          if (origin.get(m) === 'outside' && !w.doc.lf.includes(m)) wroteDuringSave.add(m);
        }
      }
      w.save(kind);
      if (TRACE) trace.push(`t=${w.clock.now()} save(${kind}) dirty=${w.doc.dirty}`);
    } else if (roll < 0.97) {
      // User undoes in Source: any user marker removed by undo was intentionally removed.
      const before = markersIn(w.doc.lf);
      if (w.doc.history('undo')) {
        const after = new Set(markersIn(w.doc.lf));
        for (const m of before) if (!after.has(m)) explicitlyRemoved.add(m);
        if (TRACE) trace.push(`t=${w.clock.now()} undo removed=${before.filter((m) => !after.has(m)).join(',')}`);
      }
    } else {
      // Window focus or EOL flip.
      if (rng.chance(0.5)) {
        w.coordinator.windowFocused();
        if (TRACE) trace.push(`t=${w.clock.now()} focus`);
      } else {
        const cur = w.disk.textLenient();
        if (cur !== null) w.writeOutside(cur, w.doc.eol === '\n' ? '\r\n' : '\n');
        if (TRACE) trace.push(`t=${w.clock.now()} eol-flip`);
      }
    }

    // Advance realistic time between human/agent actions (40 ms to 700 ms).
    await w.advance(40 + rng.int(660));
  }

  // Final settle and save.
  w.doc.autoSave = false;
  await w.settle();
  await w.saveAndSettle('explicit');

  const failures: string[] = [];
  const docText = w.doc.lf;
  const diskText = w.disk.textLenient() ?? '';
  const panelText = w.panels[0]!.text ?? '';

  // Invariant 3a: Convergence and zero DocumentGate/error violations.
  if (panelText !== docText) failures.push('panel and document diverged');
  if (w.coordinator.inspect().text !== docText) failures.push('coordinator session and document diverged');
  if (diskText !== docText) failures.push('disk and document diverged after final save');
  if (w.doc.dirty) failures.push('document remained dirty after final save');
  if (w.doc.violations.length > 0) failures.push(`gate violations: ${w.doc.violations.join('; ')}`);
  const errorLogs = w.logs.filter((l) => l.level === 'error');
  if (errorLogs.length > 0) failures.push(`error logs: ${errorLogs.map((l) => l.message).join('; ')}`);

  // Invariant 3b: No doubled markers.
  const counts = new Map<string, number>();
  for (const m of markersIn(diskText)) counts.set(m, (counts.get(m) ?? 0) + 1);
  for (const [m, count] of counts) {
    if (count > 1) failures.push(`marker ${m} (${origin.get(m)}) appeared ${count} times`);
  }

  // Invariants 1 & 2: No silent loss of user typing or settled external writes.
  for (const [m, who] of origin) {
    if (counts.has(m) || explicitlyRemoved.has(m)) continue;
    if (who === 'outside' && wroteDuringSave.has(m)) continue;
    if (w.isPreservedInBackupOrNotice(m)) continue;
    failures.push(`${who} marker ${m} was silently lost (not in final file, backup, or notice)`);
  }

  if (TRACE && failures.length > 0) {
    console.log(
      `SEED ${seed} (prefer=${w.prefer} autoSave=${w.doc.autoSave} savesEmpty=${w.disk.savesEmptyFirst}):\n` +
        trace.join('\n') +
        '\nDEBUG:\n' +
        w.debugLines.join('\n') +
        '\nSAVES: ' +
        JSON.stringify(w.doc.saves) +
        '\nNOTICES: ' +
        JSON.stringify(w.notices.map((n) => n.kind)) +
        '\nBACKUPS: ' +
        JSON.stringify(
          [...w.disk.backups.entries()].map(([p, b]) => [
            p,
            b.deleted,
            b.label,
            new TextDecoder().decode(b.bytes).replace(/\n/g, '\\n'),
          ]),
        ) +
        '\nFINAL:\n' +
        diskText,
    );
  }
  return { seed, failures };
}

describe('calibrated sync invariants', () => {
  it(
    `holds all 3 invariants across ${RUNS} seeded runs (starting at seed ${FIRST_SEED})`,
    async () => {
      const broken: RunResult[] = [];
      for (let i = 0; i < RUNS; i++) {
        const res = await runSeed(FIRST_SEED + i);
        if (res.failures.length > 0) {
          broken.push(res);
          if (broken.length >= 5) break;
        }
      }
      expect(broken).toEqual([]);
    },
    Math.max(30_000, RUNS * 20),
  );
});
