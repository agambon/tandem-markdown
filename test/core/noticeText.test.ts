// A file name or path must not form a link in a VS Code notification.
import { describe, expect, it } from 'vitest';
import { plainNotice } from '../../src/core/noticeText';

/** VS Code 1.146's pattern for links in an extension's notification (parseLinkedText). */
const LINK = /\[([^\]]+)\]\(((?:https?:\/\/|command:|file:)[^)\s]+)(?: (["'])(.+?)(\3))?\)/i;

describe('plainNotice', () => {
  it('breaks every link a name could hold, and leaves the name readable', () => {
    for (const name of [
      '[See merge](command:workbench.action.terminal.new).md',
      'a [x](https://example.com) b [y](file:///etc/passwd)',
      '[[x](command:a)](command:b)',
    ]) {
      const out = plainNotice(`${name} changed on disk.`);
      expect(LINK.test(out)).toBe(false);
      expect(out.replace(/\u200b/g, '')).toBe(`${name} changed on disk.`);
    }
  });

  it('leaves text with no link syntax as it is, and is the same when applied twice', () => {
    expect(plainNotice('notes.md changed on disk.')).toBe('notes.md changed on disk.');
    const once = plainNotice('[a](command:b)');
    expect(plainNotice(once)).toBe(once);
  });
});
