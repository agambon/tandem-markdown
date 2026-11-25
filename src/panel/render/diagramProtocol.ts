// The messages between the panel's page and the diagram frame (render/diagramFrame.ts and
// render/frame/main.ts). The page checks every message from the frame before it uses it.

/** A diagram drawn as a picture: an SVG document, its size in pixels, and its accessible title. */
export interface DiagramPicture {
  svg: string;
  width: number;
  height: number;
  /** Mermaid's `accTitle` and `accDescr`, or ''. */
  label: string;
}

/** Page to frame. The frame's bootstrap takes `code` once; the code it runs takes `draw`. */
export type ToFrame = { type: 'code'; code: string } | { type: 'draw'; id: number; text: string; dark: boolean };

/** Frame to page. */
export type FromFrame =
  | { type: 'up' }
  | { type: 'ready' }
  | { type: 'drawn'; id: number; picture: DiagramPicture }
  | { type: 'failed'; id: number; message: string }
  | { type: 'violation'; directive: string };
