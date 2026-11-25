// Heading section ranges and section reordering for markdown documents.
// Shared between panel heading folding and host outline drag-to-reorder.

import { findFrontmatterEnd } from './frontmatter';
import type { OutlineItem } from './outline';

export interface LineInfo {
  readonly from: number;
  readonly to: number;
  readonly text: string;
}

/** Minimal 1-based line reader compatible with CodeMirror's `Text` and plain LF strings. */
export interface LineSource {
  readonly lines: number;
  readonly length: number;
  line(n: number): LineInfo;
}

export interface HeadingSection {
  readonly level: number;
  /** 1-based line number where the heading starts. */
  readonly headLine: number;
  /** 1-based line number where the heading ends (same as headLine for ATX, underline line for Setext). */
  readonly headEndLine: number;
  /** Offset where the heading starts. */
  readonly headStart: number;
  /** Offset where the heading's last line ends. */
  readonly headEnd: number;
  /** Offset where the first line after the heading starts (or `sectionEnd` when at EOF). */
  readonly bodyFrom: number;
  /** Offset where the last line of the section ends (before the next heading of `<= level`, or EOF). */
  readonly sectionEnd: number;
  /** 1-based line number of the last line of the section. */
  readonly sectionEndLine: number;
  /** True when at least one non-blank line exists in the section body. */
  readonly hasBody: boolean;
}

const ATX_RE = /^ {0,3}(#{1,6})(?:[ \t]|$)/;
const SETEXT_RE = /^ {0,3}(=+|-+)[ \t]*$/;
const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})/;

/** Builds a `LineSource` over an LF string. */
export function lineSourceOf(lf: string): LineSource {
  const starts = [0];
  for (let i = lf.indexOf('\n'); i >= 0; i = lf.indexOf('\n', i + 1)) starts.push(i + 1);
  return {
    lines: starts.length,
    length: lf.length,
    line(n: number): LineInfo {
      const from = starts[n - 1]!;
      const next = starts[n];
      const to = next === undefined ? lf.length : next - 1;
      return { from, to, text: lf.slice(from, to) };
    },
  };
}

function headingAt(
  doc: LineSource,
  n: number,
  inFence: { char: string; len: number } | null,
): { level: number; endLine: number } | null {
  if (inFence) return null;
  const text = doc.line(n).text;
  const atx = ATX_RE.exec(text);
  if (atx) return { level: atx[1]!.length, endLine: n };
  if (n < doc.lines && text.trim() !== '' && !/^ {0,3}(?:>|-|\*|\+|\d+[.)])/.test(text) && !FENCE_OPEN_RE.test(text)) {
    const nextText = doc.line(n + 1).text;
    const setext = SETEXT_RE.exec(nextText);
    if (setext) return { level: setext[1]![0] === '=' ? 1 : 2, endLine: n + 1 };
  }
  return null;
}

