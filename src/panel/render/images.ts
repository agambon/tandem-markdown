// Images: `![alt](path "title")`, `![alt][label]` and `![[file.png]]` draw the image in place
// of their source, alone on a line as a block, else in the text (docs/ARCHITECTURE.md,
// "Tables, links, images and front matter"). Revealed, the source shows, marks faded, and a
// block image stays drawn after it, so the page does not jump while it is edited. The sizes
// other programs write are applied (an embed's alias as Obsidian and Foam read it, and under
// their settings markdown/pictureSize.ts's forms and a size after the alt text); an address
// ending in `#gh-dark-mode-only` or `#only-dark` (or `light`) shows in that theme only; and
// under `tandemMarkdown.syntax.media` a video or sound file is a player, never set to play.
//
// What may be loaded is the host's to say (`resolveImages`), except a picture stored in the
// file: a loadable address, or the reason it is not shown, in a small box with the path. Each
// image's natural size is kept in the panel's saved state, so its box has its shape early.

import { EditorView, ViewPlugin } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';
import { attribute, readAttributes } from '../../core/attributes';
import type { ImageAnswer } from '../../core/featureProtocol';
import { isImagePath, mediaKindOf, type MediaKind } from '../../core/fileKinds';
import { panelContext, type PanelContext } from '../context';
import type { Feature } from '../features';
import { HostAnswers } from '../hostAnswers';
import type { PictureAttributes } from '../html/door';
import { storedPictureRefusal } from '../html/storedPicture';
import {
  definitionLookup,
  definitionsField,
  definitionsKey,
  linkParts,
  wikilinkOf,
  type DefinitionLookup,
} from '../links/read';
import { inTableCell, NO_INLINE } from '../markdown/nodes';
import { syntaxOn } from '../syntax';
import { icon as iconOf } from '../ui/dom';
import { inlineFeature, RichWidget, type InlineDraw } from './framework';
import { markRange } from './layout';
import { LruCache } from './lruCache';

/** Most sources in one `resolveImages` request. */
const BATCH = 300;
/** Sizes kept in the saved state. */
const CACHE_SIZE = 400;
const SIZES_KEY = 'tmImageSizes';
const SAVE_DELAY_MS = 500;

const NO_ANSWER_REASON = 'Could not be checked';
const LOAD_FAILED_REASON = 'Could not be loaded';
const NO_ADDRESS_REASON = 'No address';

// ---------------------------------------------------------------------------
// The answers and the remembered sizes, one store per panel

type Watcher = (answer: ImageAnswer | undefined) => void;

class ImageStore {
  private readonly answers: HostAnswers<ImageAnswer>;
  private readonly watchers = new Map<string, Set<Watcher>>();
  private sizes: LruCache<string, [number, number]> | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private allowRemote: boolean;

  constructor(private readonly ctx: PanelContext) {
    this.allowRemote = ctx.settings.imagesAllowRemote;
    this.answers = new HostAnswers<ImageAnswer>({
      ask: (sources) => ctx.request({ type: 'resolveImages', sources }),
      batch: BATCH,
      // An image the host gave no answer for is drawn as one that could not be checked.
      read: (value) => readAnswer(value) ?? { reason: NO_ANSWER_REASON },
      same: sameAnswer,
      changed: (sources) => {
        for (const source of sources) {
          const answer = this.answers.get(source);
          for (const fn of [...(this.watchers.get(source) ?? [])]) fn(answer);
        }
      },
      failed: (error) => ctx.log('warn', 'VS Code did not say which images can be shown', error),
    });
  }

  get(source: string): ImageAnswer | undefined {
    if (source === '') return { reason: NO_ADDRESS_REASON };
    if (isStored(source)) {
      const refusal = storedPictureRefusal(source);
      return refusal ? { reason: refusal } : { uri: source };
    }
    return this.answers.get(source);
  }

  want(source: string): void {
    if (source !== '' && !isStored(source)) this.answers.want(source);
  }

  flushSoon(): void {
    this.answers.flushSoon();
  }

  /**
   * Calls `fn` with the answer now and whenever it changes, so a drawn image follows its
   * answer. Returns the unsubscribe.
   */
  watch(source: string, fn: Watcher): () => void {
    let set = this.watchers.get(source);
    if (!set) this.watchers.set(source, (set = new Set()));
    set.add(fn);
    fn(this.get(source));
    return () => {
      set.delete(fn);
      if (set.size === 0) this.watchers.delete(source);
    };
  }

