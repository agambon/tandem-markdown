// The message when a note's language changes and its rich tabs start again.

import { describe, expect, it } from 'vitest';
import { languageReloadMessage } from '../../../src/host/model/languageReload';

describe('languageReloadMessage', () => {
  it('says the typing may have been lost, for one tab or several', () => {
    expect(languageReloadMessage('Field notes.md', 1)).toBe(
      "Field notes.md's language mode was changed, so its rich tab reloaded and may have lost what you had just typed.",
    );
    expect(languageReloadMessage('Field notes.md', 2)).toBe(
      "Field notes.md's language mode was changed, so its rich tabs reloaded and may have lost what you had just typed.",
    );
  });
});
