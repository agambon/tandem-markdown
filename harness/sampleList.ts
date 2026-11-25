// The samples both harness pages offer (index.html and lab.html): their names in the page's
// select, the one to open first, and each one's text.

/**
 * Fills `select` with the samples' names (samples/index.json) and chooses the one to open first:
 * `asked` (the page's `sample` parameter), else everything.md, else the first. Undefined when
 * there are no samples.
 */
export async function listSamples(select: HTMLSelectElement, asked: string | null): Promise<string | undefined> {
  const names: string[] = await (await fetch('samples/index.json')).json();
  for (const name of names) {
    const option = document.createElement('option');
    option.value = name;
    option.textContent = name;
    select.appendChild(option);
  }
  const first = asked ?? (names.includes('everything.md') ? 'everything.md' : names[0]);
  if (first) select.value = first;
  return first;
}

/** The text of the sample `name`, a file in samples/. */
export async function fetchSample(name: string): Promise<string> {
  const response = await fetch(`samples/${encodeURIComponent(name)}`);
  if (!response.ok) throw new Error(`Could not load the sample ${name}`);
  return response.text();
}
