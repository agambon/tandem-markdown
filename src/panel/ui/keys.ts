// Key names as VS Code shows them, key matching for the panel's own keys, and which key presses
// may run a VS Code command. A binding is written as `package.json` writes one, `ctrl+shift+v`,
// with an optional `mac` form; a binding with no `mac` form applies on a Mac as written. Off a
// Mac a name reads `Ctrl+Shift+V`; on a Mac it is VS Code's symbols with no separator, `⇧⌘V`.

/** A keybinding as `package.json` writes one. */
export interface KeyBinding {
  key: string;
  mac?: string;
}

/** The parts of a key event that a binding names. */
export type KeyPress = Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey'>;

/**
 * True on a Mac. CodeMirror makes the same test to decide what its `Mod` key is, so the keys
 * the page handles and the names it shows agree.
 */
const IS_MAC = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);

/** VS Code's keys for the panel commands whose keys the panel names, as `package.json` binds them. */
export const COMMAND_KEYS = {
  toggleBold: { key: 'ctrl+b', mac: 'cmd+b' },
  toggleItalic: { key: 'ctrl+i', mac: 'cmd+i' },
  toggleStrikethrough: { key: 'alt+s', mac: 'ctrl+cmd+s' },
  insertLink: { key: 'alt+k', mac: 'ctrl+cmd+k' },
  headingUp: { key: 'ctrl+shift+]' },
  headingDown: { key: 'ctrl+shift+[' },
  find: { key: 'ctrl+f', mac: 'cmd+f' },
} satisfies Record<string, KeyBinding>;

/** The modifiers in the order VS Code names them, with their names off a Mac and on one. */
const MODIFIERS = [
  { token: 'ctrl', name: 'Ctrl', symbol: '⌃' },
  { token: 'shift', name: 'Shift', symbol: '⇧' },
  { token: 'alt', name: 'Alt', symbol: '⌥' },
  { token: 'cmd', name: 'Cmd', symbol: '⌘' },
] as const;

function parse(binding: KeyBinding, mac: boolean): { modifiers: Set<string>; key: string } {
  const parts = (mac ? (binding.mac ?? binding.key) : binding.key).split('+');
  const key = parts.pop() ?? '';
  return { modifiers: new Set(parts), key };
}

/** How VS Code names `binding`: `Ctrl+Shift+]` off a Mac, `⌃⇧]` on one. */
export function keyName(binding: KeyBinding, mac = IS_MAC): string {
  const { modifiers, key } = parse(binding, mac);
  const named = key.length === 1 ? key.toUpperCase() : key.charAt(0).toUpperCase() + key.slice(1);
  const held = MODIFIERS.filter((m) => modifiers.has(m.token));
  return mac ? held.map((m) => m.symbol).join('') + named : [...held.map((m) => m.name), named].join('+');
}

/**
 * The key of a key event as a binding names it. A letter comes from `key` when that is a
 * letter from A to Z, otherwise from the key's position (`code`): with Option on a Mac, or on a
 * layout that is not Latin, the same key gives another character.
 */
function keyOf(event: KeyPress): string {
  if (/^[a-z]$/i.test(event.key)) return event.key.toLowerCase();
  const letter = /^Key([A-Z])$/.exec(event.code)?.[1];
  return (letter ?? event.key).toLowerCase();
}

/** A key that only modifies others: pressed alone it is not yet a chord. */
const MODIFIER_KEYS = new Set(['Alt', 'AltGraph', 'Control', 'Meta', 'Shift']);

/**
 * True when `event` is a key pressed with a command modifier, so VS Code may run a command for
 * it: Ctrl or Cmd, or Alt off a Mac. Option on a Mac and AltGr type characters, so they are not.
 */
export function isCommandChord(event: KeyPress & Pick<KeyboardEvent, 'getModifierState'>, mac = IS_MAC): boolean {
  if (MODIFIER_KEYS.has(event.key) || event.getModifierState('AltGraph')) return false;
  return event.ctrlKey || event.metaKey || (event.altKey && !mac);
}

/** True when `event` is `binding` on this platform: exactly its modifiers, and its key. */
export function keyMatches(event: KeyPress, binding: KeyBinding, mac = IS_MAC): boolean {
  const { modifiers, key } = parse(binding, mac);
  return (
    event.ctrlKey === modifiers.has('ctrl') &&
    event.shiftKey === modifiers.has('shift') &&
    event.altKey === modifiers.has('alt') &&
    event.metaKey === modifiers.has('cmd') &&
    keyOf(event) === key
  );
}
