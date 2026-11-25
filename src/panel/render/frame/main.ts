// The code that runs in the diagram frame (render/diagramFrame.ts), built on its own into
// dist/panel/diagram-frame.js and handed to the frame as text. It draws each diagram the page
// asks for with Mermaid, at its strict security level, one at a time, and answers with a
// picture or with what is wrong. The frame's realm is prepared before Mermaid's code runs
// (render/frame/realm.ts).

import { errorMessage } from '../../../core/errors';
import type { FromFrame, ToFrame } from '../diagramProtocol';
import { pictureOf } from './picture';
import { prepareRealm, takeStyleSheets } from './realm';

prepareRealm();

/** The longest message about a mistake the page is given. */
const MAX_MESSAGE = 300;

function post(message: FromFrame): void {
  parent.postMessage(message, '*');
}

/** A mistake as one short line: Mermaid's first line and its last, where it says what it expected. */
function shortMessage(error: unknown): string {
  const lines = errorMessage(error)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  const message =
    lines.length > 1 ? `${lines[0]} ${lines[lines.length - 1]}` : (lines[0] ?? 'The diagram could not be drawn.');
  return message.length > MAX_MESSAGE ? `${message.slice(0, MAX_MESSAGE - 1)}…` : message;
}

document.addEventListener('securitypolicyviolation', (event) =>
  post({ type: 'violation', directive: event.violatedDirective }),
);

async function start(): Promise<void> {
  const { default: mermaid } = await import('mermaid');
  let theme: 'dark' | 'default' | null = null;
  let drawn = 0;
  let queue = Promise.resolve();

  async function draw(id: number, text: string, dark: boolean): Promise<void> {
    const wanted = dark ? 'dark' : 'default';
    if (wanted !== theme) {
      mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true, theme: wanted });
      theme = wanted;
    }
    takeStyleSheets();
    try {
      const { svg } = await mermaid.render(`tm-diagram-${++drawn}`, text);
      post({ type: 'drawn', id, picture: pictureOf(svg, takeStyleSheets()) });
    } catch (error) {
      takeStyleSheets();
      post({ type: 'failed', id, message: shortMessage(error) });
    }
  }

  window.addEventListener('message', (event: MessageEvent<ToFrame>) => {
    const message = event.data;
    if (event.source !== parent || !message || message.type !== 'draw') return;
    queue = queue.then(() => draw(message.id, String(message.text), message.dark === true));
  });
  post({ type: 'ready' });
}

void start();
