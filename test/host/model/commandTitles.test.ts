// The command titles read from the manifest, for the words that name a command.

import { describe, expect, it } from 'vitest';
import manifest from '../../../package.json';
import { commandFailedText, commandTitles } from '../../../src/host/model/commandTitles';

describe('commandTitles', () => {
  it('reads each command title by its id after the prefix', () => {
    const titles = commandTitles(
      {
        contributes: {
          commands: [
            { command: 'tandemMarkdown.switchView', title: 'Switch View' },
            { command: 'other.thing', title: 'Not ours' },
            { command: 'tandemMarkdown.noTitle' },
            null,
          ],
        },
      },
      'tandemMarkdown.',
    );
    expect([...titles]).toEqual([['switchView', 'Switch View']]);
  });

  it('gives nothing for a manifest without commands', () => {
    expect(commandTitles(undefined, 'tandemMarkdown.').size).toBe(0);
    expect(commandTitles({ contributes: {} }, 'tandemMarkdown.').size).toBe(0);
  });

  it('has a title for every command the extension contributes', () => {
    const titles = commandTitles(manifest, 'tandemMarkdown.');
    expect(titles.size).toBe(manifest.contributes.commands.length);
    expect(titles.get('switchView')).toBe('Switch View');
  });
});

describe('commandFailedText', () => {
  it('names the command and what went wrong', () => {
    expect(commandFailedText('Switch View', 'The tab is gone')).toBe("Switch View didn't work: The tab is gone");
  });
});
