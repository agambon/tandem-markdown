// The Copy text and Copy link buttons of the tab's notices. Each copies through the page's
// clipboard; the notice that holds the text stays until the copy succeeds, and a copy that
// fails says the text is still there.

import type { NoticeAction, PanelContext } from './context';

export const COPY_FAILED = 'Could not copy the text; it is still in the message above.';

type WriteText = (text: string) => Promise<void>;

function pageClipboard(text: string): Promise<void> {
  const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
  if (!clipboard?.writeText) return Promise.reject(new Error('The page has no clipboard'));
  return clipboard.writeText(text);
}

/** A notice button labeled `label` that copies `text`, all of it, whatever the notice shows of it. */
export function copyAction(
  ctx: Pick<PanelContext, 'notify' | 'log'>,
  label: string,
  text: string,
  write: WriteText = pageClipboard,
): NoticeAction {
  return {
    label,
    closeWhenDone: true,
    run: async () => {
      try {
        await write(text);
        return true;
      } catch (error) {
        ctx.log('warn', `${label} could not write to the clipboard`, error);
        ctx.notify({ kind: 'error', text: COPY_FAILED });
        return false;
      }
    },
  };
}
