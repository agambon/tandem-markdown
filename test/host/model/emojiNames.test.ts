// The host's copy of GitHub's emoji list: loaded only when asked, and once.

import { nameToEmoji } from 'gemoji';
import { describe, expect, it } from 'vitest';
import { hostEmojiNames } from '../../../src/host/model/emojiNames';

describe('hostEmojiNames', () => {
  it('loads the emoji list only when asked, once', async () => {
    expect(hostEmojiNames.loaded()).toBeUndefined();
    const first = hostEmojiNames.load();
    expect(hostEmojiNames.load()).toBe(first);
    expect(await first).toBe(nameToEmoji);
    expect(hostEmojiNames.loaded()).toBe(nameToEmoji);
  });
});