  /**
   * Something that changes the answers happened (the files changed, `linksChanged`, or
   * `imagesAllowRemote` changed): ask again for what is drawn, forget the rest.
   */
  refresh(): void {
    for (const source of this.answers.keys()) if (!this.watchers.has(source)) this.answers.forget(source);
    this.answers.refresh([...this.watchers.keys()].filter((source) => source !== '' && !isStored(source)));
  }

  settingsChanged(): void {
    const now = this.ctx.settings.imagesAllowRemote;
    if (now === this.allowRemote) return;
    this.allowRemote = now;
    this.refresh();
  }
  // Sizes: each image's natural size, under SIZES_KEY in `bridge.setState`. The editor measures
  // again when an image loads.

  private loadSizes(): LruCache<string, [number, number]> {
    if (this.sizes) return this.sizes;
    this.sizes = new LruCache(CACHE_SIZE);
    try {
      const saved = (this.ctx.bridge.getState<Record<string, unknown>>() ?? {})[SIZES_KEY];
      if (saved && typeof saved === 'object') {
        for (const [source, size] of Object.entries(saved as Record<string, unknown>)) {
          if (
            Array.isArray(size) &&
            size.length === 2 &&
            size.every((n) => typeof n === 'number' && n > 0 && Number.isFinite(n))
          ) {
            this.sizes.set(source, [size[0], size[1]]);
          }
        }
      }
    } catch (error) {
      this.ctx.log('warn', 'Could not read the remembered image sizes', error);
    }
    return this.sizes;
  }

  size(source: string): [number, number] | undefined {
    return this.loadSizes().get(sizeKey(source));
  }

  rememberSize(source: string, width: number, height: number): void {
    if (!(width > 0 && height > 0)) return;
    const sizes = this.loadSizes();
    const key = sizeKey(source);
    const before = sizes.get(key);
    if (before && before[0] === width && before[1] === height) return;
    sizes.set(key, [width, height]);
    if (this.saveTimer !== null) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      try {
        const state = this.ctx.bridge.getState<Record<string, unknown>>() ?? {};
        this.ctx.bridge.setState({ ...state, [SIZES_KEY]: Object.fromEntries(sizes.entries()) });
      } catch (error) {
        this.ctx.log('warn', 'Could not remember the image sizes', error);
      }
    }, SAVE_DELAY_MS);
  }
}

/** A picture stored in the file, answered here: nothing is fetched, so the host is not asked. */
function isStored(source: string): boolean {
  return source.startsWith('data:');
}

/** How long the end of a stored picture's address is that names it among the remembered sizes. */
const STORED_KEY_TAIL = 48;

/** The key a picture's size is remembered by: a stored picture's whole address would fill the saved state. */
function sizeKey(source: string): string {
  return isStored(source) ? `data:${source.length}:${source.slice(-STORED_KEY_TAIL)}` : source;
}

function readAnswer(value: unknown): ImageAnswer | null {
  const v = value as { uri?: unknown; reason?: unknown } | null;
  if (!v || typeof v !== 'object') return null;
  if (typeof v.uri === 'string' && v.uri) return { uri: v.uri };
  if (typeof v.reason === 'string' && v.reason) return { reason: v.reason };
  return null;
}

function sameAnswer(a: ImageAnswer, b: ImageAnswer): boolean {
  return 'uri' in a ? 'uri' in b && a.uri === b.uri : 'reason' in b && a.reason === b.reason;
}

const stores = new WeakMap<PanelContext, ImageStore>();

/** The panel's image store: the host's answers for its image sources, and the sizes it remembers. */
export function imageStore(ctx: PanelContext): ImageStore {
  let store = stores.get(ctx);
  if (!store) stores.set(ctx, (store = new ImageStore(ctx)));
  return store;
}

// ---------------------------------------------------------------------------
// What an image draws as

type ImageView =
  { kind: 'loading'; path: string } | { kind: 'image'; src: string } | { kind: 'failed'; path: string; reason: string };

