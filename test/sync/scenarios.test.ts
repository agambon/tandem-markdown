// 20 real-world synchronization scenarios covering outside-change, merge, and save flows.

import { describe, expect, it } from 'vitest';
import { type SaveStepCount } from '../../src/core/reconcile/types';
import { SyncWorld } from './world';

const BASE = '# Notes\n\nFirst paragraph.\n\nSecond paragraph.\n\nThird paragraph.\n';

describe('real-world sync scenarios', () => {
  it('1. clean note follows external edit silently and keeps a quiet beforeRemoval backup', async () => {
    const w = new SyncWorld({ text: BASE });
    await w.settle();

    const updated = BASE.replace('Second paragraph.', 'Second paragraph updated by Claude.');
    w.writeOutside(updated);
    await w.settle();

    expect(w.doc.lf).toBe(updated);
    expect(w.doc.dirty).toBe(false);
    expect(w.inSync()).toBe(true);
    expect(w.notices).toEqual([]);
    expect(w.disk.quietCopies().some((q) => q.text === BASE)).toBe(true);
  });

  it('2. clean content with dirty flag on still follows external edit cleanly', async () => {
    const w = new SyncWorld({ text: BASE, vsReloadDelayMs: null });
    await w.settle();

    // User edits then edits right back to exact BASE text (VS Code dirty flag still true).
    w.editInSource({ from: 0, to: 0, insert: 'x' });
    await w.pump();
    w.editInSource({ from: 0, to: 1, insert: '' });
    await w.pump();
    expect(w.doc.dirty).toBe(true);
    expect(w.doc.lf).toBe(BASE);

    const updated = BASE.replace('Third paragraph.', 'Third paragraph by agent.');
    w.writeOutside(updated);
    await w.settle();

    expect(w.doc.lf).toBe(updated);
    expect(w.inSync()).toBe(true);
    expect(w.notices).toEqual([]);
  });

  it('3. first keystroke to a clean note during the 0-51 ms dirty-only delay never loses typing', async () => {
    const w = new SyncWorld({ text: BASE, vsReloadDelayMs: null });
    await w.settle();

    // Source first edit arrives with dirty=false; dirtyOnly(true) is queued right behind it in toExt.
    w.editInSource({ from: BASE.indexOf('First'), to: BASE.indexOf('First'), insert: 'MY_FIRST_KEY ' });
    // Deliver ONLY the text change event (dirty=false), holding back the dirty-only event for a beat.
    w.doc.deliverToExt();
    // Concurrent external edit hits disk while dirty-only event has not yet arrived!
    w.writeOutside(BASE.replace('Third paragraph.', 'Third paragraph by agent.'));
    await w.settle();

    expect(w.doc.lf).toContain('MY_FIRST_KEY First paragraph.');
    expect(w.inSync()).toBe(true);
    // Either merged cleanly or safely handed off with backup (never silently dropped!).
    const agentPreserved =
      w.doc.lf.includes('Third paragraph by agent.') || w.isPreservedInBackupOrNotice('Third paragraph by agent.');
    expect(agentPreserved).toBe(true);
  });

  it('4. dirty note merges disjoint external edit cleanly with zero pop-ups', async () => {
    const w = new SyncWorld({ text: BASE });
    await w.settle();

    w.panels[0]!.type(BASE.indexOf('First paragraph.'), 'My ');
    await w.advance(500);
    expect(w.doc.lf).toContain('My First paragraph.');

    w.writeOutside(BASE.replace('Third paragraph.', 'Agent third paragraph.'));
    await w.settle();

    expect(w.doc.lf).toContain('My First paragraph.');
    expect(w.doc.lf).toContain('Agent third paragraph.');
    expect(w.inSync()).toBe(true);
    expect(w.notices).toEqual([]);
  });

  it('5. overlapping clash under keepMine keeps user words, merges disjoint edits, supports Use Change from Disk and Undo', async () => {
    const w = new SyncWorld({ text: BASE, whenBothChanged: 'keepMine' });
    await w.settle();

    const pos = BASE.indexOf('First paragraph.');
    w.editInSource({ from: pos, to: pos + 'First paragraph.'.length, insert: 'My first draft.' });
    await w.pump();

    const diskEdit = BASE.replace('First paragraph.', 'Claude first draft.').replace(
      'Third paragraph.',
      'Claude third edit.',
    );
    w.writeOutside(diskEdit);
    await w.settle();

    expect(w.doc.lf).toContain('My first draft.');
    expect(w.doc.lf).toContain('Claude third edit.');
    expect(w.inSync()).toBe(true);
    const conflict = w.notices.find((n) => n.kind === 'conflict');
    expect(conflict).toBeDefined();
    if (conflict?.kind !== 'conflict') return;
    expect(conflict.reason).toBe('clash');
    expect(conflict.restMerged).toBe(true);
    expect(conflict.choice).toBe('use');
    expect(conflict.passages).toHaveLength(1);

    // User adds a new edit elsewhere, then presses "Use Change from Disk".
    const tail = w.doc.lf.length;
    w.editInSource({ from: tail, to: tail, insert: '\nExtra user line.\n' });
    await w.pump();

    const usePromise = w.coordinator.useFileVersion(conflict.id);
    await w.settle();
    expect(await usePromise).toBe(true);
    expect(w.doc.lf).toContain('Claude first draft.');
    expect(w.doc.lf).toContain('Extra user line.');

    // Pressing Undo reverts the clash back to user's words while keeping Extra user line.
    const applied = w.notices.find((n) => n.kind === 'applied');
    expect(applied?.kind).toBe('applied');
    if (applied?.kind !== 'applied') return;
    const undoPromise = w.coordinator.undoUsed(applied.id);
    await w.settle();
    expect(await undoPromise).toBe(true);
    expect(w.doc.lf).toContain('My first draft.');
    expect(w.doc.lf).toContain('Extra user line.');
  });

  it('6. overlapping clash under keepTheirs applies disk words, backs up user text, and supports Undo', async () => {
    const w = new SyncWorld({ text: BASE, whenBothChanged: 'keepTheirs' });
    await w.settle();

    const pos = BASE.indexOf('First paragraph.');
    w.editInSource({ from: pos, to: pos + 'First paragraph.'.length, insert: 'User sentence.' });
    await w.pump();

    w.writeOutside(BASE.replace('First paragraph.', 'Disk sentence.'));
    await w.settle();

    expect(w.doc.lf).toContain('Disk sentence.');
    expect(w.inSync()).toBe(true);
    const applied = w.notices.find((n) => n.kind === 'applied');
    expect(applied?.kind).toBe('applied');
    if (applied?.kind !== 'applied') return;
    expect(applied.how).toBe('setting');
    expect(applied.canUndo).toBe(true);
    expect(w.isPreservedInBackupOrNotice('User sentence.')).toBe(true);

    const undoPromise = w.coordinator.undoUsed(applied.id);
    await w.settle();
    expect(await undoPromise).toBe(true);
    expect(w.doc.lf).toContain('User sentence.');
  });

  it('7. both sides insert distinct lines at the exact same gap and keep both cleanly', async () => {
    const start = 'top\nbottom\n';
    const w = new SyncWorld({ text: start });
    await w.settle();

    w.editInSource({ from: 4, to: 4, insert: 'user item\n' });
    await w.pump();
    w.writeOutside('top\nagent item\nbottom\n');
    await w.settle();

    expect(w.doc.lf).toContain('user item\n');
    expect(w.doc.lf).toContain('agent item\n');
    expect(w.notices).toEqual([]);
  });

  it('8. auto-save with rapid interleaved external edits converges without dropping or doubling text', async () => {
    const w = new SyncWorld({ text: BASE, autoSave: true });
    await w.settle();

    w.editInSource({ from: BASE.indexOf('First'), to: BASE.indexOf('First'), insert: 'U1 ' });
    await w.advance(400);
    w.writeOutside(BASE.replace('Third paragraph.', 'A1 Third paragraph.'));
    await w.advance(1200); // auto-save fires
    w.editInSource({ from: 0, to: 0, insert: 'U2 ' });
    await w.advance(300);
    w.writeOutside(w.disk.textLenient()!.replace('Second paragraph.', 'A2 Second paragraph.'));
    await w.settle();
    await w.saveAndSettle();

    for (const token of ['U1', 'U2', 'A1', 'A2']) {
      expect(w.doc.lf.split(token).length - 1).toBe(1);
    }
    expect(w.disk.textLenient()).toBe(w.doc.lf);
    expect(w.inSync()).toBe(true);
  });

  it('9. save race inside willSave backs up and merges an unnotified external edit before VS Code writes', async () => {
    const w = new SyncWorld({ text: BASE, watcherDelayMs: -1, vsReloadDelayMs: null });
    await w.settle();

    w.editInSource({ from: BASE.indexOf('First'), to: BASE.indexOf('First'), insert: 'User ' });
    await w.pump();

    // External edit lands on disk with NO watcher event yet, right before user presses Ctrl+S.
    w.writeOutside(BASE.replace('Third paragraph.', 'Agent wrote before save.'));
    await w.saveAndSettle('explicit');

    expect(w.doc.lf).toContain('User First paragraph.');
    expect(w.doc.lf).toContain('Agent wrote before save.');
    expect(w.disk.textLenient()).toBe(w.doc.lf);
    expect(w.notices).toEqual([]);
  });

  it('10. post-didSave external revert to pre-save base is followed rather than ignored as noop', async () => {
    const w = new SyncWorld({ text: BASE, watcherDelayMs: -1, vsReloadDelayMs: null });
    await w.settle();

    const edited = BASE.replace('First paragraph.', 'Saved paragraph.');
    w.editInSource({
      from: BASE.indexOf('First paragraph.'),
      to: BASE.indexOf('First paragraph.') + 'First paragraph.'.length,
      insert: 'Saved paragraph.',
    });
    await w.pump();

    // Trigger save and wait until VS Code writes `edited` and queues didSave, then immediately
    // revert disk back to BASE before didSave's disk read runs.
    w.save('explicit');
    await w.advance(10);
    // Let write complete, then overwrite disk back to BASE before didSave's check finishes.
    w.writeOutside(BASE);
    await w.settle();

    expect(w.doc.lf).toBe(BASE);
    expect(w.disk.quietCopies().some((q) => q.text === edited)).toBe(true);
  });

  it('11. Save without Formatting (no willSave) advances base cleanly on didSave', async () => {
    const w = new SyncWorld({ text: BASE });
    await w.settle();

    w.editInSource({ from: BASE.indexOf('First'), to: BASE.indexOf('First'), insert: 'NoFmt ' });
    await w.saveAndSettle('noFormat');

    expect(w.coordinator.inspect().base).toContain('NoFmt First paragraph.');
    expect(w.notices).toEqual([]);
  });

  it('12. mid-write truncated file recovers on its single 750 ms retry and merges cleanly', async () => {
    const w = new SyncWorld({ text: BASE, vsReloadDelayMs: null });
    await w.settle();

    w.editInSource({ from: BASE.indexOf('First'), to: BASE.indexOf('First'), insert: 'Mine ' });
    await w.pump();

    // Program starts writing (leaves file truncated mid-line), then finishes 400 ms later.
    w.writeOutside(BASE.slice(0, 22));
    await w.advance(400);
    w.writeOutside(BASE.replace('Third paragraph.', 'Finished write.'));
    await w.settle();

    expect(w.doc.lf).toContain('Mine First paragraph.');
    expect(w.doc.lf).toContain('Finished write.');
    expect(w.notices).toEqual([]);
  });

  it('13. persistently truncated file hands off on dirty note and emits truncatedFollow on clean note', async () => {
    const dirtyWorld = new SyncWorld({ text: BASE, vsReloadDelayMs: null });
    await dirtyWorld.settle();
    dirtyWorld.editInSource({ from: 0, to: 0, insert: 'Keep me\n' });
    await dirtyWorld.pump();
    dirtyWorld.writeOutside('# Notes\n\nFir');
    await dirtyWorld.settle();

    expect(dirtyWorld.doc.lf).toContain('Keep me\n');
    expect(dirtyWorld.notices.some((n) => n.kind === 'conflict' && n.reason === 'truncated')).toBe(true);

    const cleanWorld = new SyncWorld({ text: BASE, vsReloadDelayMs: null });
    await cleanWorld.settle();
    cleanWorld.writeOutside('# Notes\n\nFir');
    await cleanWorld.settle();

    expect(cleanWorld.doc.lf).toBe('# Notes\n\nFir');
    expect(cleanWorld.notices.some((n) => n.kind === 'truncatedFollow')).toBe(true);
    expect(cleanWorld.disk.quietCopies().some((q) => q.text === BASE)).toBe(true);
  });

  it('14. restart with restored dirty note recovers remembered base when disk matches, or hands off with noBase when changed', async () => {
    // Session 1: user edits and closes without saving (remembered base stamp stays in workspaceState).
    const s1 = new SyncWorld({ text: BASE });
    await s1.settle();
    s1.editInSource({ from: BASE.indexOf('First'), to: BASE.indexOf('First'), insert: 'Restored ' });
    await s1.pump();
    const memory = new Map(s1.memory);
    const dirtyText = s1.doc.lf;

    // Session 2a: disk unchanged while closed -> base recovered -> subsequent disjoint edit merges!
    const s2a = new SyncWorld({ text: dirtyText, diskText: BASE, dirty: true, memory: new Map(memory) });
    await s2a.settle();
    expect(s2a.coordinator.inspect().base).toBe(BASE);
    s2a.writeOutside(BASE.replace('Third paragraph.', 'Merged after restart.'));
    await s2a.settle();
    expect(s2a.doc.lf).toContain('Restored First paragraph.');
    expect(s2a.doc.lf).toContain('Merged after restart.');
    expect(s2a.notices).toEqual([]);

    // Session 2b: disk changed while closed -> noBase Safe Handoff keeps user's restored text intact.
    const changed = BASE.replace('Third paragraph.', 'Changed while closed.');
    const s2b = new SyncWorld({ text: dirtyText, diskText: changed, dirty: true, memory: new Map(memory) });
    await s2b.settle();
    expect(s2b.doc.lf).toBe(dirtyText);
    expect(s2b.notices.some((n) => n.kind === 'conflict' && n.reason === 'noBase' && n.choice === 'replace')).toBe(
      true,
    );
  });

  it('15. git checkout / branch switch on a clean note follows cleanly without any pop-ups', async () => {
    const w = new SyncWorld({ text: BASE });
    await w.settle();

    const otherBranch = '# Completely different branch\n\nNew content here.\n';
    w.writeOutside(otherBranch);
    await w.settle();

    expect(w.doc.lf).toBe(otherBranch);
    expect(w.inSync()).toBe(true);
    expect(w.notices).toEqual([]);
  });

  it('16. closing a clean tab with unapplied panel typing recovers it via typingAtClose and putBack', async () => {
    const w = new SyncWorld({ text: BASE });
    await w.settle();

    // User types in panel and flushes push to coordinator while document close races ahead of applyEdit.
    w.panels[0]!.type(BASE.indexOf('First'), 'URGENT ');
    void w.panels[0]!.sync.flush();
    // Deliver push to coordinator (so unapplied records it) without letting applyEdit reach main thread.
    while (w.panels[0]!.toHost.length > 0) {
      w.coordinator.panelMessage(w.panels[0]!.id, w.panels[0]!.toHost.shift()!.message);
    }
    w.doc.close();
    await w.settle();

    const notice = w.notices.find((n) => n.kind === 'typingAtClose');
    expect(notice?.kind).toBe('typingAtClose');
    if (notice?.kind !== 'typingAtClose') return;
    expect(notice.copy).toContain('URGENT First paragraph.');
    expect(notice.closedText).toBe(BASE);

    // Reopen note and run putBack.
    const reopened = new SyncWorld({ text: BASE });
    await reopened.settle();
    const put = reopened.coordinator.putBack(notice.closedText, notice.copy);
    await reopened.settle();
    expect(await put).toBe('done');
    expect(reopened.doc.lf).toContain('URGENT First paragraph.');
  });

  it('17. locked file reports readStatus false then true; non-UTF and undecodable bytes route safely to encoding handoff', async () => {
    const w = new SyncWorld({ text: BASE, vsReloadDelayMs: null });
    await w.settle();

    w.disk.busyReads = 4;
    w.writeOutside(BASE.replace('Third paragraph.', 'After lock clears.'));
    await w.settle();

    expect(w.notices.some((n) => n.kind === 'readStatus' && !n.ok && n.error === 'busy')).toBe(true);
    expect(w.notices.some((n) => n.kind === 'readStatus' && n.ok)).toBe(true);
    expect(w.doc.lf).toContain('After lock clears.');

    // Invalid UTF-8 bytes leave note untouched and raise an encoding handoff.
    w.writeRawOutside(new Uint8Array([0x80, 0x81, 0x82, 0xfe, 0xff]));
    await w.settle();
    expect(w.notices.some((n) => n.kind === 'conflict' && n.reason === 'encoding')).toBe(true);

    // Non-UTF encoding (`windows1252`) saves quietly on our own saves, then reports an external change.
    const latin = new SyncWorld({
      text: 'cafe\n',
      diskBytes: new Uint8Array([0x63, 0x61, 0x66, 0x65, 0x0a]),
      encoding: 'windows1252',
      vsReloadDelayMs: null,
    });
    await latin.settle();
    latin.editInSource({ from: 0, to: 0, insert: '1 ' });
    await latin.saveAndSettle('explicit');
    expect(latin.notices).toEqual([]);
    latin.writeRawOutside(new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x0a]));
    await latin.settle();
    expect(latin.notices.some((n) => n.kind === 'conflict' && n.reason === 'encoding')).toBe(true);
  });

  it('18. backup failure falls back to in-memory text, multi-tab stays in sync, close with pending notifies, and EOL-only flip is quiet', async () => {
    // 18a. Multi-tab + EOL-only flip.
    const w = new SyncWorld({ text: BASE, eol: '\n', panels: 2 });
    await w.settle();
    w.writeOutside(BASE, '\r\n');
    await w.settle();
    expect(w.inSync()).toBe(true);
    expect(w.notices).toEqual([]);

    // 18b. Backup failure (ENOSPC) still preserves disk text inside conflict notice for unsaved tab fallback.
    w.disk.failBackups = Infinity;
    const pos = BASE.indexOf('First paragraph.');
    w.editInSource({ from: pos, to: pos + 'First paragraph.'.length, insert: 'My line.' });
    await w.pump();
    w.writeOutside(BASE.replace('First paragraph.', 'Disk line.'));
    await w.settle();
    const conflict = w.notices.find((n) => n.kind === 'conflict');
    expect(conflict?.kind).toBe('conflict');
    if (conflict?.kind === 'conflict') {
      expect(conflict.backupPath).toBeNull();
      expect(conflict.diskText).toContain('Disk line.');
    }

    // 18c. Close while outside edit is held emits closedWithPending.
    let hold = true;
    const heldWorld = new SyncWorld({ text: BASE, holdOutside: () => hold, vsReloadDelayMs: null });
    await heldWorld.settle();
    heldWorld.editInSource({ from: 0, to: 0, insert: 'Dirty\n' });
    await heldWorld.pump();
    heldWorld.writeOutside(BASE.replace('Third paragraph.', 'Waiting on hold.'));
    await heldWorld.advance(600);
    heldWorld.doc.close();
    await heldWorld.settle();
    hold = false;
    expect(heldWorld.notices.some((n) => n.kind === 'closedWithPending')).toBe(true);

    // 18d. Repeated event-loop stall past VS Code's 1,500 ms willSave kill threshold warns once via saveCheckOff.
    const steps: SaveStepCount = { counted: 3, warned: false };
    const slow = new SyncWorld({ text: BASE, saveSteps: steps, vsReloadDelayMs: null });
    await slow.settle();
    const p = slow.coordinator.willSave();
    // Simulate event loop blocked for 1,600 ms before timers fire (VS Code's kill threshold).
    (slow.clock as unknown as { t: number }).t += 1600;
    await slow.pump();
    await p;
    expect(slow.notices.some((n) => n.kind === 'saveCheckOff')).toBe(true);
  });

  it('19. typing in the panel inside a just-reloaded clean line before disk recheck never doubles the line', async () => {
    const w = new SyncWorld({ text: BASE, vsReloadDelayMs: 60, watcherDelayMs: 120 });
    await w.settle();

    // Outside agent inserts a new line; VS Code reloads clean doc at t+60 before watcher confirms it.
    const reloaded = BASE.replace('Second paragraph.', 'Agent added line.\n\nSecond paragraph.');
    w.writeOutside(reloaded);
    await w.advance(100);
    expect(w.panels[0]!.text).toContain('Agent added line.');

    // User immediately types inside the freshly reloaded line from the rich panel, then saves.
    const pos = w.panels[0]!.text!.indexOf('added');
    w.panels[0]!.type(pos, 'newly ');
    void w.panels[0]!.sync.flush();
    await w.advance(200);
    await w.saveAndSettle('explicit');

    expect(w.doc.lf).toContain('Agent newly added line.');
    expect(w.doc.lf.match(/Agent/g)).toHaveLength(1);
    expect(w.inSync()).toBe(true);
    expect(w.notices).toEqual([]);
  });

  it('20. typing in Source while a clean save is writing to disk is never reverted by afterSave', async () => {
    const w = new SyncWorld({ text: BASE, vsReloadDelayMs: null });
    await w.settle();

    // Start an explicit save on an already-synced document (base === doc === BASE).
    w.save('explicit');
    await w.advance(5);
    // While VS Code is writing BASE to disk, the user types in Source.
    const at = BASE.indexOf('First');
    w.editInSource({ from: at, to: at, insert: 'NEW ' });
    await w.settle();

    expect(w.doc.lf).toContain('NEW First paragraph.');
    expect(w.doc.dirty).toBe(true);
    expect(w.inSync()).toBe(true);
    expect(w.notices).toEqual([]);
  });
});
