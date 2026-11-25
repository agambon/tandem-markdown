// Pasted and dropped images: the host saves each one (`saveImage`), and `![](path)` is inserted
// where the paste was made once it answers.

import { EditorSelection } from '@codemirror/state';
import { errorMessage } from '../../core/errors';
import { listed } from '../../core/listText';
import type { PanelContext } from '../context';
import { copyAction } from '../copyText';
import { imageMarkdown, plainChange } from './changes';
import { dropHeldPaste, holdPaste, insertHeldPaste, type PasteTarget } from './held';

export async function fileToBase64(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** How the images came: pasted, or dropped onto the tab. */
type ImagesCame = 'pasted' | 'dropped';

/** How the images of a change with `userEvent` came: CodeMirror's own drop is `input.drop`. */
function cameBy(userEvent: string): ImagesCame {
  return userEvent === 'input.drop' ? 'dropped' : 'pasted';
}

/** What the notice says when `failed` of `total` images that `came` could not be saved, `saved` of them were. */
export function notSavedText(failed: number, total: number, saved: number, reason: string, came: ImagesCame): string {
  if (saved > 0)
    return failed === 1
      ? `1 of the ${total} ${came} images could not be saved, so it was left out: ${reason}`
      : `${failed} of the ${total} ${came} images could not be saved, so they were left out: ${reason}`;
  return total === 1
    ? `The ${came} image could not be saved, so nothing was added: ${reason}`
    : `The ${total} ${came} images could not be saved, so nothing was added: ${reason}`;
}

/** What the notice says when images that `came` were saved as `paths` but their links could not go in. */
export function linksNotInText(paths: readonly string[], came: ImagesCame): string {
  return paths.length === 1
    ? `The ${came} image was saved as ${paths[0]}, but this tab reloaded before its link went in.`
    : `The ${came} images were saved as ${listed(paths)}, but this tab reloaded before their links went in.`;
}

function extensionFor(mime: string): string {
  const sub = mime.split('/')[1]?.toLowerCase() ?? 'png';
  return sub === 'jpeg' ? 'jpg' : sub === 'svg+xml' ? 'svg' : sub.replace(/[^a-z0-9]/g, '') || 'png';
}

/**
 * An image pasted over [from, to] (or dropped at a point, `from` = `to`): the selected text
 * is deleted at once, as one change, since the paste replaces it. Then the host saves each
 * image, and `![](path)` for those it saved is inserted at that point, mapped through every
 * edit made meanwhile, replacing nothing. A failure raises a notice; when none was saved
 * nothing is inserted, and the text that was selected stays deleted (it was pasted over). When
 * the tab reloaded before the links went in, the notice offers them to copy.
 */
export async function saveAndLinkImages(
  target: PasteTarget,
  ctx: PanelContext,
  files: readonly File[],
  from: number,
  to: number,
  userEvent: string,
): Promise<boolean> {
  let at = from;
  if (to > from) {
    target.dispatch({ changes: { from, to }, selection: { anchor: from }, userEvent, scrollIntoView: true });
    at = target.state.selection.main.head;
  }
  const id = holdPaste(target, EditorSelection.single(at));
  const paths: string[] = [];
  const failures: string[] = [];
  for (const file of files) {
    try {
      const mime = file.type || 'image/png';
      const name = file.name || `image.${extensionFor(mime)}`;
      const dataBase64 = await fileToBase64(file);
      const result = await ctx.request<{ markdownPath?: unknown }>({ type: 'saveImage', name, mime, dataBase64 });
      if (!result || typeof result.markdownPath !== 'string' || !result.markdownPath)
        throw new Error('The host gave no path for it.');
      paths.push(result.markdownPath);
    } catch (error) {
      failures.push(errorMessage(error));
    }
  }
  if (failures.length) {
    ctx.notify({
      kind: 'error',
      text: notSavedText(failures.length, files.length, paths.length, failures[0]!, cameBy(userEvent)),
    });
  }
  if (!paths.length) {
    dropHeldPaste(target, id);
    return false;
  }
  const links = imageMarkdown(paths);
  if (!insertHeldPaste(target, id, (state) => plainChange(state, links, userEvent))) {
    ctx.notify({
      kind: 'warning',
      sticky: true,
      text: linksNotInText(paths, cameBy(userEvent)),
      actions: [copyAction(ctx, paths.length === 1 ? 'Copy link' : 'Copy links', links)],
    });
    return false;
  }
  return true;
}