/** What the box for `source` shows, given the host's answer so far. */
export function describeImage(source: string, answer: ImageAnswer | undefined): ImageView {
  const path = source.startsWith('[[') && source.endsWith(']]') ? source.slice(2, -2) : source;
  if (!answer) return { kind: 'loading', path };
  if ('uri' in answer) return { kind: 'image', src: answer.uri };
  return { kind: 'failed', path: path || '(empty)', reason: answer.reason };
}

/**
 * Container marks before an image this long or longer are not looked at: no quote and list
 * nesting gets near it, and the pattern below takes time in the square of its length.
 */
const MAX_MARKS_BEFORE_IMAGE = 200;

/** True for an image node that is the only thing on its line (container marks aside). */
function aloneOnLine(d: InlineDraw, node: SyntaxNode, end = node.to): boolean {
  const line = d.lines.at(node.from);
  if (end > line.to || node.from - line.from > MAX_MARKS_BEFORE_IMAGE) return false;
  const before = line.text.slice(0, node.from - line.from);
  const after = line.text.slice(end - line.from);
  return /^[ \t>]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?)?[ \t>]*$/.test(before) && after.trim() === '';
}

const stops = new WeakMap<HTMLElement, () => void>();

/** A size the file gives a picture: pixels, or a CSS length with its unit (`50%`, `6.5in`). */
type Length = number | string;

/** Where a picture alone on its line sits, as Foam's embeds say. */
type Placement = 'left' | 'center' | 'right';

interface ImageSpec {
  /** The key the host is asked about: the address as written, or `[[target]]` for an embed. */
  address: string;
  alt: string;
  title: string;
  block: boolean;
  /** The size the file gives it. */
  width: Length | null;
  height: Length | null;
  /** Drawn after its revealed source rather than in place of it. */
  preview: boolean;
  /** Shown in this theme only. */
  theme: 'dark' | 'light' | null;
  placement?: Placement | null;
  /** A player for this kind of file rather than a picture. */
  media?: MediaKind | null;
}

class ImageWidget extends RichWidget {
  constructor(
    source: string,
    readonly spec: ImageSpec,
  ) {
    super(source);
  }

  override sameAs(other: ImageWidget): boolean {
    const a = this.spec;
    const b = other.spec;
    return (
      a.address === b.address &&
      a.alt === b.alt &&
      a.title === b.title &&
      a.block === b.block &&
      a.width === b.width &&
      a.height === b.height &&
      a.preview === b.preview &&
      a.theme === b.theme &&
      a.placement === b.placement &&
      a.media === b.media
    );
  }

  override get plainText(): string {
    return this.spec.alt;
  }

  draw(view: EditorView): HTMLElement {
    const ctx = this.ctx ?? view.state.facet(panelContext);
    if (!ctx) throw new Error('An image needs the panel context to ask the host for it');
    const { box, stop } = pictureBox(view, ctx, this.spec);
    stops.set(box, stop);
    return box;
  }

  override destroy(dom: HTMLElement): void {
    stops.get(dom)?.();
    stops.delete(dom);
  }

  /**
   * Clicks reach the editor: in Rich editor one places the cursor (and so shows the source); a
   * linked image opens its link. A player's clicks are its own.
   */
  override ignores(event: Event): boolean {
    return !!this.spec.media || !(event.type.startsWith('mouse') || event.type === 'click');
  }
}

/** A box for the picture `spec` describes, kept in step with the host's answer for it until `stop`. */
function pictureBox(view: EditorView, ctx: PanelContext, spec: ImageSpec): { box: HTMLElement; stop: () => void } {
  const box = view.dom.ownerDocument.createElement('span');
  let base = `tm-image ${spec.block ? 'tm-image-block' : 'tm-image-inline'}`;
  if (spec.preview) base += ' tm-image-preview';
  if (spec.theme) base += ` tm-only-${spec.theme}`;
  if (spec.placement && spec.block) base += ` tm-image-${spec.placement}`;
  if (spec.media) base += ` tm-media`;
  box.className = base;
  if (typeof spec.width === 'string' && spec.width.endsWith('%')) box.style.width = spec.width;
  const store = imageStore(ctx);
  let shown: ImageView | null = null;
  const show = (answer: ImageAnswer | undefined) => {
    const next = describeImage(spec.address, answer);
    if (
      shown &&
      shown.kind === next.kind &&
      (next.kind !== 'image' || (shown.kind === 'image' && shown.src === next.src))
    )
      return;
    shown = next;
    fill(view, box, base, next, spec, store);
  };
  return { box, stop: store.watch(spec.address, show) };
}

