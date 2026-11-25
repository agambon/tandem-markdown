// The context keys the extension sets for `when` clauses (keybindings, menus, the title bar).
// Each is set again only when its value changes, since VS Code reevaluates its clauses on each.

import * as vscode from 'vscode';

type ContextValue = boolean | string | string[];

const values = new Map<string, ContextValue>();

/** Sets the context key `name` to `value`, unless it already holds it (a list compared item by item). */
export function setContextKey(name: string, value: ContextValue): void {
  const before = values.get(name);
  const same = Array.isArray(value)
    ? Array.isArray(before) && before.length === value.length && before.every((v, i) => v === value[i])
    : before === value;
  if (same) return;
  values.set(name, value);
  void vscode.commands.executeCommand('setContext', name, value);
}

/** The list the context key `name` was last set to; empty before it is set. */
export function contextKeyList(name: string): string[] {
  const value = values.get(name);
  return Array.isArray(value) ? value : [];
}
