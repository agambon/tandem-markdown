// Messages that ask the user something (docs/ARCHITECTURE.md, "Notices and the log"). Each pops up
// once, one at a time (model/messageQueue.ts); one with a choice of its own also stays in a strip at
// the top of its note's rich tabs and in the status bar (conflictViews.ts) until a press settles
// it: a choice that did its work, Dismiss, or any button of the offer of agent instructions. One
// with no strip is settled once its pop-up is gone from the screen. Its words and buttons are its
// form's (model/messageForms.ts), less the buttons that no longer apply, which go with nothing
// said. A conflict's choice is on the title bar of the diff its message opens (DiffChoice), for as
// long as the choice applies, apart from the message. VS Code cannot close or change a pop-up once
// shown: one whose message settled elsewhere stays until VS Code hides it, and a press there still
// runs its button, whose reply says when nothing changed. A reply to a press pops up at once.

import * as vscode from 'vscode';
import type { StripMessage } from '../core/featureProtocol';
import { registerCommand } from './commandRegistration';
import { setContextKey } from './contextKeys';
import { mayBeThere } from './localFiles';
import { log } from './log';
import { VIEW_TYPE } from './model/editorIds';
import { DISMISS, moreWords, type Does, type FormButton, type MessageForm } from './model/messageForms';
import { MessageQueue } from './model/messageQueue';
import { registerPanelMessageHandler } from './panelMessages';
import { panels, type HostPanel } from './panels';
import { PanelValue } from './panelValue';
import { movedUri, sameUri } from './uris';

/** A message that asks the user something, as the code that raises it gives it. */
interface Message {
  readonly id: string;
  /** The note it is about, whose rich tabs show it where it has a strip; null for a message about no note. */
  readonly note: vscode.Uri | null;
  readonly form: MessageForm;
  /** Whether the button that does `does` applies now (Dismiss always does). */
  offers(does: Does): boolean;
  /** Runs the button that does `does` (never Dismiss); resolves true where it did its work. */
  press(does: Does): Promise<boolean>;
  /** Called once, as its pop-up first shows. */
  shown?(): void;
  /** Called once, when it is settled and no pop-up of it can be pressed any more. */
  closed?(): void;
  /** It pops up only while no other message is open, and comes after all others. */
  readonly last?: boolean;
  /** It answers a press: it pops up at once, whatever pop-up is up. */
  readonly reply?: boolean;
}

/**
 * Which button a conflict's choice is on the diff's title bar: Use Change from Disk for a clash
 * (`useClash`) or for a change gone from the file (`useGone`), whose tooltips differ, or Replace My
 * View. Each is its own command in package.json, shown while the diff's left side is a version in
 * its context key (CHOICE_KEYS).
 */
export type DiffButton = 'useClash' | 'useGone' | 'replace';

/** A conflict's choice on the title bar of the diff of its kept version, offered apart from its message. */
export interface DiffChoice {
  readonly id: string;
  readonly button: DiffButton;
  /** The note the conflict is about. */
  readonly note: vscode.Uri;
  /** The diff's left side that shows it: the kept version, where it is now; null while there is none. */
  version(): vscode.Uri | null;
  /** Whether it applies now; once false it stays so, and the choice is let go. */
  offers(): boolean;
  run(): Promise<void>;
}

/**
 * How long VS Code shows a pop-up before it hides it in its notification center, by severity:
 * VS Code's NotificationsToasts.PURGE_TIMEOUT, the same in VS Code 1.120 and 1.146. VS Code counts
 * it from the moment the pop-up shows; at its end it hides the pop-up while the window has focus,
 * and otherwise counts it again from the next focus. It counts again too while the mouse is over
 * the pop-up or the keyboard is in it, which an extension cannot see: then the next pop-up can show
 * while that one is still up.
 */
const HIDDEN_AFTER_MS = { information: 10_000, warning: 12_000 } as const;

/** The context key that lists the versions (`uri.toString()`) whose diff shows each title bar button. */
const CHOICE_KEYS: Record<DiffButton, string> = {
  useClash: 'tandemMarkdown.useClashVersions',
  useGone: 'tandemMarkdown.useGoneVersions',
  replace: 'tandemMarkdown.replaceVersions',
};

/** The command, by its id after `tandemMarkdown.`, that goes to the note whose strip shows the message waiting longest. */
export const SHOW_WAITING_COMMAND = 'showWaitingMessage';

