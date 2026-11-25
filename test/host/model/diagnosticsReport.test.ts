// Pure diagnostics formatting and path sanitization for Copy Diagnostics.

import { describe, expect, it } from 'vitest';
import {
  formatDiagnostics,
  nonDefaultSettings,
  sanitizeDiagnosticText,
} from '../../../src/host/model/diagnosticsReport';

describe('sanitizeDiagnosticText', () => {
  it('redacts Windows, POSIX, and URI paths without keeping usernames or note names', () => {
    expect(sanitizeDiagnosticText('Failed to read C:\\Users\\alice\\Documents\\Secret.md (ENOENT)')).toBe(
      'Failed to read <path> (ENOENT)',
    );
    expect(sanitizeDiagnosticText('Opened /Users/alice/vault/diary.md cleanly')).toBe('Opened <path> cleanly');
    expect(sanitizeDiagnosticText('Watch event for /home/dev/notes/plan.md')).toBe('Watch event for <path>');
    expect(sanitizeDiagnosticText('Uri file:///c:/Users/alice/note.md failed')).toBe('Uri <uri> failed');
    expect(sanitizeDiagnosticText('Remote vscode-remote://ssh-remote+box/home/alice/a.md')).toBe('Remote <uri>');
  });

  it('flattens multiline stack traces and caps line length', () => {
    const long = `Error: boom\n    at foo (C:\\Users\\alice\\repo\\a.ts:12)\n${'x'.repeat(300)}`;
    const out = sanitizeDiagnosticText(long);
    expect(out.includes('\n')).toBe(false);
    expect(out.includes('alice')).toBe(false);
    expect(out.length).toBeLessThanOrEqual(200);
    expect(out.endsWith('...')).toBe(true);
  });
});

describe('nonDefaultSettings', () => {
  it('returns only settings whose value differs from the manifest default', () => {
    const properties = {
      'tandemMarkdown.fontSize': { default: 16 },
      'tandemMarkdown.contentWidth': { default: 860 },
      'tandemMarkdown.syntax.math': { default: true },
    };
    const values: Record<string, unknown> = {
      'tandemMarkdown.fontSize': 18,
      'tandemMarkdown.contentWidth': 860,
      'tandemMarkdown.syntax.math': false,
    };
    expect(nonDefaultSettings(properties, (k) => values[k])).toEqual([
      { key: 'tandemMarkdown.fontSize', value: 18, defaultValue: 16 },
      { key: 'tandemMarkdown.syntax.math', value: false, defaultValue: true },
    ]);
  });
});

describe('formatDiagnostics', () => {
  it('formats versions, counts, overrides, and sanitized log entries', () => {
    const md = formatDiagnostics({
      extensionVersion: '0.1.0',
      vscodeVersion: '1.146.0',
      uiKind: 'Desktop',
      remoteName: 'wsl',
      platform: 'linux',
      arch: 'x64',
      osRelease: '6.6.0',
      tabs: { richEdit: 2, richView: 1, source: 3 },
      overrides: [{ key: 'tandemMarkdown.fontSize', value: 18, defaultValue: 16 }],
      logs: [
        {
          level: 'warn',
          message: 'Read failed for C:\\Users\\alice\\private.md',
          detail: 'EBUSY',
          at: Date.UTC(2026, 10, 24, 15, 4, 5),
        },
      ],
    });
    expect(md).toContain('- Extension: 0.1.0');
    expect(md).toContain('- VS Code: 1.146.0 (Desktop, remote: wsl)');
    expect(md).toContain('- Open markdown tabs: 2 rich editor, 1 rich view, 3 source');
    expect(md).toContain('`tandemMarkdown.fontSize`: `18` (default `16`)');
    expect(md).toContain('[15:04:05Z] WARN Read failed for <path> EBUSY');
    expect(md).not.toContain('alice');
    expect(md).not.toContain('private.md');
  });
});
