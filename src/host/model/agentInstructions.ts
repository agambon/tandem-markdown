// What "Add Agent Instructions" writes, and the words it shows: the instructions go into AGENTS.md
// at the top of a workspace folder (at its end, or as the whole of a new file) and into
// .claude/rules/tandem-markdown.md for Claude Code. CLAUDE.md and .gitignore are never touched.

import { toLf } from '../../core/eol';
import { listed } from '../../core/listText';
import * as W from './conflictFile';
import { fill } from './templates';

/**
 * What becomes of AGENTS.md: a new file, the lines added at its end, or nothing: it has them; its
 * section "Tandem Markdown" holds words this command did not write (`edited`, by hand), so it
 * cannot know where they end; or, as the host finds it on disk, it is a symbolic link (`link`) or
 * one name of a file with several (`linked`, a hard link), which a write through a temporary name
 * would replace, or it is not UTF-8 text (`notUtf8`: UTF-16, Windows-1252 and the like), whose
 * bytes a write of its text would change.
 */
export type AgentsPlace = 'new' | 'end' | 'has' | 'edited' | 'link' | 'linked' | 'notUtf8';

/** AGENTS.md as it is left: not written, whatever the rule file needs. */
const LEFT_AS_IT_IS: Partial<Record<AgentsPlace, string>> = {
  edited: W.AGENTS_EDITED,
  link: W.AGENTS_LINK,
  linked: W.AGENTS_HARD_LINK,
  notUtf8: W.AGENTS_NOT_UTF8,
};
/** What becomes of the rule file: a new file, its text replaced, or nothing (it has the lines). */
export type RulePlace = 'new' | 'other' | 'has';

export const RULE_TEXT = W.RULE_HEADER + W.INSTRUCTIONS;

/** The instructions' lines, without their line breaks. */
const INSTRUCTION_LINES = W.INSTRUCTIONS.trimEnd().split('\n');

/** A line of a file and the line break that ends it ('' for a last line with none). */
interface Line {
  text: string;
  eol: string;
}

function linesOf(text: string): Line[] {
  const out: Line[] = [];
  const re = /\r\n|\n/g;
  let at = 0;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    out.push({ text: text.slice(at, m.index), eol: m[0] });
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push({ text: text.slice(at), eol: '' });
  return out;
}

function joined(lines: readonly Line[]): string {
  return lines.map((l) => l.text + l.eol).join('');
}

/** The line break most of the file's lines end with (LF where they are as many), for the lines added. */
function eolOf(lines: readonly Line[]): string {
  const crlf = lines.filter((l) => l.eol === '\r\n').length;
  const lf = lines.filter((l) => l.eol === '\n').length;
  return crlf > lf ? '\r\n' : '\n';
}

/** The instructions as lines, each ending in `eol`. */
function ownLines(eol: string): Line[] {
  return INSTRUCTION_LINES.map((text) => ({ text, eol }));
}

/** The lines from `at` on are the instructions, line for line, spaces at their ends aside. */
function holds(lines: readonly Line[], at: number): boolean {
  return (
    at + INSTRUCTION_LINES.length <= lines.length &&
    INSTRUCTION_LINES.every((l, i) => lines[at + i]!.text.trimEnd() === l)
  );
}

/**
 * This command's section "Tandem Markdown": `has` where its heading is followed by the
 * instructions exactly; `edited` where the heading is there but what follows it is not the
 * instructions, so it cannot know where its lines end. The heading in a fenced code block is not
 * one. Null when there is none.
 */
function ownSection(lines: readonly Line[]): 'has' | 'edited' | null {
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.text;
    const opens = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence !== null) {
      if (opens && opens[1]![0] === fence[0] && opens[1]!.length >= fence.length) fence = null;
      continue;
    }
    if (opens) {
      fence = opens[1]!;
      continue;
    }
    if (line.trimEnd() !== W.INSTRUCTIONS_HEADING) continue;
    return holds(lines, i) ? 'has' : 'edited';
  }
  return null;
}

/**
 * What Add Agent Instructions would do to AGENTS.md (`existing` null: there is none), and its
 * text after. Only the lines the command adds change: every other line keeps its own
 * line ending, the lines added take the line ending most of the file's lines have, and the file
 * ends with a line break only where it did.
 */
export function agentsPlan(existing: string | null): { place: AgentsPlace; text: string } {
  if (existing === null) return { place: 'new', text: W.INSTRUCTIONS };
  const lines = linesOf(existing);
  const eol = eolOf(lines);
  const endsWithBreak = existing === '' || /\n$/.test(existing);
  const finish = (out: Line[]): string => {
    const last = out[out.length - 1];
    if (last && !endsWithBreak) out[out.length - 1] = { ...last, eol: '' };
    return joined(out);
  };
  const section = ownSection(lines);
  // Words under its heading this command did not write: it changes nothing, and says so.
  if (section === 'edited') return { place: 'edited', text: existing };
  if (section === null) {
    if (lines.every((l) => l.text.trim() === '')) return { place: 'end', text: finish(ownLines(eol)) };
    const before = lines.map((l, i) => (i === lines.length - 1 && l.eol === '' ? { ...l, eol } : l));
    const blank = before[before.length - 1]!.text.trim() === '' ? [] : [{ text: '', eol }];
    return { place: 'end', text: finish([...before, ...blank, ...ownLines(eol)]) };
  }
  return { place: 'has', text: existing };
}

