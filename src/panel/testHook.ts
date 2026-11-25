// The panel's half of the test hook (docs/ARCHITECTURE.md, "Boot"): answers the host's
// `test` messages with `testResult`. The boot code creates it only when the init says the panel
// runs under test; any other panel ignores `test` messages.

import { getSyncedVersion, sendableUpdates } from '@codemirror/collab';
import type { EditorView } from '@codemirror/view';
import { errorMessage } from '../core/errors';
import type { PanelTestState, TestAction, TestMessage, TestResultMessage } from '../core/featureProtocol';
import { runCommand } from './commands/registry';
import type { HostBridge } from './context';
import { corruption } from './corruption';
import { getMode } from './modes';
import { changeMarksOf } from './render/changeMarks';
import { diagnosticsOf } from './render/diagnostics';
import { outsideMarkField } from './render/outsideMark';
import { tabMovesFocus } from './ui/tabFocus';

/** What the hook may use of the panel. */
interface TestTarget {
  bridge: HostBridge;
  view(): EditorView | null;
  /** True once the panel has been disposed: nothing is answered. */
  disposed(): boolean;
  cspViolations(): readonly string[];
  /** Changes the mode as the host's `setMode` does. */
  setMode(mode: unknown): void;
  /** Commits an open table cell and sends what is unsent, as the host's `flush` does. */
  flush(): Promise<unknown>;
  /** The message strip's place in the page (messageStrip.ts). */
  messageStrip: HTMLElement;
}

export class TestHook {
  /** What the live region of the view was given to speak (`announced`). */
  private readonly announced: string[] = [];
  private watched: EditorView | null = null;

  constructor(private readonly t: TestTarget) {}

  /**
   * Keeps what `view`'s live region is given to speak. CodeMirror puts each sentence of
   * `EditorView.announce` there as a child of `.cm-announced` and empties it a moment later.
   */
  private watch(view: EditorView): void {
    if (this.watched === view) return;
    this.watched = view;
    const region = view.dom.querySelector('.cm-announced');
    if (!region) return;
    new MutationObserver((records) => {
      for (const r of records)
        for (const node of r.addedNodes)
          if (node.nodeName === 'DIV' && node.textContent) this.announced.push(node.textContent);
    }).observe(region, { childList: true });
  }

  /** Runs a `test` message's actions in order, then posts the state after them. */
  answer(m: TestMessage): void {
    // Echoed exactly as it came, whatever its type, so the host's lookup finds it.
    const requestId = m.requestId;
    void this.run(Array.isArray(m.actions) ? m.actions : []).then(({ result, error }) => {
      if (this.t.disposed()) return;
      const answer: TestResultMessage = { type: 'testResult', requestId, result };
      if (error !== undefined) answer.error = error;
      this.t.bridge.post(answer);
    });
  }

  /**
   * Answers `test` messages for the failure page drawn into `root`: its text, and a click on
   * its Show Source button. Returns the function that stops answering.
   */
  answerAsFailurePage(root: HTMLElement, button: HTMLButtonElement): () => void {
    return this.t.bridge.onMessage((m) => {
      if (this.t.disposed() || m.type !== 'test') return;
      const t = m as { requestId?: unknown; actions?: unknown };
      for (const a of Array.isArray(t.actions) ? t.actions : []) {
        if (a && (a as { type?: unknown }).type === 'click' && (a as { target?: unknown }).target === 'showSource')
          button.click();
      }
      this.t.bridge.post({
        type: 'testResult',
        requestId: t.requestId as string,
        result: { failurePage: true, text: root.textContent ?? '', cspViolations: [...this.t.cspViolations()] },
      });
    });
  }

  private state(): PanelTestState {
    const v = this.t.view();
    const cspViolations = [...this.t.cspViolations()];
    if (!v) {
      return {
        text: '',
        version: -1,
        unconfirmed: 0,
        mode: 'view',
        selection: { anchor: 0, head: 0 },
        lineCount: 0,
        widgets: [],
        cspViolations,
        outsideMarked: [],
        announced: [...this.announced],
        tabMovesFocus: false,
        diagnostics: [],
        changeMarks: [],
        messageStrip: this.messageStrip(),
      };
    }
    this.watch(v);
    const outsideMarked: number[] = [];
    v.state.field(outsideMarkField, false)?.decorations.between(0, v.state.doc.length, (from) => {
      outsideMarked.push(v.state.doc.lineAt(from).number);
    });
    const main = v.state.selection.main;
    const version = getSyncedVersion(v.state);
    const unconfirmed = sendableUpdates(v.state).length;
    return {
      text: v.state.doc.toString(),
      version,
      unconfirmed,
      mode: getMode(v.state),
      selection: { anchor: main.anchor, head: main.head },
      lineCount: v.state.doc.lines,
      widgets: drawnWidgets(v),
      cspViolations,
      outsideMarked,
      announced: [...this.announced],
      tabMovesFocus: tabMovesFocus(v),
      diagnostics: diagnosticsOf(v.state).map(({ from, to, severity, message }) => ({ from, to, severity, message })),
      changeMarks: changeMarksOf(v.state).map((m) => ({ line: v.state.doc.lineAt(m.from).number, kind: m.kind })),
      messageStrip: this.messageStrip(),
    };
  }

