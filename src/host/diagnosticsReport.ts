// "Tandem Markdown: Copy Diagnostics": collects sanitized environment, settings overrides,
// and recent log entries (never note text or file paths) and copies them to the clipboard.

import * as os from 'node:os';
import * as vscode from 'vscode';
import { isMarkdownPath } from '../core/fileKinds';
import { recentLogLines } from './log';
import { formatDiagnostics, nonDefaultSettings } from './model/diagnosticsReport';
import { panels } from './panels';

interface ManifestShape {
  version?: unknown;
  contributes?: {
    configuration?: {
      properties?: Record<string, { default?: unknown }>;
    };
  };
}

/** Copies sanitized diagnostics Markdown to the clipboard and notifies the user. */
export async function copyDiagnostics(context: vscode.ExtensionContext): Promise<void> {
  const manifest = (context.extension.packageJSON ?? {}) as ManifestShape;
  const extensionVersion = typeof manifest.version === 'string' ? manifest.version : 'unknown';
  const properties = manifest.contributes?.configuration?.properties ?? {};
  const config = vscode.workspace.getConfiguration();
  const overrides = nonDefaultSettings(properties, (key) => config.get(key));

  const openPanels = panels.all();
  let richEdit = 0;
  let richView = 0;
  for (const panel of openPanels) {
    if (panel.mode === 'edit') richEdit++;
    else richView++;
  }

  let source = 0;
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (tab.input instanceof vscode.TabInputText && isMarkdownPath(tab.input.uri.path)) {
        source++;
      }
    }
  }

  const report = formatDiagnostics({
    extensionVersion,
    vscodeVersion: vscode.version,
    uiKind: vscode.env.uiKind === vscode.UIKind.Web ? 'Web' : 'Desktop',
    remoteName: vscode.env.remoteName,
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    tabs: { richEdit, richView, source },
    overrides,
    logs: recentLogLines(),
  });

  await vscode.env.clipboard.writeText(report);
  void vscode.window.showInformationMessage('Diagnostics copied to the clipboard. No note text was included.');
}