class Messages {
  private readonly queue = new MessageQueue();
  /** The open messages, and settled ones whose pop-up may still be pressed, by id. */
  private readonly byId = new Map<string, Message>();
  /** How many pop-ups of each message are shown and not yet pressed or closed, in view or in VS Code's notification center. */
  private readonly popups = new Map<string, number>();
  /** The counts of the time VS Code shows each pop-up (HIDDEN_AFTER_MS) still running. */
  private readonly hiding = new Set<vscode.Disposable>();
  /** What each open message's strip shows, the same object while it does not change (PanelValue). */
  private readonly strips = new Map<string, StripMessage>();
  /** The button of each message that runs now, or ran last while others wait on it. */
  private readonly running = new Map<string, { does: Does; done: Promise<void> }>();
  /** The note of each open message as it is now, renamed or not, by id. */
  private readonly notes = new Map<string, vscode.Uri>();
  /** The conflicts' choices that may still apply, by id, and those running now. */
  private readonly choices = new Map<string, DiffChoice>();
  private readonly choosing = new Set<string>();
  /** Notes whose next rich tab to go live takes the keyboard to its strip (showWaiting). */
  private readonly focusOnLive = new Set<string>();
  private readonly changed = new vscode.EventEmitter<void>();
  private strip: PanelValue<StripMessage | null> | null = null;

  /** An open message came, settled, or changed its buttons. */
  readonly onDidChange = this.changed.event;