  /** The message the strip shows, as a reader meets it: the group's words and its buttons' names. */
  private messageStrip(): PanelTestState['messageStrip'] {
    const group = this.t.messageStrip.querySelector('[role="group"]');
    if (!group) return null;
    const text = group.querySelector('#' + (group.getAttribute('aria-labelledby') ?? ''))?.textContent ?? '';
    return { text, buttons: [...group.querySelectorAll('button')].map((b) => b.textContent ?? '') };
  }

  private async run(actions: readonly TestAction[]): Promise<{ result: PanelTestState; error?: string }> {
    let failure: string | undefined;
    try {
      for (const a of actions) await this.runAction(a);
    } catch (error) {
      failure = errorMessage(error);
    }
    return failure === undefined ? { result: this.state() } : { result: this.state(), error: failure };
  }

  private async runAction(a: TestAction): Promise<void> {
    const v = this.t.view();
    if (!v) throw new Error('The panel has not started yet');
    const length = v.state.doc.length;
    const inRange = (n: unknown) => Number.isInteger(n) && (n as number) >= 0 && (n as number) <= length;
    switch (a?.type) {
      case 'insert': {
        if (!inRange(a.at) || typeof a.text !== 'string')
          throw new Error(`insert: bad position ${String(a.at)} or text`);
        if (v.state.readOnly) throw new Error('insert: the view is read-only');
        const userEvent = typeof a.userEvent === 'string' ? a.userEvent : 'input.type';
        v.dispatch({
          changes: { from: a.at, insert: a.text },
          selection: { anchor: a.at + a.text.length },
          userEvent,
          scrollIntoView: true,
        });
        return;
      }
      case 'replace': {
        if (!inRange(a.from) || !inRange(a.to) || a.to < a.from || typeof a.text !== 'string')
          throw new Error('replace: bad range or text');
        if (v.state.readOnly) throw new Error('replace: the view is read-only');
        v.dispatch({ changes: { from: a.from, to: a.to, insert: a.text } });
        return;
      }
      case 'select':
        if (!inRange(a.anchor) || !inRange(a.head)) throw new Error('select: bad position');
        v.dispatch({ selection: { anchor: a.anchor, head: a.head }, userEvent: 'select', scrollIntoView: true });
        return;
      case 'command':
        if (typeof a.id !== 'string') throw new Error('command: no id');
        runCommand(v, a.id, a.args);
        return;
      case 'setMode':
        this.t.setMode(a.mode);
        return;
      case 'flush':
        await this.t.flush();
        return;
      case 'state':
        return;
      case 'corrupt': {
        if (!inRange(a.at) || typeof a.text !== 'string' || a.text === '')
          throw new Error('corrupt: bad position or text');
        // A change that the sync layer never sees, so it is never sent.
        v.dispatch(corruption(v.state, a.at, a.text));
        return;
      }
      case 'click':
        throw new Error('click: the panel started, so there is no Show Source button');
      case 'pressMessage': {
        const button = [...this.t.messageStrip.querySelectorAll('button')].find((b) => b.textContent === a.label);
        if (!button) throw new Error(`pressMessage: the strip shows no button "${String(a.label)}"`);
        button.click();
        return;
      }
      default:
        throw new Error(`Unknown test action ${JSON.stringify((a as { type?: unknown })?.type)}`);
    }
  }
}

/** The class attribute of every drawn widget (outermost only), in document order. */
function drawnWidgets(view: EditorView): string[] {
  const content = view.contentDOM;
  const out: string[] = [];
  for (const element of content.querySelectorAll('[contenteditable="false"]')) {
    let nested = false;
    for (let p = element.parentElement; p && p !== content; p = p.parentElement) {
      if (p.getAttribute('contenteditable') === 'false') {
        nested = true;
        break;
      }
    }
    if (nested) continue;
    const cls = element.getAttribute('class');
    if (cls) out.push(cls);
  }
  return out;
}
