// Emoji codes (`:smile:`, markdown/emoji.ts): the emoji in place of the code, for names on
// GitHub's list (the gemoji package's, which loads the first time a file shows a code), with
// the code as its tooltip and accessible name, so it can be told from an emoji typed as one.
// Any other name is text. With a selection touching it, the code shows, its colons faded.
// Headings read their codes from the same list (`emojiCodes`), for the contents list
// (contents.ts) and the sentences a screen reader is told (src/panel/announce/).

import type { EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { emojiOf, type EmojiCodes, type EmojiNames } from '../../core/emojiCodes';
import { panelContext } from '../context';
import type { Feature } from '../features';
import { NO_INLINE } from '../markdown/nodes';
import { onDemand } from '../onDemand';
import { syntaxOn } from '../syntax';
import { CharWidget } from './charWidget';
import { inlineFeature } from './framework';

/** GitHub's list, loaded the first time a file shows a code. */
export const emojiNames = onDemand(async (): Promise<EmojiNames> => (await import('gemoji')).nameToEmoji);

/** Whether the emoji setting is on for the file of `state` (on in a state made without a panel). */
export function emojiOn(state: EditorState): boolean {
  return syntaxOn(state.facet(panelContext)?.settings, 'emoji');
}

/**
 * How headings read in `state` take emoji codes: not at all while the setting is off; else from
 * the list once it has loaded, `wanted` called for a code read before then.
 */
export function emojiCodes(state: EditorState, wanted?: () => void): EmojiCodes | undefined {
  if (!emojiOn(state)) return undefined;
  const names = emojiNames.loaded();
  return wanted ? { names, wanted } : { names };
}

class EmojiChar extends CharWidget {
  draw(view: EditorView): HTMLElement {
    const span = this.charSpan(view, 'tm-emoji');
    span.setAttribute('role', 'img');
    span.setAttribute('aria-label', this.source);
    span.title = this.source;
    return span;
  }
}

export const emoji: Feature = {
  id: 'emoji',
  extension: () => [
    inlineFeature('emoji', (d) => {
      const list = emojiNames.loaded();
      d.iterate((node) => {
        if (NO_INLINE.has(node.name)) return false;
        if (node.name !== 'EmojiCode') return true;
        if (!list) {
          d.drawWhenLoaded(emojiNames);
          return false;
        }
        const source = d.doc.sliceString(node.from, node.to);
        const char = emojiOf(list, source);
        if (!char) return false;
        if (d.revealed(node.from, node.to)) {
          d.mark(node.from, node.from + 1, 'tm-mark');
          d.mark(node.to - 1, node.to, 'tm-mark');
        } else {
          d.replace(node.from, node.to, new EmojiChar(source, char));
        }
        return false;
      });
    }),
  ],
};