/** What Add Agent Instructions would do to .claude/rules/tandem-markdown.md (`existing` null: there is none). */
export function rulePlan(existing: string | null): { place: RulePlace; text: string } {
  if (existing === null) return { place: 'new', text: RULE_TEXT };
  return toLf(existing) === RULE_TEXT ? { place: 'has', text: existing } : { place: 'other', text: RULE_TEXT };
}

/**
 * The dialog's detail: where the lines go, that CLAUDE.md is not changed, what already has them,
 * then a blank line and the instructions themselves. Null when both already have them.
 */
export function dialogDetail(agents: AgentsPlace, rule: RulePlace): string | null {
  const stays = agents === 'has' || leftAsItIs(agents) !== null;
  if (rule === 'has' && stays) return null;
  const agentsWhere = agents === 'new' || agents === 'end' ? W.AGENTS_PLACE[agents] : null;
  const ruleWhere = rule === 'has' ? null : W.RULE_PLACE[rule];
  const sentences = [fill(W.LINES_GO, { places: [agentsWhere, ruleWhere].filter((p) => p !== null).join(', and ') })];
  sentences.push(W.CLAUDE_MD_UNCHANGED);
  if (agents === 'has') sentences.push(W.AGENTS_HAS);
  const alone = leftAsItIs(agents);
  if (alone !== null) sentences.push(alone);
  if (rule === 'has') sentences.push(W.RULE_HAS);
  return `${sentences.join(' ')}\n\n${W.INSTRUCTIONS.trimEnd()}`;
}

/** Why AGENTS.md is left as it is (its section changed by hand, a link, not UTF-8); null when it is not. */
export function leftAsItIs(agents: AgentsPlace): string | null {
  return LEFT_AS_IT_IS[agents] ?? null;
}

/** One-sentence reply when AGENTS.md is left as it is and the rule file has or just got the instructions. */
export function leftReply(agents: AgentsPlace, rule: keyof typeof W.RULE_NOW): string | null {
  if (agents !== 'edited' && agents !== 'link' && agents !== 'linked' && agents !== 'notUtf8') return null;
  return fill(W.AGENTS_LEFT, { why: W.AGENTS_LEFT_BECAUSE[agents], rule: W.RULE_NOW[rule] });
}

/**
 * How AGENTS.md's bytes stand for a write of its text: null where they are UTF-8 text, which the
 * command can add to and write back byte for byte; `notUtf8` where they are not (a byte-order
 * mark or a byte UTF-8 does not allow, or a NUL, as UTF-16 has).
 */
export function bytesKind(bytes: Uint8Array): 'notUtf8' | null {
  if (bytes.includes(0)) return 'notUtf8';
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return null;
  } catch {
    return 'notUtf8';
  }
}

/** Why a write failed, by the code the system reported. */
export type WriteFailure = keyof typeof W.WRITE_FAILED;

export function failureOf(code: string | undefined): WriteFailure {
  switch (code) {
    case 'EACCES':
    case 'EPERM':
    case 'NoPermissions':
      return 'denied';
    case 'EBUSY':
      return 'busy';
    case 'EROFS':
      return 'readOnly';
    case 'ENOSPC':
      return 'full';
    default:
      return 'other';
  }
}

/** A write that failed: which file (by its words, AGENTS.md or the rule file), its full path, and the system's code. */
export interface FailedWrite {
  file: string;
  path: string;
  code: string | undefined;
}

/**
 * The reply after the press: both written; one written and the other not, with the reason and
 * what to do; or neither, for the folder. `onClipboard` says the instructions were put on the
 * clipboard instead, as they are for a drive that cannot be written to.
 */
export function writtenReply(
  failed: readonly FailedWrite[],
  folderPath: string,
  written: readonly string[],
): { text: string; onClipboard: boolean } {
  if (failed.length === 0) return { text: W.INSTRUCTIONS_WRITTEN, onClipboard: false };
  const first = failed[0]!;
  const why = failureOf(first.code);
  const words = W.WRITE_FAILED[why];
  const none = written.length === 0;
  const reason = fill(none && why !== 'busy' ? words.folder : words.file, {
    path: none && why !== 'busy' ? folderPath : first.path,
    code: first.code ?? 'unknown',
  });
  const todo = words.what === null ? W.ON_CLIPBOARD_INSTEAD : fill(W.RUN_AGAIN, { what: words.what });
  const text = none
    ? fill(W.NONE_WRITTEN, { reason, todo })
    : fill(W.ONE_NOT_WRITTEN, { written: listed(written), reason, todo });
  return { text, onClipboard: words.what === null };
}
