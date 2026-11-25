// Shared by the host's tests: those that run its VS Code side in Node, and the words checks of its model.

import type { ExtensionContext } from 'vscode';

/** A memento that keeps what is written as VS Code keeps it: a copy, through JSON. */
export function memento(): { get(key: string): unknown; update(key: string, value: unknown): Promise<void> } {
  const values = new Map<string, unknown>();
  return {
    get: (key) => values.get(key),
    update: async (key, value) => {
      values.set(key, JSON.parse(JSON.stringify(value)));
    },
  };
}

/** An extension context whose two stores hold nothing and keep nothing written to them. */
export function emptyContext(): ExtensionContext {
  const store = { get: () => undefined, update: async () => undefined };
  return { workspaceState: store, globalState: store } as unknown as ExtensionContext;
}

/** An open document holding `text`, as the conflict files code reads one. */
export function openNote<U>(uri: U, text = ''): { uri: U; isClosed: boolean; getText(): string } {
  return { uri, isClosed: false, getText: () => text };
}

/**
 * What is wrong with `shown` as the core's message `m` naming a conflict file by `sentence`: it
 * keeps all the message says before its ending, holds the sentence once, and ends with the ending
 * after it, or (`replaced`) has the sentence in the ending's place. Empty when nothing is.
 */
export function namingFaults(
  shown: string | null,
  m: { message: string; ending: string },
  sentence: string,
  replaced = false,
): string[] {
  if (shown === null) return ['no message'];
  const faults: string[] = [];
  const lead = m.message.slice(0, m.message.lastIndexOf(m.ending)).trimEnd();
  if (!shown.startsWith(lead)) faults.push('loses what the message says before its ending');
  if (shown.split(sentence).length !== 2) faults.push('does not name the conflict file once');
  const rest = shown.slice(shown.indexOf(sentence) + sentence.length).trim();
  if (replaced ? rest.includes(m.ending) : rest !== m.ending)
    faults.push(replaced ? 'keeps its ending' : 'does not end with its ending after the sentence');
  return faults;
}

/** Resolves when `condition` holds, looked at again after each turn of the event loop: no limit but the case's own. */
export async function until(condition: () => boolean): Promise<void> {
  while (!condition()) await new Promise((resolve) => setImmediate(resolve));
}

/**
 * The turns of the event loop a case waits for what may never come, such as a message shown again
 * after a press: what does come, comes within a few.
 */
const TURNS_FOR_WHAT_MAY_NOT_COME = 50;

/** Resolves when `condition` holds, as `until` does, or after TURNS_FOR_WHAT_MAY_NOT_COME turns, for a case where it may never hold. */
export async function untilOrNot(condition: () => boolean): Promise<void> {
  for (let i = 0; i < TURNS_FOR_WHAT_MAY_NOT_COME && !condition(); i++)
    await new Promise((resolve) => setImmediate(resolve));
}
