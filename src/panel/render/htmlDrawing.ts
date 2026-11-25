// What a drawing of a file's HTML does once on the page (the door's nodes, html/door.ts, drawn
// by render/htmlBlocks.ts and render/html.ts): its pictures and players are loaded under the
// host's rule as every picture is, its links open as markdown links do, and the page never
// follows them.

import type { EditorView } from '@codemirror/view';
import type { PanelContext } from '../context';
import { sizeInPixels } from '../html/blocks';
import type { DoorOptions } from '../html/door';
import { kindOf } from '../links/read';
import { getMode } from '../modes';
import { syntaxOn } from '../syntax';
import { keysFollowLink } from './follow';
import { drawingPicture, watchAddress } from './images';
import { openTarget } from './links';

/**
 * The door's options for HTML this module brings to life: every address that loads goes
 * through the host's rule here, which follows `tandemMarkdown.images.allowRemote` as it changes,
 * so the door keeps https ones; players are kept under `tandemMarkdown.syntax.media`.
 */
export function drawingOptions(ctx: PanelContext): DoorOptions {
  return { allowRemote: true, media: syntaxOn(ctx.settings, 'media'), address: (_kind, value) => value };
}

/** A `<source>` meant for one theme: its `media` names `prefers-color-scheme`. */
const THEME_SOURCE = /prefers-color-scheme\s*:\s*(dark|light)/i;

function firstAddress(srcset: string): string {
  return srcset.trim().split(/[\s,]+/)[0] ?? '';
}

/**
 * Makes the door's nodes in `root` live in the page: each picture asks the host for its
 * address (a `<picture>` becomes its pictures for the dark and the light theme, CSS showing
 * the one for the theme in use), and so does each player (`<video>`, `<audio>`), which never
 * plays by itself; each link opens as links do and is reached with Tab in Rich view, and a
 * `<details>` that opens or closes has the editor measure again. Returns what stops the
 * watches of the host's answers. Must run before `root` is in the page, where an address
 * would be fetched.
 */
export function bringToLife(view: EditorView, ctx: PanelContext, root: HTMLElement): () => void {
  const stops: (() => void)[] = [];
  for (const player of [...root.querySelectorAll<HTMLMediaElement>('video, audio')]) {
    const sources = [...player.querySelectorAll('source')];
    const address = player.getAttribute('src') ?? sources.find((s) => s.getAttribute('src'))?.getAttribute('src') ?? '';
    const poster = player.getAttribute('poster');
    player.removeAttribute('src');
    player.removeAttribute('poster');
    for (const source of sources) source.remove();
    player.controls = true;
    player.preload = 'metadata';
    player.classList.add('tm-media-player');
    player.addEventListener('loadedmetadata', () => view.requestMeasure());
    stops.push(
      watchAddress(ctx, address, (answer) => {
        if (answer && 'uri' in answer) {
          if (player.getAttribute('src') !== answer.uri) player.src = answer.uri;
          player.removeAttribute('title');
        } else if (answer) {
          player.removeAttribute('src');
          player.title = `${address || '(empty)'}: ${answer.reason}`;
        }
      }),
    );
    if (poster && player instanceof HTMLVideoElement) {
      stops.push(
        watchAddress(ctx, poster, (answer) => {
          if (answer && 'uri' in answer) player.poster = answer.uri;
        }),
      );
    }
  }
  const picture = (address: string, img: Element | null, theme: 'dark' | 'light' | null) => {
    const drawn = drawingPicture(view, ctx, {
      address,
      alt: img?.getAttribute('alt') ?? '',
      title: img?.getAttribute('title') ?? '',
      width: sizeInPixels(img?.getAttribute('width')),
      height: sizeInPixels(img?.getAttribute('height')),
      theme,
    });
    const align = img?.getAttribute('align')?.toLowerCase();
    if (align === 'left' || align === 'right') drawn.box.classList.add(`tm-html-float-${align}`);
    stops.push(drawn.stop);
    return drawn.box;
  };
  // Taken before any picture is drawn: a box whose answer is known holds an `img` at once.
  const pictures = [...root.querySelectorAll('picture')];
  const images = [...root.querySelectorAll('img')].filter((img) => !img.closest('picture'));
  for (const element of pictures) {
    const img = element.querySelector('img');
    const fallback = img?.getAttribute('src') ?? '';
    const chosen = { dark: fallback, light: fallback };
    for (const source of element.querySelectorAll('source')) {
      const theme = THEME_SOURCE.exec(source.getAttribute('media') ?? '')?.[1]?.toLowerCase() as 'dark' | 'light';
      if (theme && chosen[theme] === fallback) chosen[theme] = firstAddress(source.getAttribute('srcset') ?? '');
    }
    element.replaceWith(
      ...(chosen.dark === chosen.light
        ? [picture(chosen.dark, img, null)]
        : [picture(chosen.dark, img, 'dark'), picture(chosen.light, img, 'light')]),
    );
  }
  for (const img of images) img.replaceWith(picture(img.getAttribute('src') ?? '', img, null));
  for (const link of root.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    const href = link.getAttribute('href')!;
    // `tm-stop`: Tab reaches it in Rich view (ui/viewKeys.ts), and only that moves focus to it.
    link.classList.add('tm-link', 'tm-stop');
    link.tabIndex = -1;
    const open = () => openTarget(view, { kind: kindOf(href), href, from: 0, to: 0 });
    // Opened on the keys any link opens on (`keysFollowLink`), in Rich editor on the press, since a
    // plain click there leaves the focus in the text. Only the keys are read: a press on a link
    // leaves the page's selection as it was. The page never follows the link itself.
    link.addEventListener('mousedown', (event) => {
      if (event.button !== 0 || getMode(view.state) !== 'edit') return;
      event.preventDefault();
      if (keysFollowLink(view, event)) open();
    });
    link.addEventListener('click', (event) => {
      event.preventDefault();
      if (event.button === 0 && getMode(view.state) === 'view') open();
    });
    link.addEventListener('auxclick', (event) => event.preventDefault());
  }
  for (const details of root.querySelectorAll('details'))
    details.addEventListener('toggle', () => view.requestMeasure());
  return () => {
    for (const stop of stops) stop();
  };
}
