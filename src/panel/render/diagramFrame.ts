// The frame Mermaid draws in (docs/ARCHITECTURE.md, "Diagrams"). Mermaid cannot draw under
// the page's content policy, and a diagram can be made to hang it, so it runs in a hidden
// `<iframe sandbox="allow-scripts">` of its own: an opaque origin that cannot reach the page,
// its storage or its cookies, and that the browser may run in another process. The frame's
// document is fixed markup of the panel's own; it keeps the page's policy and adds its own,
// which allows the page's nonce for scripts and nothing else, so nothing in it loads or is
// fetched. Its code (render/frame/main.ts, built into dist/panel/diagram-frame.js) is loaded
// by the page on first use and handed over by message.
//
// The page sends one diagram at a time and waits DRAW_TIMEOUT_MS for the picture. A frame that
// does not answer in time is removed, so whatever hangs it goes with it, and the next diagram
// is drawn in a new one. Pictures are kept by their text and theme.

import { loadAsset } from '../assets';
import { onDemand } from '../onDemand';
import type { DiagramPicture, FromFrame, ToFrame } from './diagramProtocol';
import { LruCache } from './lruCache';

/** How long one diagram may take to draw before its frame is given up. */
const DRAW_TIMEOUT_MS = 20_000;
/** How long a new frame may take to start Mermaid. */
const START_TIMEOUT_MS = 30_000;
/** The width of the frame's page, which a few kinds of diagram (gantt) fill. */
const FRAME_WIDTH = 860;
/** Pictures kept by text and theme. */
const CACHE_SIZE = 100;
/** The longest picture accepted from the frame, in characters. */
const MAX_PICTURE_CHARS = 4_000_000;

/** The frame's code, as text. */
export const diagramCode = onDemand<string>(async () => {
  const module = (await loadAsset('diagram-frame.js')) as { default?: unknown };
  if (typeof module.default !== 'string') throw new Error('The diagram frame’s code did not load');
  return module.default;
});

let report: (directive: string) => void = () => {};

/** Where a content-policy violation inside the frame is told; the frame should never report one. */
export function onFrameViolation(listener: (directive: string) => void): void {
  report = listener;
}

/** The markup of the frame's document: the page's nonce, and a script that runs the code it is sent. */
function frameDocument(nonce: string): string {
  const boot =
    'addEventListener("message",function take(e){var m=e.data;' +
    'if(e.source!==parent||!m||m.type!=="code"||typeof m.code!=="string")return;' +
    'removeEventListener("message",take);var s=document.createElement("script");' +
    `s.nonce=${JSON.stringify(nonce)};s.text=m.code;document.head.appendChild(s);});` +
    'parent.postMessage({type:"up"},"*");';
  const policy = `default-src 'none'; script-src 'nonce-${nonce}'`;
  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    `<meta http-equiv="Content-Security-Policy" content="${policy}">` +
    `</head><body><script nonce="${nonce}">${boot}</script></body></html>`
  );
}

function pageNonce(doc: Document): string | null {
  const nonce = doc.querySelector('meta[name="tm-csp-nonce"]')?.getAttribute('content') ?? '';
  return /^[A-Za-z0-9+/=_-]+$/.test(nonce) ? nonce : null;
}

function isPicture(value: unknown): value is DiagramPicture {
  const p = value as Partial<DiagramPicture> | null;
  return (
    !!p &&
    typeof p.svg === 'string' &&
    p.svg.length <= MAX_PICTURE_CHARS &&
    p.svg.startsWith('<svg') &&
    typeof p.width === 'number' &&
    p.width > 0 &&
    typeof p.height === 'number' &&
    p.height > 0 &&
    typeof p.label === 'string'
  );
}

interface Waiting {
  resolve(picture: DiagramPicture): void;
  reject(error: Error): void;
}

/** One frame and the diagram it is drawing. */
class Frame {
  readonly element: HTMLIFrameElement;
  private readonly started: Promise<void>;
  private waiting: { id: number; answer: Waiting } | null = null;
  private onStarted: (() => void) | null = null;
  private stop: () => void;

