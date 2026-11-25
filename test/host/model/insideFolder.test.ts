// Whether a path lies inside a folder, on Windows and POSIX paths and in any letter case, refusing
// every form that could leave it.

import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isInsideFolder, partsInside, sameFilePath } from '../../../src/host/model/insideFolder';

describe('isInsideFolder (Windows paths)', () => {
  const w = path.win32;
  const vault = 'C:\\Users\\a\\Vault';

  it('accepts a file anywhere under the folder, in any case', () => {
    expect(isInsideFolder(vault, 'C:\\Users\\a\\Vault\\Note.md', w)).toBe(true);
    expect(isInsideFolder(vault, 'c:\\users\\A\\vault\\Deep\\Down\\Note.md', w)).toBe(true);
    expect(isInsideFolder(vault, 'C:/Users/a/Vault/Deep/Note.md', w)).toBe(true);
    expect(isInsideFolder(vault, 'C:\\Users\\a\\Vault\\Deep\\..\\Note.md', w)).toBe(true);
    expect(isInsideFolder(vault, 'C:\\Users\\a\\Vault\\..notes.md', w)).toBe(true);
  });

  it('refuses anything that ends up outside it once normalized', () => {
    expect(isInsideFolder(vault, 'C:\\Users\\a\\Vault\\..\\secret.md', w)).toBe(false);
    expect(isInsideFolder(vault, 'C:\\Users\\a\\Vault\\Deep\\..\\..\\..\\secret.md', w)).toBe(false);
    expect(isInsideFolder(vault, 'C:\\Users\\a\\VaultTwo\\Note.md', w)).toBe(false);
    expect(isInsideFolder(vault, 'D:\\Users\\a\\Vault\\Note.md', w)).toBe(false);
    expect(isInsideFolder(vault, 'C:\\Users\\a\\Vault', w)).toBe(false);
    expect(isInsideFolder(vault, 'C:\\Users\\a\\Vault\\', w)).toBe(false);
  });

  it('refuses UNC, device and long-path forms, drive-relative and relative paths, and data streams', () => {
    expect(isInsideFolder(vault, '\\\\server\\share\\Vault\\Note.md', w)).toBe(false);
    expect(isInsideFolder(vault, '\\\\?\\C:\\Users\\a\\Vault\\Note.md', w)).toBe(false);
    expect(isInsideFolder(vault, '\\\\.\\C:\\Users\\a\\Vault\\Note.md', w)).toBe(false);
    expect(isInsideFolder(vault, 'C:Note.md', w)).toBe(false);
    expect(isInsideFolder(vault, 'Note.md', w)).toBe(false);
    expect(isInsideFolder(vault, 'C:\\Users\\a\\Vault\\Note.md:hidden', w)).toBe(false);
    expect(isInsideFolder(vault, 'C:\\Users\\a\\Vault\\Note.md::$DATA', w)).toBe(false);
  });

  it('works for a folder on a share, inside that share only', () => {
    const share = '\\\\server\\share\\Vault';
    expect(isInsideFolder(share, '\\\\server\\share\\Vault\\Note.md', w)).toBe(true);
    expect(isInsideFolder(share, '\\\\server\\other\\Vault\\Note.md', w)).toBe(false);
    expect(isInsideFolder(share, '\\\\server\\share\\Vault\\..\\Note.md', w)).toBe(false);
  });

  it('gives the parts from the folder down', () => {
    expect(partsInside(vault, 'C:\\Users\\a\\Vault\\Deep\\Note.md', w)).toEqual(['Deep', 'Note.md']);
  });
});

describe('isInsideFolder (POSIX paths)', () => {
  const p = path.posix;
  it('accepts what is under the folder and refuses the rest', () => {
    expect(isInsideFolder('/home/a/vault', '/home/a/vault/x/Note.md', p)).toBe(true);
    expect(isInsideFolder('/home/a/vault', '/home/a/vault/../secret.md', p)).toBe(false);
    expect(isInsideFolder('/home/a/vault', '/home/a/Vault/Note.md', p)).toBe(false);
    expect(isInsideFolder('/home/a/vault', '/etc/passwd', p)).toBe(false);
    expect(isInsideFolder('/home/a/vault', 'vault/Note.md', p)).toBe(false);
  });
});

describe('paths that differ only in letter case', () => {
  it('name one file on a Mac and on Windows, as VS Code takes them, and two on Linux', () => {
    expect(sameFilePath('/Users/a/Notes/Plan.md', '/users/a/notes/plan.md', 'darwin')).toBe(true);
    expect(sameFilePath('C:/Users/a/Plan.md', 'c:/users/a/PLAN.md', 'win32')).toBe(true);
    expect(sameFilePath('/home/a/Plan.md', '/home/a/plan.md', 'linux')).toBe(false);
    expect(sameFilePath('/Users/a/Plan.md', '/Users/a/Plan2.md', 'darwin')).toBe(false);
  });

  it('lie inside a folder written in another case where case is ignored, keeping their own case', () => {
    const p = path.posix;
    expect(isInsideFolder('/Users/a/Vault', '/users/A/vault/Deep/Note.md', p, true)).toBe(true);
    expect(partsInside('/Users/a/Vault', '/users/A/vault/Deep/Note.md', p, true)).toEqual(['Deep', 'Note.md']);
    expect(isInsideFolder('/Users/a/Vault', '/users/A/vault/../secret.md', p, true)).toBe(false);
  });
});
