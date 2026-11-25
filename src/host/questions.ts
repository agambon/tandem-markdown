// The questions the host's commands ask: a modal question, a message with buttons, and a choice
// from a list. In the in-VS-Code suite the test hook answers them in place of the user
// (`answerPrompts` in testApi.ts), seeing each question's words and its buttons or rows; with no
// answer given, the question is shown as it is to a user.

import * as vscode from 'vscode';

/** What the in-VS-Code suite sees of a question: for a list, each row's label and description as a button. */
export interface PromptForTests {
  message: string;
  detail?: string;
  buttons: string[];
}

let answerForTests: ((prompt: PromptForTests) => string | undefined) | null = null;
let testMode = false;

/** Called once from activate: whether the extension runs under the in-VS-Code suite. */
export function allowAnswersForTests(on: boolean): void {
  testMode = on;
  if (!on) answerForTests = null;
}

/** Test mode only: questions are answered by `answer` instead of being shown. Undefined shows them again. */
export function answerPromptsForTests(answer: ((prompt: PromptForTests) => string | undefined) | undefined): void {
  if (!testMode) throw new Error('Questions are answered by the user outside the test suite');
  answerForTests = answer ?? null;
}

/**
 * A modal question with `buttons`, and `cancel` as the button that closes it when given. Resolves
 * with the button chosen, or undefined when it was closed.
 */
export async function askModal(
  message: string,
  detail: string,
  buttons: readonly string[],
  cancel?: string,
): Promise<string | undefined> {
  if (answerForTests) return answerForTests({ message, detail, buttons: cancel ? [...buttons, cancel] : [...buttons] });
  const items: vscode.MessageItem[] = [
    ...buttons.map((title) => ({ title })),
    ...(cancel ? [{ title: cancel, isCloseAffordance: true }] : []),
  ];
  return (await vscode.window.showInformationMessage(message, { modal: true, detail }, ...items))?.title;
}

/** A message with `buttons`, not modal. Resolves with the button pressed, or undefined when it was closed. */
export async function askMessage(message: string, buttons: readonly string[]): Promise<string | undefined> {
  if (answerForTests) return answerForTests({ message, buttons: [...buttons] });
  return vscode.window.showInformationMessage(message, ...buttons);
}

/**
 * A choice from `items`, shown by `show`, titled `title`. In the suite the answer names a row by
 * its label and description, as the prompt's buttons give them.
 */
export async function askPick<T extends vscode.QuickPickItem>(
  title: string,
  items: readonly T[],
  show: () => Promise<T | undefined>,
): Promise<T | undefined> {
  if (!answerForTests) return show();
  const rows = items.map((item) => (item.description ? `${item.label} ${item.description}` : item.label));
  const chosen = answerForTests({ message: title, buttons: rows });
  return chosen === undefined ? undefined : items[rows.indexOf(chosen)];
}
