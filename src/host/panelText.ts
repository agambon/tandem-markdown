// Places in a document, as a panel and the host name them to each other. A panel's request
// names a place by an LF offset in the panel's own text, with that text's stamp: the host has
// the panel send what is unsent, then goes ahead only if the document holds that text. What
// the host sends back of its own accord is in the coordinator's text at its log version, which
// every panel carries over the changes it has seen since (src/panel/hostRanges.ts).
// docs/ARCHITECTURE.md, "VS Code's features in the rich views".

import type { Text } from '@codemirror/state';
import * as vscode from 'vscode';
import { toLf } from '../core/eol';
import { isStamp, sameStamp, stampOf } from '../core/hash';
import { positionOf, textOf } from '../core/positions';
import type { Documents } from './documents';
import { documentText } from './model/documentText';
import type { HostPanel } from './panels';

/** The document a request named a place in, with the version and LF text it was checked at. */
interface RequestText {
  document: vscode.TextDocument;
  /** `document.version` when the text was checked: an edit made from the answer checks it again. */
  version: number;
  doc: Text;
}

const documentLines = new WeakMap<vscode.TextDocument, { version: number; doc: Text }>();

/** The document's LF text as a CodeMirror Text (for its line table), built at most once per version. */
export function lfTextOf(document: vscode.TextDocument): Text {
  const seen = documentLines.get(document);
  if (seen && seen.version === document.version) return seen.doc;
  const doc = textOf(toLf(documentText(document)));
  documentLines.set(document, { version: document.version, doc });
  return doc;
}

/**
 * The panel's document, once it holds exactly the text whose stamp the panel sent; null when it
 * does not (another change came in), or the panel or its document has gone.
 */
export async function textForRequest(
  documents: Documents,
  panel: HostPanel,
  expect: unknown,
): Promise<RequestText | null> {
  if (!isStamp(expect)) throw new Error('The request does not name the text it is about');
  const tracked = documents.get(panel.uri);
  if (!tracked || panel.disposed) return null;
  await tracked.coordinator.flushPanels([panel.id]);
  const document = panel.document;
  if (panel.disposed || document.isClosed) return null;
  const doc = lfTextOf(document);
  return sameStamp(stampOf(doc), expect) ? { document, version: document.version, doc } : null;
}

/** An offset a panel sent, checked against the text it was checked against. Throws when it is not one. */
export function offsetIn(doc: Text, value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > doc.length)
    throw new Error('The request names a place outside the text');
  return value;
}

export function toPosition(doc: Text, offset: number): vscode.Position {
  const p = positionOf(doc, offset);
  return new vscode.Position(p.line, p.character);
}

/** The LF offset of a VS Code position, held inside the text (a position past a line's end is its end). */
export function toOffset(doc: Text, position: { line: number; character: number }): number {
  if (position.line < 0) return 0;
  if (position.line >= doc.lines) return doc.length;
  const line = doc.line(position.line + 1);
  return line.from + Math.max(0, Math.min(position.character, line.length));
}

const sessionLines = new WeakMap<object, { text: string; version: number; doc: Text }>();

/**
 * The text every panel of the document is synced to, with its log version: what the host's
 * own ranges are given in. Undefined for a document with no coordinator.
 */
export function syncedText(documents: Documents, uri: vscode.Uri): { version: number; doc: Text } | undefined {
  const tracked = documents.get(uri);
  if (!tracked) return undefined;
  // The document can be a step ahead of the coordinator while an edit is being applied; the
  // panels follow the coordinator's text, so ranges are given in it.
  const { version, text } = tracked.coordinator.synced();
  const seen = sessionLines.get(tracked.coordinator);
  if (seen && seen.version === version && seen.text === text) return seen;
  const entry = { text, version, doc: textOf(text) };
  sessionLines.set(tracked.coordinator, entry);
  return entry;
}