/** A picture in an HTML drawing (render/htmlDrawing.ts). */
interface DrawingPicture {
  address: string;
  alt: string;
  title: string;
  width: Length | null;
  height: Length | null;
  theme: 'dark' | 'light' | null;
}

/**
 * The box for a picture in an HTML drawing, not a widget of its own: the host is asked for
 * `picture.address` as for any picture, and `stop` ends the watch of its answer.
 */
export function drawingPicture(
  view: EditorView,
  ctx: PanelContext,
  picture: DrawingPicture,
): { box: HTMLElement; stop: () => void } {
  const store = imageStore(ctx);
  store.want(picture.address);
  store.flushSoon();
  const theme = picture.theme ?? themeOf(ctx, picture.address);
  return pictureBox(view, ctx, { ...picture, theme, block: false, preview: false });
}

/**
 * Calls `fn` with the host's answer for `address` now and whenever it changes, as a picture's
 * box is kept; for a player in an HTML drawing (render/htmlDrawing.ts). Returns the stop.
 */
export function watchAddress(
  ctx: PanelContext,
  address: string,
  fn: (answer: ImageAnswer | undefined) => void,
): () => void {
  const store = imageStore(ctx);
  store.want(address);
  store.flushSoon();
  return store.watch(address, fn);
}

/** The theme a picture's address keeps it to (`#gh-dark-mode-only`, `#only-dark`), under `themePictures`. */
function themeOf(ctx: PanelContext, address: string): 'dark' | 'light' | null {
  const theme = /#(?:gh-(dark|light)-mode-only|only-(dark|light))$/.exec(address);
  if (!theme || !syntaxOn(ctx.settings, 'themePictures')) return null;
  return (theme[1] ?? theme[2]) as 'dark' | 'light';
}

/** Sets the size the file gives a picture on its `img`, when one is not in pixels. */
function cssSize(img: HTMLImageElement, spec: ImageSpec): void {
  if (typeof spec.width === 'string') img.style.width = spec.width.endsWith('%') ? '100%' : spec.width;
  if (typeof spec.height === 'string') img.style.height = spec.height;
}

function fill(
  view: EditorView,
  box: HTMLElement,
  base: string,
  what: ImageView,
  spec: ImageSpec,
  store: ImageStore,
): void {
  const doc = box.ownerDocument;
  const remembered = store.size(spec.address);
  box.removeAttribute('title');
  if (what.kind === 'image' && spec.media) {
    const player = doc.createElement(spec.media);
    player.className = 'tm-media-player';
    player.controls = true;
    player.preload = 'metadata';
    if (spec.title) player.title = spec.title;
    if (typeof spec.width === 'number') player.style.width = `${spec.width}px`;
    else if (spec.width) player.style.width = spec.width;
    player.addEventListener('loadedmetadata', () => {
      box.className = `${base} tm-image-loaded`;
      view.requestMeasure();
    });
    player.addEventListener('error', () => {
      fill(view, box, base, describeImage(spec.address, { reason: LOAD_FAILED_REASON }), spec, store);
    });
    box.className = `${base} tm-image-loading`;
    player.src = what.src;
    box.replaceChildren(player);
  } else if (what.kind === 'image') {
    const img = doc.createElement('img');
    img.className = 'tm-image-img';
    img.alt = spec.alt;
    if (spec.title) img.title = spec.title;
    img.draggable = false;
    img.decoding = 'async';
    const ratio = remembered ? remembered[1] / remembered[0] : null;
    const width = typeof spec.width === 'number' ? spec.width : null;
    const height = typeof spec.height === 'number' ? spec.height : null;
    if (typeof spec.width === 'string' || typeof spec.height === 'string') {
      cssSize(img, spec);
      if (width) img.width = width;
      if (height) img.height = height;
    } else if (width) {
      img.width = width;
      if (height) img.height = height;
      else if (ratio) img.height = Math.round(width * ratio);
    } else if (height && ratio) {
      img.height = height;
      img.width = Math.round(height / ratio);
    } else if (remembered) {
      img.width = remembered[0];
      img.height = remembered[1];
    }
    img.addEventListener('load', () => {
      store.rememberSize(spec.address, img.naturalWidth, img.naturalHeight);
      box.className = `${base} tm-image-loaded`;
      view.requestMeasure();
    });
    img.addEventListener('error', () => {
      fill(view, box, base, describeImage(spec.address, { reason: LOAD_FAILED_REASON }), spec, store);
    });
    box.className = `${base} tm-image-loading`;
    img.src = what.src;
    box.replaceChildren(img);
  } else if (what.kind === 'loading') {
    box.className = `${base} tm-image-loading`;
    const holder = doc.createElement('span');
    holder.className = 'tm-image-holder';
    if (remembered && spec.block && typeof spec.width !== 'string') {
      // The shape it will have, so the page does not move when it loads.
      holder.style.aspectRatio = `${remembered[0]} / ${remembered[1]}`;
      holder.style.width = `${spec.width ?? remembered[0]}px`;
      holder.style.minHeight = '0';
      holder.style.padding = '0';
    } else {
      holder.textContent = what.path;
    }
    box.replaceChildren(holder);
  } else {
    box.className = `${base} tm-image-failed`;
    const icon = iconOf(doc, 'file-media');
    icon.classList.add('tm-image-icon');
    const path = doc.createElement('span');
    path.className = 'tm-image-path';
    path.textContent = what.path;
    const reason = doc.createElement('span');
    reason.className = 'tm-image-reason';
    reason.textContent = what.reason;
    box.replaceChildren(icon, path, reason);
    box.title = `${what.path}: ${what.reason}`;
  }
  view.requestMeasure();
}

