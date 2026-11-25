// Mermaid diagrams: a ```` ```mermaid ```` code block (```` ```{mermaid} ```` as Quarto writes
// it, while code fence labels are on) is a drawn block (render/drawnBlock.ts) showing the
// diagram, drawn by Mermaid in a frame of its own (render/diagramFrame.ts) and shown here as a
// picture: an SVG document in an `<img>`, which runs no script and loads nothing, so the page
// never holds Mermaid's markup. The theme follows the editor's: a dark page gets Mermaid's dark
// theme, a light one its default. A drawn diagram has a button that opens it large
// (ui/diagramView.ts).

import { EditorView } from '@codemirror/view';
import { errorMessage } from '../../core/errors';
import type { Feature } from '../features';
import { largeDiagramView, openDiagramView } from '../ui/diagramView';
import { iconButton } from '../ui/dom';
import { codeText, fenceLanguage } from './code';
import { diagramCode, drawDiagram, onFrameViolation } from './diagramFrame';
import type { DiagramPicture } from './diagramProtocol';
import { drawBlock, drawnBlockKeys, drawnBlockTheme, type DrawnKind } from './drawnBlock';
import { blockFeature } from './framework';

function pictureElement(picture: DiagramPicture): HTMLImageElement {
  const img = document.createElement('img');
  img.className = 'tm-diagram';
  img.alt = picture.label || 'Diagram';
  img.width = picture.width;
  img.height = picture.height;
  img.draggable = false;
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(picture.svg)}`;
  return img;
}

/** The button at a drawn diagram's corner that opens `img`, its picture, over the whole panel. */
function openLargeButton(view: EditorView, img: HTMLImageElement, picture: DiagramPicture): HTMLElement {
  const button = iconButton(view.dom.ownerDocument, {
    icon: 'screen-full',
    label: 'Open the diagram large',
    className: 'tm-drawn-control tm-stop',
    keepFocus: true,
  });
  button.addEventListener('click', (event) => {
    event.preventDefault();
    openDiagramView(view, { src: img.src, width: picture.width, height: picture.height, label: img.alt });
  });
  return button;
}

/** A diagram longer than this shows as code with a "Draw anyway" button. */
const DIAGRAM_LIMIT = 20_000;
/** The height kept for a diagram never measured. */
const DIAGRAM_ESTIMATE = 240;

function diagramKind(dark: boolean): DrawnKind {
  return {
    name: 'Diagram',
    sentenceName: 'a diagram',
    frameClass: 'tm-drawn-diagram',
    editLabel: 'Edit the diagram',
    doneLabel: 'Done editing the diagram',
    limit: DIAGRAM_LIMIT,
    estimate: DIAGRAM_ESTIMATE,
    library: diagramCode,
    draw: (text, view) =>
      drawDiagram(text, dark).then(
        (picture) => {
          const img = pictureElement(picture);
          return { node: img, controls: [openLargeButton(view, img, picture)] };
        },
        (error: unknown) => ({ error: errorMessage(error) }),
      ),
  };
}

const LIGHT = diagramKind(false);
const DARK = diagramKind(true);

export const diagrams: Feature = {
  id: 'diagrams',
  extension: (ctx) => {
    onFrameViolation((directive) => ctx.log('warn', `The diagram frame reported a policy violation: ${directive}`));
    return [
      blockFeature('diagrams', (d) => {
        const kind = d.state.facet(EditorView.darkTheme) ? DARK : LIGHT;
        d.blocks((block) => {
          if (block.name === 'FencedCode' && fenceLanguage(d, block.node) === 'mermaid') {
            drawBlock(d, block, kind, codeText(d.doc, block.node), true);
          }
        });
      }),
      drawnBlockKeys,
      drawnBlockTheme,
      largeDiagramView,
      EditorView.baseTheme({
        '& .cm-content .tm-diagram': { display: 'block', maxWidth: '100%', height: 'auto', margin: '0 auto' },
      }),
    ];
  },
};