  constructor(doc: Document, nonce: string, code: string) {
    const frame = doc.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('aria-hidden', 'true');
    frame.tabIndex = -1;
    frame.className = 'tm-diagram-frame';
    const s = frame.style;
    s.position = 'fixed';
    s.left = '-20000px';
    s.top = '0';
    s.width = `${FRAME_WIDTH}px`;
    s.height = '600px';
    s.border = '0';
    s.pointerEvents = 'none';
    frame.srcdoc = frameDocument(nonce);
    this.element = frame;
    const listener = (event: MessageEvent) => {
      if (event.source !== frame.contentWindow) return;
      this.receive(event.data as FromFrame | null, code);
    };
    const win = doc.defaultView!;
    win.addEventListener('message', listener);
    this.stop = () => win.removeEventListener('message', listener);
    this.started = new Promise((resolve) => (this.onStarted = resolve));
    doc.body.appendChild(frame);
  }

  private receive(message: FromFrame | null, code: string): void {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'up') {
      this.element.contentWindow?.postMessage({ type: 'code', code } satisfies ToFrame, '*');
    } else if (message.type === 'ready') {
      this.onStarted?.();
    } else if (message.type === 'violation') {
      report(String(message.directive));
    } else if ((message.type === 'drawn' || message.type === 'failed') && this.waiting?.id === message.id) {
      const { answer } = this.waiting;
      this.waiting = null;
      if (message.type === 'failed') answer.reject(new Error(String(message.message)));
      else if (isPicture(message.picture)) answer.resolve(message.picture);
      else answer.reject(new Error('The diagram could not be shown.'));
    }
  }

  /** `text` drawn; rejects with what is wrong, or when the frame takes too long. */
  async draw(id: number, text: string, dark: boolean): Promise<DiagramPicture> {
    await withTimeout(this.started, START_TIMEOUT_MS, 'Mermaid did not start.');
    const answered = new Promise<DiagramPicture>((resolve, reject) => {
      this.waiting = { id, answer: { resolve, reject } };
    });
    this.element.contentWindow?.postMessage({ type: 'draw', id, text, dark } satisfies ToFrame, '*');
    return withTimeout(
      answered,
      DRAW_TIMEOUT_MS,
      `Not drawn: drawing it took longer than ${DRAW_TIMEOUT_MS / 1000} seconds.`,
    );
  }

  remove(): void {
    this.stop();
    this.element.remove();
  }
}

class TimedOut extends Error {}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimedOut(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

let frame: Frame | null = null;
let nextId = 0;
let queue: Promise<unknown> = Promise.resolve();
const pictures = new LruCache<string, Promise<DiagramPicture>>(CACHE_SIZE);

async function drawNow(text: string, dark: boolean): Promise<DiagramPicture> {
  const code = diagramCode.loaded();
  if (code === undefined) throw new Error('Diagrams could not be drawn: what draws them did not load.');
  const nonce = pageNonce(document);
  if (!nonce) throw new Error('Diagrams cannot be drawn on this page.');
  frame ??= new Frame(document, nonce, code);
  const current = frame;
  try {
    return await current.draw(++nextId, text, dark);
  } catch (error) {
    if (error instanceof TimedOut && frame === current) {
      current.remove();
      frame = null;
    }
    throw error;
  }
}

/**
 * `text` drawn by Mermaid in the theme for a dark or a light page, or rejects with a short
 * message. Only once `diagramCode` has loaded. Diagrams are drawn one at a time; the same text and
 * theme give the same picture without drawing again.
 */
export function drawDiagram(text: string, dark: boolean): Promise<DiagramPicture> {
  const key = `${dark ? 'D' : 'L'}${text}`;
  let picture = pictures.get(key);
  if (!picture) {
    const drawing = queue.then(() => drawNow(text, dark));
    queue = drawing.catch(() => undefined);
    picture = drawing;
    pictures.set(key, picture);
  }
  return picture;
}
