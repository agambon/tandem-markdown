// Key names as VS Code shows them on each platform, matching the panel's own keys, which key
// presses are command chords, and the keys the panel names against the bindings in package.json.

import { describe, expect, it } from 'vitest';
import manifest from '../../../package.json';
import {
  COMMAND_KEYS,
  isCommandChord,
  keyMatches,
  keyName,
  type KeyBinding,
  type KeyPress,
} from '../../../src/panel/ui/keys';

const press = (key: string, code: string, held: Partial<KeyPress> = {}): KeyPress => ({
  key,
  code,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ...held,
});

describe('key names', () => {
  it('reads as VS Code writes them off a Mac', () => {
    expect(keyName({ key: 'ctrl+b', mac: 'cmd+b' }, false)).toBe('Ctrl+B');
    expect(keyName({ key: 'ctrl+shift+]' }, false)).toBe('Ctrl+Shift+]');
    expect(keyName({ key: 'ctrl+alt+enter', mac: 'alt+cmd+enter' }, false)).toBe('Ctrl+Alt+Enter');
    expect(keyName({ key: 'escape' }, false)).toBe('Escape');
  });

  it("uses a binding's Mac form on a Mac, in VS Code's symbols and modifier order", () => {
    expect(keyName({ key: 'ctrl+b', mac: 'cmd+b' }, true)).toBe('⌘B');
    expect(keyName({ key: 'alt+s', mac: 'ctrl+cmd+s' }, true)).toBe('⌃⌘S');
    expect(keyName({ key: 'ctrl+shift+v', mac: 'cmd+shift+v' }, true)).toBe('⇧⌘V');
    expect(keyName({ key: 'ctrl+alt+enter', mac: 'alt+cmd+enter' }, true)).toBe('⌥⌘Enter');
    expect(keyName({ key: 'shift+enter' }, true)).toBe('⇧Enter');
  });

  it('names a binding with no Mac form as written, with the Control key, on a Mac', () => {
    expect(keyName({ key: 'ctrl+shift+]' }, true)).toBe('⌃⇧]');
  });
});

describe('matching a key press', () => {
  const matchCase: KeyBinding = { key: 'alt+c', mac: 'alt+cmd+c' };

  it('leaves Option with a letter to typing on a Mac, and takes Option with Cmd', () => {
    expect(keyMatches(press('ç', 'KeyC', { altKey: true }), matchCase, true)).toBe(false);
    expect(keyMatches(press('ç', 'KeyC', { altKey: true, metaKey: true }), matchCase, true)).toBe(true);
    expect(keyMatches(press('c', 'KeyC', { altKey: true, metaKey: true }), matchCase, true)).toBe(true);
  });

  it('takes Alt with the letter off a Mac, whatever character the layout gives the key', () => {
    expect(keyMatches(press('c', 'KeyC', { altKey: true }), matchCase, false)).toBe(true);
    expect(keyMatches(press('с', 'KeyC', { altKey: true }), matchCase, false)).toBe(true);
    expect(keyMatches(press('c', 'KeyC', { altKey: true, shiftKey: true }), matchCase, false)).toBe(false);
  });

  it('goes by the letter a Latin layout gives, not by where the key sits', () => {
    const wholeWord: KeyBinding = { key: 'alt+w' };
    expect(keyMatches(press('w', 'KeyZ', { altKey: true }), wholeWord, false)).toBe(true);
    expect(keyMatches(press('z', 'KeyW', { altKey: true }), wholeWord, false)).toBe(false);
  });

  it('matches named keys', () => {
    const replaceAll: KeyBinding = { key: 'ctrl+alt+enter', mac: 'alt+cmd+enter' };
    expect(keyMatches(press('Enter', 'Enter', { ctrlKey: true, altKey: true }), replaceAll, false)).toBe(true);
    expect(keyMatches(press('Enter', 'Enter', { altKey: true, metaKey: true }), replaceAll, true)).toBe(true);
    expect(keyMatches(press('Enter', 'Enter', { ctrlKey: true, altKey: true }), replaceAll, true)).toBe(false);
  });
});

describe('a command chord', () => {
  const chord = (key: string, code: string, held: Partial<KeyPress> = {}, altGraph = false) => ({
    ...press(key, code, held),
    getModifierState: (name: string) => altGraph && name === 'AltGraph',
  });

  it('is a key pressed with Ctrl or Cmd, on any platform', () => {
    for (const mac of [false, true]) {
      expect(isCommandChord(chord('w', 'KeyW', { ctrlKey: true }), mac)).toBe(true);
      expect(isCommandChord(chord('k', 'KeyK', { metaKey: true }), mac)).toBe(true);
      expect(isCommandChord(chord('Tab', 'Tab', { ctrlKey: true, shiftKey: true }), mac)).toBe(true);
    }
  });

  it('is a key pressed with Alt off a Mac, but not with Option on one, which types a character', () => {
    expect(isCommandChord(chord('s', 'KeyS', { altKey: true }), false)).toBe(true);
    expect(isCommandChord(chord('ß', 'KeyS', { altKey: true }), true)).toBe(false);
  });

  it('is not a character typed with AltGr, a shifted key, or a modifier pressed alone', () => {
    expect(isCommandChord(chord('@', 'KeyQ', { ctrlKey: true, altKey: true }, true), false)).toBe(false);
    expect(isCommandChord(chord('A', 'KeyA', { shiftKey: true }), false)).toBe(false);
    expect(isCommandChord(chord('a', 'KeyA'), false)).toBe(false);
    expect(isCommandChord(chord('Control', 'ControlLeft', { ctrlKey: true }), false)).toBe(false);
    expect(isCommandChord(chord('Meta', 'MetaLeft', { metaKey: true }), true)).toBe(false);
    expect(isCommandChord(chord('Shift', 'ShiftLeft', { ctrlKey: true, shiftKey: true }), false)).toBe(false);
  });
});

describe('the keys the panel names', () => {
  it('are the keys package.json binds for those commands', () => {
    for (const [command, binding] of Object.entries<KeyBinding>(COMMAND_KEYS)) {
      const declared = manifest.contributes.keybindings.filter((k) => k.command === `tandemMarkdown.${command}`);
      expect(declared, command).toHaveLength(1);
      expect({ key: binding.key, mac: binding.mac }, command).toEqual({ key: declared[0]!.key, mac: declared[0]!.mac });
    }
  });
});