  /** Called once from activate: the strips, the diff's buttons, and the status bar's command. */
  start(): vscode.Disposable {
    const strip = new PanelValue<StripMessage | null>(
      (p) => this.stripFor(p.uri.toString()),
      (shown) => ({ type: 'messages', shown }),
    );
    this.strip = strip;
    const started = vscode.Disposable.from(
      strip,
      registerPanelMessageHandler('messagePressed', (m) => {
        if (typeof m.message === 'string' && typeof m.button === 'string') this.pressedInStrip(m.message, m.button);
      }),
      registerCommand('useChangeFromDisk', () => this.chooseInDiff(['useClash', 'useGone'])),
      registerCommand('replaceMyView', () => this.chooseInDiff(['replace'])),
      registerCommand('useClashChangeButton', () => this.chooseInDiff(['useClash'])),
      registerCommand('useGoneChangeButton', () => this.chooseInDiff(['useGone'])),
      registerCommand('replaceMyViewButton', () => this.chooseInDiff(['replace'])),
      registerCommand(SHOW_WAITING_COMMAND, () => this.showWaiting()),
      panels.onDidBecomeLive((p) => {
        if (this.focusOnLive.delete(p.uri.toString())) this.focusStrip(p);
      }),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.contentChanges.length > 0) this.refresh(e.document.uri);
      }),
      vscode.workspace.onDidCloseTextDocument((d) => this.refresh(d.uri)),
      vscode.window.onDidChangeWindowState((s) => {
        if (s.focused) this.refresh(null);
      }),
      vscode.window.tabGroups.onDidChangeTabs(() => this.setChoiceKeys()),
      vscode.workspace.onDidRenameFiles((e) => this.renamed(e.files)),
      {
        dispose: () => {
          this.strip = null;
          for (const counting of [...this.hiding]) counting.dispose();
        },
      },
    );
    this.update(null);
    return started;
  }

  /** Shows `m`: it pops up now or waits, and, where it has a strip, its note's strips show it in turn. */
  open(m: Message): void {
    this.byId.set(m.id, m);
    if (m.note) this.notes.set(m.id, m.note);
    const queued = { id: m.id, note: m.note?.toString() ?? null, strip: m.form.strip, last: m.last === true };
    if (this.queue.add(queued, m.reply === true)) this.popUp(m, true);
    this.update(m.note);
  }

  /**
   * A reply to a press: shown at once with its buttons and Dismiss, never waiting, and gone at VS
   * Code's own time. A press of one of `actions` runs it.
   */
  reply(
    text: string,
    severity: 'error' | 'warning' | 'information' = 'warning',
    actions: readonly { label: string; run: () => unknown }[] = [],
  ): void {
    const labels = [...actions.map((a) => a.label), DISMISS];
    const shown =
      severity === 'error'
        ? vscode.window.showErrorMessage(text, ...labels)
        : severity === 'information'
          ? vscode.window.showInformationMessage(text, ...labels)
          : vscode.window.showWarningMessage(text, ...labels);
    void Promise.resolve(shown).then(async (label) => {
      const action = actions.find((a) => a.label === label);
      try {
        await action?.run();
      } catch (error) {
        log('error', `The reply's "${label}" failed`, error);
      }
    });
  }

  /** Offers a conflict's choice on its diff's title bar, for as long as it applies. */
  offerChoice(choice: DiffChoice): void {
    this.choices.set(choice.id, choice);
    this.setChoiceKeys();
  }

  /**
   * Shows again which buttons of the open messages and the diff's choices about `note` (every note
   * when null) apply, as after a change to the note or a notice about it: a strip whose buttons
   * changed is drawn again. No message settles here.
   */
  refresh(note: vscode.Uri | null): void {
    if (note !== null && !this.queue.hasNote(note.toString()) && !this.hasChoiceFor(note)) return;
    this.update(note);
  }

  /** The open message the status bar names, with its note: the oldest in a strip. */
  firstWaiting(): { text: string; note: vscode.Uri } | null {
    const first = this.queue.firstWithNote();
    const m = first && this.byId.get(first.id);
    const note = m && this.noteOf(m);
    return m && note ? { text: m.form.text, note } : null;
  }

  /** How many open messages currently wait on a note's strip. */
  waitingCount(): number {
    return this.queue.waitingCount();
  }

  /** The test hook: the open message's text and the buttons in it. */
  askedFor(id: string): { text: string; items: readonly string[] } | undefined {
    const m = this.byId.get(id);
    if (!m || !this.queue.isOpen(id)) return undefined;
    return { text: m.form.text, items: this.offered(m).map((b) => b.label) };
  }

  /**
   * The test hook: presses the open message's button labelled `label`, in its pop-up while that is
   * the one up, else in its strip; false where no such button applies.
   */
  answerNotice(id: string, label: string): boolean {
    const m = this.byId.get(id);
    if (!m || !this.queue.isOpen(id)) return false;
    const b = this.offered(m).find((x) => x.label === label);
    if (!b) return false;
    if (this.queue.upNow() === id && this.popups.has(id)) void this.popupDone(m, b);
    else void this.press(id, b);
    return true;
  }

  /** The test hook: runs the choice of conflict `id` on its diff's title bar; false where it does not apply. */
  async answerChoice(id: string): Promise<boolean> {
    const choice = this.choices.get(id);
    if (!choice || !choice.offers()) return false;
    await this.runChoice(choice);
    return true;
  }

  // ---------------------------------------------------------------------------
  // Pop-ups and presses

  /** Shows a pop-up of `m`: its `first`, or another at the user's asking (showWaiting). */
  private popUp(m: Message, first: boolean): void {
    const buttons = this.offered(m);
    const labels = buttons.map((b) => b.label);
    this.popups.set(m.id, (this.popups.get(m.id) ?? 0) + 1);
    const shown =
      m.form.severity === 'information'
        ? vscode.window.showInformationMessage(m.form.text, ...labels)
        : vscode.window.showWarningMessage(m.form.text, ...labels);
    const counting = this.whenHidden(m);
    void Promise.resolve(shown).then((label) => {
      counting.dispose();
      return this.popupDone(
        m,
        buttons.find((b) => b.label === label),
      );
    });
    if (first) m.shown?.();
  }

  /**
   * Counts the time VS Code shows the pop-up of `m` (HIDDEN_AFTER_MS), as VS Code does: at its end
   * the pop-up is gone from the screen, and the next waiting message pops up.
   */
  private whenHidden(m: Message): vscode.Disposable {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let focus: vscode.Disposable | undefined;
    const counting = new vscode.Disposable(() => {
      clearTimeout(timer);
      focus?.dispose();
      this.hiding.delete(counting);
    });
    const count = (): void => {
      focus?.dispose();
      focus = undefined;
      timer = setTimeout(() => {
        if (!vscode.window.state.focused) {
          focus = vscode.window.onDidChangeWindowState((s) => {
            if (s.focused) count();
          });
          return;
        }
        counting.dispose();
        this.popupGone(m.id);
      }, HIDDEN_AFTER_MS[m.form.severity]);
    };
    this.hiding.add(counting);
    count();
    return counting;
  }

  /** A pop-up was closed by a press of `pressed` or by its X, which leaves a message with a strip in its strip. */
  private async popupDone(m: Message, pressed: FormButton | undefined): Promise<void> {
    const left = this.popups.get(m.id);
    if (left === undefined) return;
    if (left > 1) this.popups.set(m.id, left - 1);
    else this.popups.delete(m.id);
    if (pressed) await this.press(m.id, pressed);
    this.popupGone(m.id);
    this.letGo(m);
  }

  /**
   * The pop-up of `id` is gone from the screen: a message with no strip, which has no other place,
   * is settled, and the next waiting message pops up.
   */
  private popupGone(id: string): void {
    const m = this.byId.get(id);
    if (m && !m.form.strip) this.settle(id);
    this.popNext(this.queue.popupGone(id));
  }

  /** The message the queue popped up, `id`, if any, pops up. */
  private popNext(id: string | null): void {
    const n = id === null ? undefined : this.byId.get(id);
    if (!n) return;
    this.popUp(n, true);
    this.update(this.noteOf(n));
  }

  /** `id` is settled: out of the queue, its strip and the status bar. A pop-up shown for it stays until VS Code hides it. */
  private settle(id: string): void {
    const m = this.byId.get(id);
    if (!m || !this.queue.isOpen(id)) return;
    const note = this.noteOf(m);
    const next = this.queue.settle(id);
    this.strips.delete(id);
    this.notes.delete(id);
    this.letGo(m);
    this.update(note);
    this.popNext(next);
  }

  /** `m` is closed once it is settled and no pop-up of it can be pressed: its code is told. */
  private letGo(m: Message): void {
    if (this.queue.isOpen(m.id) || this.popups.has(m.id) || this.byId.get(m.id) !== m) return;
    this.byId.delete(m.id);
    m.closed?.();
  }

  /**
   * Runs `b`. It settles its message as its form says: always, once it did its work, or never (a
   * look at the diff, wherever it was pressed, leaves the strip and its other buttons). A message
   * settled already runs it all the same, from a pop-up shown before, and its reply says when
   * nothing changed.
   */
  private async press(id: string, b: FormButton): Promise<void> {
    const m = this.byId.get(id);
    if (!m) return;
    if (b.does === 'dismiss') {
      this.settle(id);
      return;
    }
    // One button of a message runs at a time: another waits its turn, the same one again is dropped.
    const before = this.running.get(id);
    if (before?.does === b.does) return;
    const run = (async () => {
      await before?.done;
      let done = false;
      try {
        done = await m.press(b.does);
      } catch (error) {
        log('error', `The message's "${b.label}" failed`, error);
      }
      if (!this.queue.isOpen(id)) return;
      if (b.settles === 'always' || (b.settles === 'done' && done)) this.settle(id);
      else this.refresh(this.noteOf(m));
    })();
    this.running.set(id, { does: b.does, done: run });
    await run;
    if (this.running.get(id)?.done === run) this.running.delete(id);
  }

  /** A button pressed in a strip: one the strip shows, of a message still open. */
  private pressedInStrip(id: string, does: string): void {
    const m = this.byId.get(id);
    if (!m || !this.queue.isOpen(id)) return;
    const b = this.offered(m).find((x) => x.does === does);
    if (b) void this.press(id, b);
  }

  /**
   * A title bar button, or its command: the choice among `buttons` offered in the active diff of the
   * groups', the active group's first.
   */
  private async chooseInDiff(buttons: readonly DiffButton[]): Promise<void> {
    const groups = vscode.window.tabGroups;
    for (const group of [groups.activeTabGroup, ...groups.all.filter((g) => g !== groups.activeTabGroup)]) {
      const input = group.activeTab?.input;
      if (!(input instanceof vscode.TabInputTextDiff)) continue;
      const choice = this.choiceIn(input.original, buttons);
      if (choice) {
        await this.runChoice(choice);
        return;
      }
    }
  }

  /** The choice among `buttons` that applies in a diff whose left side is `version`. */
  private choiceIn(version: vscode.Uri, buttons: readonly DiffButton[]): DiffChoice | undefined {
    for (const choice of this.choices.values()) {
      if (!buttons.includes(choice.button) || !choice.offers()) continue;
      const left = choice.version();
      if (left && left.toString() === version.toString()) return choice;
    }
    return undefined;
  }

  /** Runs `choice`, once at a time; its buttons are worked out again after. */
  private async runChoice(choice: DiffChoice): Promise<void> {
    if (this.choosing.has(choice.id)) return;
    this.choosing.add(choice.id);
    try {
      await choice.run();
    } catch (error) {
      log('error', 'The choice in the diff failed', error);
    } finally {
      this.choosing.delete(choice.id);
      this.refresh(choice.note);
    }
  }

  private hasChoiceFor(note: vscode.Uri): boolean {
    return [...this.choices.values()].some((c) => sameUri(c.note, note));
  }

  /**
   * The status bar's click: the rich tab of the note whose strip waits, opened where none is, its
   * strip given the keyboard. A note no longer there (deleted, or moved outside VS Code) has no tab
   * to show its strip, so its message pops up again, to be pressed or dismissed there.
   */
  private async showWaiting(): Promise<void> {
    const first = this.queue.firstWithNote();
    const m = first && this.byId.get(first.id);
    const note = m && this.noteOf(m);
    if (!m || !note) {
      this.reply('No waiting messages right now.', 'information');
      return;
    }
    const open = panels.panelsFor(note);
    const tab = open.find((p) => p.webviewPanel.visible) ?? open[0];
    if (tab) {
      const column = tab.webviewPanel.viewColumn ?? customTabColumn(note);
      await vscode.commands.executeCommand('vscode.openWith', note, VIEW_TYPE, {
        ...(column !== undefined ? { viewColumn: column } : {}),
        preview: false,
        preserveFocus: false,
      });
      this.focusStrip(tab);
      return;
    }
    if (!(await mayBeThere(note))) {
      if (!this.queue.isOpen(m.id)) return;
      const first = !this.queue.hasPopped(m.id);
      this.queue.popAgain(m.id);
      this.popUp(m, first);
      this.update(note);
      return;
    }
    const key = note.toString();
    this.focusOnLive.add(key);
    try {
      await vscode.commands.executeCommand('vscode.openWith', note, VIEW_TYPE, { preview: false });
    } catch (error) {
      this.focusOnLive.delete(key);
      throw error;
    }
  }

  private focusStrip(p: HostPanel): void {
    if (!p.live || p.disposed) return;
    void p.post({ type: 'messages', shown: this.stripFor(p.uri.toString()), focus: true });
  }

  // ---------------------------------------------------------------------------
  // What is shown

  /** The note of m as it is now: its own, or where VS Code has renamed it since. */
  private noteOf(m: Message): vscode.Uri | null {
    return this.notes.get(m.id) ?? m.note;
  }

  /** Notes renamed in VS Code (a folder among them): their open messages go with them. */
  private renamed(files: readonly { oldUri: vscode.Uri; newUri: vscode.Uri }[]): void {
    for (const [id, note] of this.notes)
      for (const { oldUri, newUri } of files) {
        const moved = movedUri(note, oldUri, newUri);
        if (!moved) continue;
        this.notes.set(id, moved);
        this.queue.renote(id, moved.toString());
        break;
      }
    this.update(null);
  }

  /** The buttons of `m` that apply now, in its form's order. */
  private offered(m: Message): FormButton[] {
    return m.form.buttons.filter((b) => b.does === 'dismiss' || m.offers(b.does));
  }

  /** What a strip of `note` shows: its oldest open message with a strip, as the same object while it does not change. */
  private stripFor(note: string): StripMessage | null {
    const shown = this.queue.shownFor(note);
    const m = shown === null ? undefined : this.byId.get(shown.id);
    if (!m || !shown) return null;
    const next: StripMessage = {
      id: m.id,
      text: m.form.text,
      buttons: this.offered(m).map((b) => ({ does: b.does, label: b.label })),
      popped: this.queue.hasPopped(m.id),
      more: moreWords(shown.more),
    };
    const before = this.strips.get(m.id);
    if (before && JSON.stringify(before) === JSON.stringify(next)) return before;
    this.strips.set(m.id, next);
    return next;
  }

  /** Sets each title bar button's context key: the versions whose diff shows it now. Choices that no longer apply are let go. */
  private setChoiceKeys(): void {
    if (!this.strip) return;
    const versions: Record<DiffButton, string[]> = { useClash: [], useGone: [], replace: [] };
    for (const [id, choice] of this.choices) {
      if (!choice.offers()) {
        this.choices.delete(id);
        continue;
      }
      const version = choice.version();
      if (version) versions[choice.button].push(version.toString());
    }
    for (const button of Object.keys(CHOICE_KEYS) as DiffButton[])
      setContextKey(CHOICE_KEYS[button], [...new Set(versions[button])].sort());
  }

  /** Tells the strips of `note` (every note when null), the diff's buttons and the status bar. */
  private update(note: vscode.Uri | null): void {
    const strip = this.strip;
    if (strip) {
      for (const p of note === null ? panels.all() : panels.panelsFor(note)) strip.tell(p);
      this.setChoiceKeys();
    }
    this.changed.fire();
  }
}

/** The viewColumn of an open Tandem Markdown custom editor tab for `note`, or undefined if none. */
function customTabColumn(note: vscode.Uri): vscode.ViewColumn | undefined {
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (
        tab.input instanceof vscode.TabInputCustom &&
        tab.input.viewType === VIEW_TYPE &&
        sameUri(tab.input.uri, note)
      ) {
        return group.viewColumn;
      }
    }
  }
  return undefined;
}

/** The one instance. Messages pop up from the first; strips, the diff's buttons and the status bar's command once `start` runs. */
export const messages = new Messages();