// ---------------------------------------------------------------------------
// Drawing

const SKIP = new Set([...NO_INLINE, 'Table']);

/**
 * Draws the picture `node` in place of its source, or with `end` given (its braces after it),
 * in place of everything up to there: braces show and hide with the picture's marks.
 */
function place(
  d: InlineDraw,
  node: SyntaxNode,
  spec: Omit<ImageSpec, 'preview'>,
  marks: () => void,
  end = node.to,
): void {
  const source = d.doc.sliceString(node.from, end);
  const oneLine = end <= d.lines.at(node.from).to;
  if (!d.revealed(node.from, end) && oneLine) {
    d.replace(node.from, end, new ImageWidget(source, { ...spec, preview: false }));
    return;
  }
  // Revealed (or written over more than one line, which cannot be replaced inline): the
  // source with faded marks, and a block image drawn after it.
  marks();
  if (spec.block || !oneLine) d.widget(end, new ImageWidget(source, { ...spec, block: true, preview: true }), 1);
}

/** A CSS length the file gives (`300`, `300px`, `50%`, `6.5in`, quoted or not): pixels as a number. */
function lengthOf(text: string | null | undefined): Length | null {
  const match = /^\s*["']?(\d{1,5}(?:\.\d{1,4})?)(px|%|in|cm|mm|pt|pc|em|rem|ex|ch)?["']?\s*$/i.exec(text ?? '');
  if (!match) return null;
  const unit = match[2]?.toLowerCase() ?? 'px';
  return unit === 'px' ? Number(match[1]) : `${match[1]}${unit}`;
}

/** A size written `300` or `300x200`, in pixels. */
const SIZE = /^\s*(\d{1,5})(?:\s*x\s*(\d{1,5}))?\s*$/i;

/** The size after the alt text, `alt|300` or `alt|300x200` (Obsidian): the alt text before it, and the size. */
function altSize(alt: string): { alt: string; width: Length | null; height: Length | null } {
  const bar = alt.lastIndexOf('|');
  const size = bar >= 0 ? SIZE.exec(alt.slice(bar + 1)) : null;
  if (!size) return { alt, width: null, height: null };
  return { alt: alt.slice(0, bar), width: Number(size[1]), height: size[2] ? Number(size[2]) : null };
}

/** The width and height in the braces `node` after a picture: Pandoc's `width=50%`, or Logseq's `:width 300`. */
function braceSize(d: InlineDraw, node: SyntaxNode): { width: Length | null; height: Length | null } {
  const text = d.doc.sliceString(node.from, node.to);
  const attributes = node.name === 'ImageAttributes' ? readAttributes(text) : null;
  const value = (name: string) =>
    attributes ? attribute(attributes, name) : new RegExp(`:${name}\\s+(\\d{1,5})`).exec(text)?.[1];
  return { width: lengthOf(value('width')), height: lengthOf(value('height')) };
}

/** Azure's ` =300x200`, either number left out. */
function azureSize(text: string): { width: Length | null; height: Length | null } {
  const match = /=(\d*)x(\d*)/.exec(text);
  return { width: match?.[1] ? Number(match[1]) : null, height: match?.[2] ? Number(match[2]) : null };
}

const BRACES = new Set(['ImageAttributes', 'LogseqImageAttributes']);

function drawImage(d: InlineDraw, node: SyntaxNode, defs: DefinitionLookup, store: ImageStore): void {
  const parts = linkParts(d.doc, node, defs);
  if (!parts) return; // a reference to an undefined label: plain text
  const address = parts.href;
  store.want(address);
  let alt = d.doc.sliceString(parts.textFrom, parts.textTo);
  // In a table cell `\|` is a pipe (GFM), so a size after the alt text is written `alt\|300` there.
  if (inTableCell(node)) alt = alt.replaceAll('\\|', '|');
  let size: { width: Length | null; height: Length | null } = { width: null, height: null };
  if (syntaxOn(d.ctx.settings, 'pictureSizes')) ({ alt, ...size } = altSize(alt));
  const azure = node.getChild('ImageSize');
  if (azure) size = azureSize(d.doc.sliceString(azure.from, azure.to));
  const after = node.nextSibling;
  const braces = after && after.from === node.to && BRACES.has(after.name) ? after : null;
  if (braces) size = braceSize(d, braces);
  const spec = {
    address,
    alt,
    title: parts.title ?? '',
    block: aloneOnLine(d, node, braces?.to),
    ...size,
    theme: themeOf(d.ctx, address),
    media: syntaxOn(d.ctx.settings, 'media') ? mediaKindOf(address) : null,
  };
  const marks = () => {
    for (let c = node.firstChild; c; c = c.nextSibling) {
      if (
        c.name === 'LinkMark' ||
        c.name === 'URL' ||
        c.name === 'LinkTitle' ||
        c.name === 'LinkLabel' ||
        c.name === 'ImageSize'
      )
        markRange(d, c.from, c.to, 'tm-mark');
    }
    if (braces) d.mark(braces.from, braces.to, 'tm-mark');
  };
  place(d, node, spec, marks, braces?.to);
}

/** Draws an HTML `<img>` in a line in place of its tag (render/html.ts), as the host answers for its `src`. */
export function htmlPicture(d: InlineDraw, from: number, to: number, picture: PictureAttributes): void {
  const store = imageStore(d.ctx);
  store.want(picture.src);
  store.flushSoon();
  const spec = {
    ...picture,
    address: picture.src,
    block: false,
    preview: false,
    theme: themeOf(d.ctx, picture.src),
  };
  d.replace(from, to, new ImageWidget(d.doc.sliceString(from, to), spec));
}

/**
 * Whether this feature draws the embed of `target` (`![[target]]`): a picture, or under
 * `tandemMarkdown.syntax.media` a video or sound file. Any other embed is a link (render/wikilinks.ts).
 */
export function embedDrawn(ctx: PanelContext, target: string): boolean {
  return isImagePath(target) || (syntaxOn(ctx.settings, 'media') && mediaKindOf(target) !== null);
}

const PLACEMENTS = new Set<string>(['left', 'center', 'right']);

/**
 * An embed's alias read as Obsidian and Foam read it: a size (`300`, `300x200`, `50%`,
 * `20em`), then, after another `|`, where it sits or its alt text; anything else is alt text.
 */
function embedAlias(alias: string | undefined): {
  alt: string;
  width: Length | null;
  height: Length | null;
  placement: Placement | null;
} {
  const none = { alt: alias ?? '', width: null, height: null, placement: null };
  if (!alias) return none;
  const [first = '', ...rest] = alias.split('|');
  const pixels = SIZE.exec(first);
  const width = pixels ? Number(pixels[1]) : lengthOf(first);
  if (width === null) return none;
  const after = rest.join('|').trim();
  const placement = PLACEMENTS.has(after.toLowerCase()) ? (after.toLowerCase() as Placement) : null;
  return {
    alt: placement ? '' : after,
    width,
    height: pixels?.[2] ? Number(pixels[2]) : null,
    placement,
  };
}

function drawEmbed(d: InlineDraw, node: SyntaxNode, store: ImageStore): void {
  const link = wikilinkOf(d.doc, node);
  if (!embedDrawn(d.ctx, link.target)) return;
  const address = `[[${link.target}]]`;
  store.want(address);
  const spec = {
    address,
    title: '',
    block: aloneOnLine(d, node),
    ...embedAlias(link.alias),
    theme: null,
    media: isImagePath(link.target) ? null : mediaKindOf(link.target),
  };
  place(d, node, spec, () => {
    for (const m of node.getChildren('WikilinkMark')) d.mark(m.from, m.to, 'tm-mark');
  });
}

export const images: Feature = {
  id: 'images',
  extension: (ctx) => [
    definitionsField,
    inlineFeature(
      'images',
      (d) => {
        const store = imageStore(d.ctx);
        const defs = definitionLookup(d.state);
        d.iterate((ref) => {
          if (SKIP.has(ref.name)) return false;
          if (ref.name === 'Image') {
            drawImage(d, ref.node, defs, store);
            return false;
          }
          if (ref.name === 'Embed') {
            drawEmbed(d, ref.node, store);
            return false;
          }
          return true;
        });
        store.flushSoon();
      },
      { reads: definitionsKey },
    ),
    // The host says the files changed, or remote images were switched on or off: ask again.
    ViewPlugin.define((view) => {
      const panel = view.state.facet(panelContext) ?? ctx;
      const store = imageStore(panel);
      const stopMessages = panel.bridge.onMessage((message) => {
        if (message.type === 'linksChanged') store.refresh();
      });
      const stopSettings = panel.onSettingsChange(() => store.settingsChanged());
      return {
        destroy() {
          stopMessages();
          stopSettings();
        },
      };
    }),
    EditorView.baseTheme({
      '& .cm-content .tm-image': {
        display: 'inline-block',
        maxWidth: '100%',
        verticalAlign: 'bottom',
        lineHeight: 'normal',
      },
      '& .cm-content .tm-image-block': { padding: '4px 0' },
      '& .cm-content .tm-image-preview': { display: 'inline-block', width: '100%' },
      '& .cm-content .tm-image-img': { display: 'block', maxWidth: '100%', height: 'auto' },
      '& .cm-content .tm-image-inline .tm-image-img': { display: 'inline-block', verticalAlign: 'text-bottom' },
      '& .cm-content .tm-image-holder': {
        display: 'inline-block',
        maxWidth: '100%',
        minHeight: '1.6em',
        color: 'var(--tm-faded)',
        fontSize: '0.85em',
        background: 'var(--tm-code-bg)',
        borderRadius: '3px',
        padding: '0 6px',
        boxSizing: 'border-box',
      },
      '& .cm-content .tm-image-block .tm-image-holder': { minHeight: '100px', display: 'block' },
      '& .cm-content .tm-image-failed': {
        display: 'inline-flex',
        alignItems: 'baseline',
        gap: '6px',
        maxWidth: '100%',
        padding: '2px 8px',
        border: '1px dashed var(--tm-border)',
        borderRadius: '3px',
        color: 'var(--tm-faded)',
        fontSize: '0.85em',
        overflowWrap: 'anywhere',
      },
      '& .cm-content .tm-image-icon': { alignSelf: 'center' },
      '& .cm-content .tm-image-path': { fontFamily: 'var(--tm-mono)' },
      '& .cm-content .tm-image-reason::before': { content: '"·"', marginRight: '6px' },
      '& .cm-content .tm-media-player': { display: 'block', maxWidth: '100%' },
      '& .cm-content .tm-image-center': { display: 'block', width: 'fit-content', margin: '0 auto' },
      '& .cm-content .tm-image-right': { display: 'block', width: 'fit-content', marginLeft: 'auto' },
      // A picture for one theme: VS Code puts the theme's kind on <body>.
      '.vscode-light & .cm-content .tm-only-dark, .vscode-high-contrast-light & .cm-content .tm-only-dark': {
        display: 'none',
      },
      '.vscode-dark & .cm-content .tm-only-light, .vscode-high-contrast:not(.vscode-high-contrast-light) & .cm-content .tm-only-light':
        { display: 'none' },
    }),
  ],
};
