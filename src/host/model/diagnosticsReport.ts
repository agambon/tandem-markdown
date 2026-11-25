// Pure formatter and path sanitizer for "Tandem Markdown: Copy Diagnostics".
// Never includes note contents or user file paths.

export interface SettingOverride {
  key: string;
  value: unknown;
  defaultValue: unknown;
}

export interface DiagnosticLogEntry {
  level: string;
  message: string;
  detail?: string | undefined;
  at: number;
}

export interface DiagnosticsSnapshot {
  extensionVersion: string;
  vscodeVersion: string;
  uiKind: 'Desktop' | 'Web';
  remoteName: string | undefined;
  platform: string;
  arch: string;
  osRelease: string;
  tabs: {
    richEdit: number;
    richView: number;
    source: number;
  };
  overrides: readonly SettingOverride[];
  logs: readonly DiagnosticLogEntry[];
}

const MAX_LOG_LINES = 40;
const MAX_LINE_CHARS = 200;

const URI_RE =
  /\b(?:file|vscode-remote|untitled|vscode-userdata):\/\/[^\s"'`<>|)\]},;]+|\buntitled:[^\s"'`<>|)\]},;]+/gi;
const WIN_PATH_RE = /(?:[A-Za-z]:\\|\\\\)[^\s"'`<>|)\]},;]+/g;
const WIN_FWD_PATH_RE = /\b[A-Za-z]:\/[^\s"'`<>|)\]},;]+/g;
const POSIX_PATH_RE = /(?<![A-Za-z0-9._-])\/(?:Users|home|var|tmp|mnt|opt|Volumes|private)\/[^\s"'`<>|)\]},;]+/g;

/** Removes file URIs and local paths, flattens whitespace, and caps length for safe issue reporting. */
export function sanitizeDiagnosticText(text: string): string {
  const cleaned = text
    .replace(URI_RE, '<uri>')
    .replace(WIN_PATH_RE, '<path>')
    .replace(WIN_FWD_PATH_RE, '<path>')
    .replace(POSIX_PATH_RE, '<path>')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > MAX_LINE_CHARS ? `${cleaned.slice(0, MAX_LINE_CHARS - 3)}...` : cleaned;
}

/** Collects settings whose active value differs from the manifest default. */
export function nonDefaultSettings(
  properties: Record<string, { default?: unknown }>,
  read: (key: string) => unknown,
): SettingOverride[] {
  const out: SettingOverride[] = [];
  for (const [key, schema] of Object.entries(properties).sort(([a], [b]) => a.localeCompare(b))) {
    const value = read(key);
    const defaultValue = schema?.default;
    if (value === undefined) continue;
    if (JSON.stringify(value) !== JSON.stringify(defaultValue)) {
      out.push({ key, value, defaultValue });
    }
  }
  return out;
}

function formatTime(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}Z`;
}

/** Formats a diagnostics snapshot as Markdown ready to paste into a bug report. */
export function formatDiagnostics(info: DiagnosticsSnapshot): string {
  const envNote = info.remoteName ? `${info.uiKind}, remote: ${info.remoteName}` : info.uiKind;
  const lines: string[] = [
    '## Tandem Markdown Diagnostics',
    '',
    `- Extension: ${info.extensionVersion}`,
    `- VS Code: ${info.vscodeVersion} (${envNote})`,
    `- Platform: ${info.platform} ${info.arch} (${info.osRelease})`,
    `- Open markdown tabs: ${info.tabs.richEdit} rich editor, ${info.tabs.richView} rich view, ${info.tabs.source} source`,
    '',
    '### Settings overrides',
    '',
  ];

  if (info.overrides.length === 0) {
    lines.push('All settings are at their defaults.');
  } else {
    for (const item of info.overrides) {
      lines.push(
        `- \`${item.key}\`: \`${JSON.stringify(item.value)}\` (default \`${JSON.stringify(item.defaultValue)}\`)`,
      );
    }
  }

  const tail = info.logs.slice(-MAX_LOG_LINES);
  lines.push('', `### Recent log (${tail.length} ${tail.length === 1 ? 'entry' : 'entries'}, paths redacted)`, '');
  if (tail.length === 0) {
    lines.push('No log entries.');
  } else {
    lines.push('```text');
    for (const entry of tail) {
      const combined = entry.detail === undefined ? entry.message : `${entry.message} ${entry.detail}`;
      lines.push(`[${formatTime(entry.at)}] ${entry.level.toUpperCase()} ${sanitizeDiagnosticText(combined)}`);
    }
    lines.push('```');
  }

  return `${lines.join('\n')}\n`;
}
