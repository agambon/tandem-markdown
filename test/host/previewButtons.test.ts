import { describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import type { Documents } from '../../src/host/documents';
import { previewButtons } from '../../src/host/previewButtons';

const world = vi.hoisted(() => ({
  hide: true as boolean | undefined,
  listeners: [] as ((e: { affectsConfiguration: (s: string) => boolean }) => void)[],
  contextCalls: [] as [string, unknown][],
}));

vi.mock('vscode', async () => {
  const { Disposable } = await import('./vscodeStandIn');
  return {
    Disposable,
    workspace: {
      getConfiguration: () => ({
        get: (_key: string, fallback: unknown) => (world.hide === undefined ? fallback : world.hide),
      }),
      onDidChangeConfiguration: (listener: (e: { affectsConfiguration: (s: string) => boolean }) => void) => {
        world.listeners.push(listener);
        return {
          dispose: () => {
            const idx = world.listeners.indexOf(listener);
            if (idx >= 0) world.listeners.splice(idx, 1);
          },
        };
      },
    },
  };
});

vi.mock('../../src/host/contextKeys', () => ({
  setContextKey: (name: string, value: unknown) => {
    world.contextCalls.push([name, value]);
  },
}));

describe('previewButtons', () => {
  it('syncs hasCustomMarkdownPreview with tandemMarkdown.hideBuiltInPreviewButtons and resets on dispose', () => {
    world.hide = true;
    world.contextCalls.length = 0;

    const disposable = previewButtons({} as vscode.ExtensionContext, {} as Documents, false);
    expect(world.contextCalls).toEqual([['hasCustomMarkdownPreview', true]]);

    // Unrelated configuration changes are ignored.
    for (const l of world.listeners) l({ affectsConfiguration: (s) => s === 'tandemMarkdown.fontSize' });
    expect(world.contextCalls).toHaveLength(1);

    // Turning the setting off clears the context key live.
    world.hide = false;
    for (const l of world.listeners)
      l({ affectsConfiguration: (s) => s === 'tandemMarkdown.hideBuiltInPreviewButtons' });
    expect(world.contextCalls).toEqual([
      ['hasCustomMarkdownPreview', true],
      ['hasCustomMarkdownPreview', false],
    ]);

    // Turning it back on re-enables hiding.
    world.hide = true;
    for (const l of world.listeners)
      l({ affectsConfiguration: (s) => s === 'tandemMarkdown.hideBuiltInPreviewButtons' });
    expect(world.contextCalls.at(-1)).toEqual(['hasCustomMarkdownPreview', true]);

    // Disposing restores VS Code's built-in preview buttons.
    disposable.dispose();
    expect(world.contextCalls.at(-1)).toEqual(['hasCustomMarkdownPreview', false]);
    expect(world.listeners).toHaveLength(0);
  });
});
