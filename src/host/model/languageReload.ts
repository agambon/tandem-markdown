// The message when a change of language mode reloads a note's rich tabs while their typing had not
// reached the note. Nothing hands a tab's unsent typing to the host before it reloads, and a tab
// that did not answer in time counts as unsent too, so the message says the typing may have been
// lost, and offers no Copy text.

/** The message, for the note `name` and the number of its rich tabs that reloaded. */
export function languageReloadMessage(name: string, tabs: number): string {
  const which = tabs > 1 ? 'tabs' : 'tab';
  return `${name}'s language mode was changed, so its rich ${which} reloaded and may have lost what you had just typed.`;
}
