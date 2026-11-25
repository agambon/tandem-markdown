// What Add Agent Instructions plans for AGENTS.md and the rule file, and which of the words
// table's sentences it shows: what it adds, where, and what it leaves alone. The sentences
// themselves are conflictFileWords.ts's.

import { describe, expect, it } from 'vitest';
import {
  agentsPlan,
  bytesKind,
  leftAsItIs,
  dialogDetail,
  failureOf,
  RULE_TEXT,
  rulePlan,
  writtenReply,
} from '../../../src/host/model/agentInstructions';
import {
  AGENTS_EDITED,
  AGENTS_HARD_LINK,
  AGENTS_HAS,
  AGENTS_LINK,
  AGENTS_NOT_UTF8,
  AGENTS_PLACE,
  CLAUDE_MD_UNCHANGED,
  INSTRUCTIONS,
  INSTRUCTIONS_WRITTEN,
  NONE_WRITTEN,
  ON_CLIPBOARD_INSTEAD,
  ONE_NOT_WRITTEN,
  RULE_HAS,
  RULE_PLACE,
  RUN_AGAIN,
  WRITE_FAILED,
} from '../../../src/host/model/conflictFile';
import { fill } from '../../../src/host/model/templates';

const OTHER = '# Agents\n\nUse two spaces.\n';

describe('AGENTS.md', () => {
  it('is made with the instructions as its whole text when there is none', () => {
    expect(agentsPlan(null)).toEqual({ place: 'new', text: INSTRUCTIONS });
  });

  it('gains them at its end, after a blank line, and has them on a second run', () => {
    const first = agentsPlan(OTHER);
    expect(first.place).toBe('end');
    expect(first.text).toBe(`${OTHER}\n${INSTRUCTIONS}`);
    expect(agentsPlan(first.text)).toEqual({ place: 'has', text: first.text });
  });

  it('changes nothing where the words under its heading are none it wrote, and says why', () => {
    const before = `# Agents\n\n## Tandem Markdown\n\nOld words.\n\n### More words\n\n## Testing\n\nRun the tests.\n`;
    expect(agentsPlan(before)).toEqual({ place: 'edited', text: before });
    expect(leftAsItIs('edited')).toBe(AGENTS_EDITED);
    expect(leftAsItIs('link')).toBe(AGENTS_LINK);
  });

  it('keeps the file without a final line break as it was', () => {
    expect(agentsPlan('# Agents').text).toBe(`# Agents\n\n${INSTRUCTIONS.trimEnd()}`);
  });

  it('takes no heading in a code block for its own', () => {
    const before = `# Agents\n\n\`\`\`\n## Tandem Markdown\n\`\`\`\n`;
    expect(agentsPlan(before).place).toBe('end');
  });

  it("keeps the file's own line endings", () => {
    const plan = agentsPlan('# Agents\r\n');
    expect(plan.text).toBe(`# Agents\r\n\r\n${INSTRUCTIONS.replace(/\n/g, '\r\n')}`);
    expect(agentsPlan(plan.text).place).toBe('has');
  });
});

describe('the rule file', () => {
  it('starts with the paths Claude Code reads it for, then the instructions', () => {
    expect(RULE_TEXT.startsWith('---\npaths:\n  - "**/*.md"\n')).toBe(true);
    expect(RULE_TEXT.endsWith(INSTRUCTIONS)).toBe(true);
  });

  it('is made, replaced or left as it is', () => {
    expect(rulePlan(null)).toEqual({ place: 'new', text: RULE_TEXT });
    expect(rulePlan('something else\n')).toEqual({ place: 'other', text: RULE_TEXT });
    expect(rulePlan(RULE_TEXT).place).toBe('has');
    expect(rulePlan(RULE_TEXT.replace(/\n/g, '\r\n')).place).toBe('has');
  });
});

describe("the dialog's detail", () => {
  const sentences = (detail: string | null) => detail!.split('\n\n')[0]!;
  const PLACES = [AGENTS_PLACE.end, AGENTS_PLACE.new, RULE_PLACE.new, RULE_PLACE.other];
  /** That the detail's sentences name the places the lines go, those of `places` and no other, then say each of `then`, in order. */
  const expectSays = (detail: string | null, places: readonly string[], then: readonly string[]) => {
    const said = sentences(detail);
    for (const place of PLACES) expect(said.includes(place), place).toBe(places.includes(place));
    let from = Math.max(...places.map((place) => said.indexOf(place) + place.length));
    for (const sentence of then) {
      const at = said.indexOf(sentence, from);
      expect(at, sentence).toBeGreaterThanOrEqual(from);
      from = at + sentence.length;
    }
  };

  it('says where the lines go, that CLAUDE.md is not changed, then gives the lines', () => {
    const detail = dialogDetail('end', 'new');
    expectSays(detail, [AGENTS_PLACE.end, RULE_PLACE.new], [CLAUDE_MD_UNCHANGED]);
    expect(detail!.endsWith(INSTRUCTIONS.trimEnd())).toBe(true);
  });

  it('gives one place where a file already has them', () => {
    expectSays(dialogDetail('end', 'has'), [AGENTS_PLACE.end], [CLAUDE_MD_UNCHANGED, RULE_HAS]);
    expectSays(dialogDetail('has', 'other'), [RULE_PLACE.other], [CLAUDE_MD_UNCHANGED, AGENTS_HAS]);
  });

  it('leaves AGENTS.md changed by hand or a link as it is, and asks nothing when the rule file has them', () => {
    expectSays(dialogDetail('edited', 'new'), [RULE_PLACE.new], [CLAUDE_MD_UNCHANGED, AGENTS_EDITED]);
    expect(sentences(dialogDetail('link', 'other'))).toContain(AGENTS_LINK);
    expect(dialogDetail('link', 'has')).toBeNull();
    expect(dialogDetail('edited', 'has')).toBeNull();
  });

  it('is none when both already have them', () => {
    expect(dialogDetail('has', 'has')).toBeNull();
  });
});