function stepFence(text: string, fence: { char: string; len: number } | null): { char: string; len: number } | null {
  if (fence) {
    const closeRe = fence.char === '`' ? /^ {0,3}(`{3,})[ \t]*$/ : /^ {0,3}(~{3,})[ \t]*$/;
    const m = closeRe.exec(text);
    return m && m[1]!.length >= fence.len ? null : fence;
  }
  const m = FENCE_OPEN_RE.exec(text);
  if (!m) return null;
  const run = m[1]!;
  // CommonMark: backtick info strings cannot contain backticks.
  if (run[0] === '`' && text.slice(m[0].length).includes('`')) return null;
  return { char: run[0]!, len: run.length };
}

/**
 * Computes the section starting at 1-based `headLine` in `doc`, or null if that line does not
 * start a top-level heading. Scans forward fence-aware until the next heading of `<= level` or EOF.
 */
export function headingSectionAtLine(doc: LineSource, headLine: number): HeadingSection | null {
  if (headLine < 1 || headLine > doc.lines) return null;
  const head = headingAt(doc, headLine, null);
  if (!head) return null;

  const first = doc.line(headLine);
  const headEndInfo = doc.line(head.endLine);
  const bodyStartLine = head.endLine + 1;
  let sectionEndLine = head.endLine;
  let hasBody = false;
  let fence: { char: string; len: number } | null = null;

  for (let n = bodyStartLine; n <= doc.lines; n++) {
    const text = doc.line(n).text;
    if (!fence) {
      const nextHead = headingAt(doc, n, null);
      if (nextHead && nextHead.level <= head.level) break;
    }
    fence = stepFence(text, fence);
    sectionEndLine = n;
    if (text.trim() !== '') hasBody = true;
  }

  const bodyFrom = bodyStartLine <= doc.lines ? doc.line(bodyStartLine).from : doc.length;
  const sectionEnd = doc.line(sectionEndLine).to;
  return {
    level: head.level,
    headLine,
    headEndLine: head.endLine,
    headStart: first.from,
    headEnd: headEndInfo.to,
    bodyFrom,
    sectionEnd,
    sectionEndLine,
    hasBody,
  };
}

/** Finds every foldable top-level heading section in `doc` (skipping front matter and code fences). */
export function allFoldableHeadings(doc: LineSource): HeadingSection[] {
  let startLine = 1;
  // Inspect up to the first 100 lines to skip YAML/TOML/JSON front matter if present.
  const headSampleLines: string[] = [];
  const sampleMax = Math.min(doc.lines, 100);
  for (let n = 1; n <= sampleMax; n++) headSampleLines.push(doc.line(n).text);
  const fmEnd = findFrontmatterEnd(headSampleLines.join('\n'));
  if (fmEnd > 0) {
    for (let n = 1; n <= doc.lines; n++) {
      if (doc.line(n).from >= fmEnd) {
        startLine = n;
        break;
      }
    }
  }

  const found: { level: number; headLine: number; headEndLine: number }[] = [];
  let fence: { char: string; len: number } | null = null;
  for (let n = startLine; n <= doc.lines; n++) {
    const text = doc.line(n).text;
    const head = headingAt(doc, n, fence);
    if (head) {
      found.push({ level: head.level, headLine: n, headEndLine: head.endLine });
      n = head.endLine;
      continue;
    }
    fence = stepFence(text, fence);
  }

  const out: HeadingSection[] = [];
  for (let i = 0; i < found.length; i++) {
    const h = found[i]!;
    let nextSiblingLine = doc.lines + 1;
    for (let j = i + 1; j < found.length; j++) {
      if (found[j]!.level <= h.level) {
        nextSiblingLine = found[j]!.headLine;
        break;
      }
    }
    const sectionEndLine = Math.max(h.headEndLine, nextSiblingLine - 1);
    let hasBody = false;
    for (let n = h.headEndLine + 1; n <= sectionEndLine; n++) {
      if (doc.line(n).text.trim() !== '') {
        hasBody = true;
        break;
      }
    }
    if (!hasBody) continue;
    const bodyStartLine = h.headEndLine + 1;
    out.push({
      level: h.level,
      headLine: h.headLine,
      headEndLine: h.headEndLine,
      headStart: doc.line(h.headLine).from,
      headEnd: doc.line(h.headEndLine).to,
      bodyFrom: bodyStartLine <= doc.lines ? doc.line(bodyStartLine).from : doc.length,
      sectionEnd: doc.line(sectionEndLine).to,
      sectionEndLine,
      hasBody,
    });
  }
  return out;
}

/**
 * Returns the byte range [from, to] (including trailing newline when present) of heading `index`'s
 * full subtree in `lf` given `headings` from `buildOutline`.
 */
export function outlineSectionSpan(
  lf: string,
  headings: readonly OutlineItem[],
  index: number,
): { from: number; to: number; endIndex: number } | null {
  const item = headings[index];
  if (!item) return null;
  let nextIndex = index + 1;
  while (nextIndex < headings.length && headings[nextIndex]!.level > item.level) nextIndex++;
  const from = item.from;
  const to = nextIndex < headings.length ? headings[nextIndex]!.from : lf.length;
  return { from, to, endIndex: nextIndex - 1 };
}

/**
 * Moves heading `fromIndex` (and its entire subtree) before or after `targetIndex`'s section in `lf`.
 * Returns the new LF text, or null when the move is invalid (moving into own subtree) or a no-op.
 */
export function moveOutlineSection(
  lf: string,
  headings: readonly OutlineItem[],
  fromIndex: number,
  targetIndex: number,
  place: 'before' | 'after',
): string | null {
  const src = outlineSectionSpan(lf, headings, fromIndex);
  const dst = outlineSectionSpan(lf, headings, targetIndex);
  if (!src || !dst) return null;
  // Cannot drop a section onto itself or inside its own descendants.
  if (targetIndex >= fromIndex && targetIndex <= src.endIndex) return null;

  const insertAt = place === 'before' ? dst.from : dst.to;
  if (insertAt === src.from || insertAt === src.to) return null;

  const hadTrailingNewline = lf.endsWith('\n');
  const norm = hadTrailingNewline ? lf : `${lf}\n`;
  const srcEnd = src.to === lf.length ? norm.length : src.to;
  const dstPos = insertAt === lf.length ? norm.length : insertAt;

  // Separate trailing blank lines from the moved block so moving to/from EOF preserves spacing.
  const rawBlock = norm.slice(src.from, srcEnd);
  const movedFromEnd = srcEnd === norm.length;
  const movingToEnd = dstPos === norm.length;
  const trimmedBlock = rawBlock.replace(/\n+$/, '\n');
  const blockWithGap = movingToEnd ? trimmedBlock : rawBlock.endsWith('\n\n') ? rawBlock : `${trimmedBlock}\n`;

  let rebuilt: string;
  if (dstPos < src.from) {
    const before = norm.slice(0, dstPos);
    const middle = norm.slice(dstPos, src.from);
    const after = norm.slice(srcEnd);
    // If we pulled the last section away, drop one blank separator left trailing at EOF.
    const cleanMiddle = movedFromEnd && after === '' ? middle.replace(/\n\n$/, '\n') : middle;
    rebuilt = before + blockWithGap + cleanMiddle + after;
  } else {
    const before = norm.slice(0, src.from);
    const middle = norm.slice(srcEnd, dstPos);
    const after = norm.slice(dstPos);
    const prefix = before + middle;
    const sep = movingToEnd && prefix.length > 0 && !prefix.endsWith('\n\n') ? '\n' : '';
    rebuilt = prefix + sep + blockWithGap + after;
  }
  const result = hadTrailingNewline ? rebuilt : rebuilt.replace(/\n$/, '');
  return result === lf ? null : result;
}
