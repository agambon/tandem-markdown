// The buttons of the messages that ask the user something: See Diff and Dismiss on a change to
// look at, a choice of their own first where they have one, and a strip only then; the offer of
// agent instructions reads as the owner wrote it, with his three buttons in his order; the strip's
// count of the messages behind it, in the singular and the plural; and the diff's title bar buttons
// named as package.json shows them.

import { describe, expect, it } from 'vitest';
import manifest from '../../../package.json';
import { messageForm, moreWords, REPLACE_MY_VIEW, USE_CHANGE_FROM_DISK } from '../../../src/host/model/messageForms';

const labels = (form: ReturnType<typeof messageForm>) => form.buttons.map((b) => b.label);

describe('the buttons of a message', () => {
  it('put a choice of its own first, then See Diff and Dismiss, and keep a strip only where there is a choice', () => {
    const forms = {
      withDiff: messageForm({ kind: 'withDiff', text: 'x' }),
      told: messageForm({ kind: 'told', text: 'x' }),
      withUndo: messageForm({ kind: 'withUndo', text: 'x' }),
      reloaded: messageForm({ kind: 'reloaded', text: 'x' }),
      typingAtClose: messageForm({ kind: 'typingAtClose', text: 'x' }),
      saveCheckOff: messageForm({ kind: 'saveCheckOff', text: 'x' }),
    };
    expect(labels(forms.withDiff)).toEqual(['See Diff', 'Dismiss']);
    expect(labels(forms.told)).toEqual(['Dismiss']);
    expect(labels(forms.withUndo)).toEqual(['Undo', 'See Diff', 'Dismiss']);
    expect(labels(forms.reloaded)).toEqual(['Put My Text Back', 'See Diff', 'Dismiss']);
    expect(labels(forms.typingAtClose)).toEqual(['Put My Typing Back', 'See Diff', 'Dismiss']);
    expect(labels(forms.saveCheckOff)).toEqual(['Reload Window', 'Dismiss']);
    const strips = Object.entries(forms)
      .filter(([, f]) => f.strip)
      .map(([k]) => k);
    expect(strips).toEqual(['withUndo', 'reloaded', 'typingAtClose']);
  });
});

describe('the offer of agent instructions', () => {
  it('reads as he wrote it, with his three buttons in his order, and no strip', () => {
    const form = messageForm({ kind: 'instructionsOffer' });
    expect(form.text).toBe('Update AGENTS.md so your agent knows how to work with Tandem Markdown?');
    expect(labels(form)).toEqual(['Update AGENTS.md', 'Copy instructions', "Don't ask again"]);
    expect(form.strip).toBe(false);
  });
});

describe('the count a strip adds', () => {
  it('says how many messages wait after this one, and nothing with none', () => {
    expect(moreWords(0)).toBeNull();
    expect(moreWords(1)).toBe('1 more message after this one');
    expect(moreWords(2)).toBe('2 more messages after this one');
  });
});

describe("the diff's title bar buttons", () => {
  it('are named as package.json shows them', () => {
    const commands: { command: string; shortTitle?: string }[] = manifest.contributes.commands;
    const shortTitle = (id: string) => commands.find((c) => c.command === id)?.shortTitle;
    expect(shortTitle('tandemMarkdown.useClashChangeButton')).toBe(USE_CHANGE_FROM_DISK);
    expect(shortTitle('tandemMarkdown.useGoneChangeButton')).toBe(USE_CHANGE_FROM_DISK);
    expect(shortTitle('tandemMarkdown.replaceMyViewButton')).toBe(REPLACE_MY_VIEW);
  });
});
