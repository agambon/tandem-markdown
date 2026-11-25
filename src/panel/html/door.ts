// The one way HTML from a file reaches the page (docs/ARCHITECTURE.md, "HTML through one
// door"). The HTML is parsed into a detached document, where nothing loads or runs, cleaned by
// DOMPurify to GitHub's allow-list (html/elements.ts), and handed back as nodes, never as
// markup to be parsed again. Addresses are checked here: a link may use http, https, mailto,
// xmpp, irc or a relative path; a picture may come from a relative path, from https while the
// caller allows it, or from a PNG, JPEG, GIF or WebP stored in the file. The caller's
// `address` decides what a relative path becomes. With `media`, `<video>` and `<audio>` are
// kept, never set to play by themselves.
//
// A detached document takes the page's policy, which would report a `style` attribute or
// element, or an `on...` attribute, while parsing, though nothing runs there; so they are
// renamed first (html/renameInline.ts), and the allow-list drops them.

import createDOMPurify, { type Config } from 'dompurify';
import { escapeUnknownTags, sizeInPixels } from './blocks';
import { ALLOWED_ATTRIBUTES, ALLOWED_ELEMENTS, ELEMENT_ATTRIBUTES } from './elements';
import { cleanAddress, isLinkAddress, schemeOf } from './links';
import { RENAMED_STYLE_ELEMENT, renameInline } from './renameInline';
import { isStoredPicture } from './storedPicture';

export interface DoorOptions {
  /** Pictures from https addresses may load (`tandemMarkdown.images.allowRemote`). */
  allowRemote: boolean;
  /** `<video>` and `<audio>` are kept. */
  media?: boolean;
  /**
   * What a relative address (`kind` says whose) becomes on the page, or null to drop it. It is
   * not asked about an address with a scheme.
   */
  address(kind: AddressKind, value: string): string | null;
}

type AddressKind = 'link' | 'picture' | 'media';

/** Attributes holding addresses, and what each holds. */
const ADDRESSES: Readonly<Record<string, AddressKind>> = {
  href: 'link',
  cite: 'link',
  longdesc: 'link',
  src: 'picture',
  srcset: 'picture',
  poster: 'picture',
};

/** What `<video>` and `<audio>` keep with `media`: never `autoplay`. */
const MEDIA_ATTRIBUTES: Readonly<Record<string, readonly string[]>> = {
  video: ['src', 'poster', 'controls', 'loop', 'muted', 'preload'],
  audio: ['src', 'controls', 'loop', 'muted', 'preload'],
  source: ['src'],
};

const MEDIA_ELEMENTS = new Set(['video', 'audio']);

function attributeSets(media: boolean): Map<string, Set<string>> {
  const tags = media ? [...ALLOWED_ELEMENTS, ...MEDIA_ELEMENTS] : ALLOWED_ELEMENTS;
  return new Map(
    tags.map((tag) => [
      tag,
      new Set([...ALLOWED_ATTRIBUTES, ...(ELEMENT_ATTRIBUTES[tag] ?? []), ...((media && MEDIA_ATTRIBUTES[tag]) || [])]),
    ]),
  );
}

const attributesOf = attributeSets(false);
const mediaAttributesOf = attributeSets(true);

const CONFIG: Config = {
  ALLOWED_TAGS: [...ALLOWED_ELEMENTS],
  ALLOWED_ATTR: [...new Set([...ALLOWED_ATTRIBUTES, ...Object.values(ELEMENT_ATTRIBUTES).flat()])],
  ALLOW_ARIA_ATTR: false,
  ALLOW_DATA_ATTR: false,
  ALLOW_UNKNOWN_PROTOCOLS: false,
  ADD_FORBID_CONTENTS: [RENAMED_STYLE_ELEMENT],
  SANITIZE_NAMED_PROPS: true,
  RETURN_DOM_FRAGMENT: true,
};

const MEDIA_CONFIG: Config = {
  ...CONFIG,
  ALLOWED_TAGS: [...ALLOWED_ELEMENTS, ...MEDIA_ELEMENTS],
  ALLOWED_ATTR: [...new Set([...(CONFIG.ALLOWED_ATTR ?? []), ...Object.values(MEDIA_ATTRIBUTES).flat()])],
};

/** The options of the call in progress, which the attribute hook reads. */
let current: DoorOptions | null = null;
let instance: ReturnType<typeof createDOMPurify> | null = null;

/** DOMPurify with the attribute rules, made on first use (it needs the page's window). */
function purify(): ReturnType<typeof createDOMPurify> {
  if (instance) return instance;
  instance = createDOMPurify(window);
  instance.addHook('uponSanitizeAttribute', (node, data) => {
    const tag = node.nodeName.toLowerCase();
    if (!(current?.media ? mediaAttributesOf : attributesOf).get(tag)?.has(data.attrName)) {
      data.keepAttr = false;
      return;
    }
    const played = data.attrName === 'src' && (MEDIA_ELEMENTS.has(tag) || tag === 'source');
    const kind = played ? 'media' : ADDRESSES[data.attrName];
    if (!kind || !current) return;
    const value =
      data.attrName === 'srcset'
        ? checkSourceSet(data.attrValue, current)
        : checkAddress(kind, data.attrValue, current);
    if (value === null) data.keepAttr = false;
    else data.attrValue = value;
  });
  return instance;
}

/** The address as the page may use it, or null. */
function checkAddress(kind: AddressKind, raw: string, options: DoorOptions): string | null {
  const value = cleanAddress(raw);
  const scheme = schemeOf(value);
  if (scheme === '') return options.address(kind, value);
  if (kind === 'link') return isLinkAddress(value) ? value : null;
  if (scheme === 'https') return options.allowRemote ? value : null;
  if (scheme === 'data' && kind === 'picture') return isStoredPicture(value) ? value : null;
  return null;
}

/** A `srcset` with every address checked, or null when one of them may not load. */
function checkSourceSet(value: string, options: DoorOptions): string | null {
  const out: string[] = [];
  for (const entry of value.split(',')) {
    const [address, ...descriptor] = entry.trim().split(/\s+/);
    if (!address) continue;
    const checked = checkAddress('picture', address, options);
    if (checked === null) return null;
    out.push([checked, ...descriptor].join(' '));
  }
  return out.length ? out.join(', ') : null;
}

/**
 * `html` cleaned to the allow-list, as nodes in no document yet. Tag-shaped text that names no
 * HTML element (`<name>`) stays text, as typed.
 */
export function sanitizeHtml(html: string, options: DoorOptions): DocumentFragment {
  current = options;
  try {
    const config = options.media ? MEDIA_CONFIG : CONFIG;
    return purify().sanitize(renameInline(escapeUnknownTags(html)), config) as unknown as DocumentFragment;
  } finally {
    current = null;
  }
}

export interface PictureAttributes {
  src: string;
  alt: string;
  title: string;
  width: number | null;
  height: number | null;
}

/** The attributes of the `<img>` tag `tag`, as the allow-list leaves them, or null when it leaves no picture. */
export function pictureAttributes(tag: string, options: DoorOptions): PictureAttributes | null {
  const img = sanitizeHtml(tag, options).querySelector('img');
  const src = img?.getAttribute('src');
  if (!img || !src) return null;
  return {
    src,
    alt: img.getAttribute('alt') ?? '',
    title: img.getAttribute('title') ?? '',
    width: sizeInPixels(img.getAttribute('width')),
    height: sizeInPixels(img.getAttribute('height')),
  };
}
