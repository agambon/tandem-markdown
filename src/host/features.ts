// The host's features. Each is called once from activate, after the documents, the panel
// registry and the message router exist, and returns what to dispose.

import type * as vscode from 'vscode';
import { agentInstructions } from './agentInstructions';
import { announce } from './announce';
import { changeMarks } from './changeMarks';
import { completions } from './completions';
import { copyLines } from './copyLines';
import { defaults } from './defaults';
import { diagnostics } from './diagnostics';
import type { Documents } from './documents';
import { gitConflicts } from './gitConflicts';
import { images } from './images';
import { links } from './links';
import { openToSide } from './openToSide';
import { outlineView } from './outlineView';
import { previewButtons } from './previewButtons';
import { rename } from './rename';
import { scrollSyncFeature } from './scrollSync';
import { statusBar } from './statusBar';
import { tabFocus } from './tabFocus';
import { tags } from './tags';
import { verify } from './verify';
import { viewPlaces } from './viewPlaces';

/**
 * A feature gets the extension's context, the documents (each one's coordinator) and whether the
 * extension runs under the in-VS-Code suite, and returns what to dispose.
 */
export type HostFeature = (
  context: vscode.ExtensionContext,
  documents: Documents,
  testMode: boolean,
) => vscode.Disposable;

export const features: HostFeature[] = [
  statusBar,
  outlineView,
  links,
  images,
  tags,
  verify,
  defaults,
  tabFocus,
  diagnostics,
  rename,
  completions,
  changeMarks,
  gitConflicts,
  announce,
  scrollSyncFeature,
  openToSide,
  agentInstructions,
  viewPlaces,
  copyLines,
  previewButtons,
];