describe('the reply after writing', () => {
  const folder = 'F:\\Notes\\Field Work';
  const rule = 'F:\\Notes\\Field Work\\.claude\\rules\\tandem-markdown.md';
  const agents = `${folder}\\AGENTS.md`;
  const runAgain = (what: string) => fill(RUN_AGAIN, { what });

  it('says where the instructions are', () => {
    expect(writtenReply([], folder, ['AGENTS.md', '.claude/rules/tandem-markdown.md'])).toEqual({
      text: INSTRUCTIONS_WRITTEN,
      onClipboard: false,
    });
  });

  it('gives a plain reason, the full path and what to do, never the raw error', () => {
    expect(
      writtenReply([{ file: '.claude/rules/tandem-markdown.md', path: rule, code: 'EACCES' }], folder, ['AGENTS.md'])
        .text,
    ).toBe(
      fill(ONE_NOT_WRITTEN, {
        written: 'AGENTS.md',
        reason: fill(WRITE_FAILED.denied.file, { path: rule }),
        todo: runAgain(WRITE_FAILED.denied.what),
      }),
    );
    expect(
      writtenReply(
        [
          { file: 'AGENTS.md', path: agents, code: 'EPERM' },
          { file: '.claude/rules/tandem-markdown.md', path: rule, code: 'EPERM' },
        ],
        folder,
        [],
      ).text,
    ).toBe(
      fill(NONE_WRITTEN, {
        reason: fill(WRITE_FAILED.denied.folder, { path: folder }),
        todo: runAgain(WRITE_FAILED.denied.what),
      }),
    );
  });

  it('names the reason the system gives, one wording for each', () => {
    const one = (code: string) =>
      writtenReply([{ file: 'AGENTS.md', path: agents, code }], folder, ['.claude/rules/tandem-markdown.md']);
    const reply = (why: 'busy' | 'full' | 'other', code: string) =>
      fill(ONE_NOT_WRITTEN, {
        written: '.claude/rules/tandem-markdown.md',
        reason: fill(WRITE_FAILED[why].file, { path: agents, code }),
        todo: runAgain(WRITE_FAILED[why].what),
      });
    expect(one('EBUSY').text).toBe(reply('busy', 'EBUSY'));
    expect(one('ENOSPC').text).toBe(reply('full', 'ENOSPC'));
    expect(one('EIO').text).toBe(reply('other', 'EIO'));
    expect(one('EIO').text).toContain('EIO');
    expect(failureOf('NoPermissions')).toBe('denied');
  });

  it('puts the instructions on the clipboard instead on a drive that cannot be written to', () => {
    expect(writtenReply([{ file: 'AGENTS.md', path: agents, code: 'EROFS' }], folder, [])).toEqual({
      text: fill(NONE_WRITTEN, {
        reason: fill(WRITE_FAILED.readOnly.folder, { path: folder }),
        todo: ON_CLIPBOARD_INSTEAD,
      }),
      onClipboard: true,
    });
  });
});

describe("AGENTS.md's bytes", () => {
  it('are UTF-8 text the command may add to, a byte-order mark included', () => {
    expect(bytesKind(Buffer.from('# Agents\n\ncafé\n', 'utf8'))).toBeNull();
    expect(bytesKind(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('# Agents\n', 'utf8')]))).toBeNull();
  });

  it('are left as they are in UTF-16, with or without its mark, and in Windows-1252', () => {
    expect(bytesKind(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('# Agents\n', 'utf16le')]))).toBe('notUtf8');
    expect(bytesKind(Buffer.from('# Agents\n', 'utf16le'))).toBe('notUtf8');
    expect(bytesKind(Buffer.from('café\n', 'latin1'))).toBe('notUtf8');
    expect(leftAsItIs('notUtf8')).toBe(AGENTS_NOT_UTF8);
    expect(leftAsItIs('linked')).toBe(AGENTS_HARD_LINK);
  });
});
