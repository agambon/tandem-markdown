// GitHub's emoji list on the host, which the outline view and a link's hover card read emoji
// codes by. The gemoji package is bundled into the host, but evaluated only when `load` is first
// called, the first time a heading or a note the host reads shows a code, so activation does not
// pay for it.

import type { EmojiNames } from '../../core/emojiCodes';

let loadedNames: EmojiNames | undefined;
let loadingNames: Promise<EmojiNames> | undefined;

export const hostEmojiNames = {
  /** The list, once a load has finished; undefined before. */
  loaded: (): EmojiNames | undefined => loadedNames,
  /** Starts the load the first time it is called; every call gives the same promise. */
  load: (): Promise<EmojiNames> =>
    (loadingNames ??= import('gemoji').then((gemoji) => (loadedNames = gemoji.nameToEmoji))),
};
