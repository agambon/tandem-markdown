// A made-up note of a given size, the same for the same seed: front matter, headings, prose with
// inline formatting, links, wikilinks, tags, emoji codes and math, lists, tasks, tables, code,
// quotes, callouts, footnotes and the occasional Mermaid diagram, mixed in fixed proportions.
// The measuring scripts in this folder type into it and merge into it.

class Rng {
  constructor(seed) {
    this.s = seed >>> 0 || 1;
  }
  next() {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(n) {
    return Math.floor(this.next() * n);
  }
  pick(list) {
    return list[this.int(list.length)];
  }
}

const WORDS = (
  'the of and to in a is that for it as with was on be by this are from or have an they which you one were all ' +
  'we when there can more if their has would about what so out up into some time could them only other than then ' +
  'now its like over also after did two how our work first well way even new want because any these give day most ' +
  'us plan trip house garden budget recipe notes meeting project draft review chapter scene character weekend ' +
  'school doctor insurance kitchen camera network storage server backup'
).split(' ');

function word(r) {
  const w = r.pick(WORDS);
  const k = r.next();
  if (k < 0.03) return `**${w}**`;
  if (k < 0.05) return `*${w}*`;
  if (k < 0.06) return `\`${w}\``;
  if (k < 0.075) return `[[${r.pick(WORDS)} ${r.pick(WORDS)}]]`;
  if (k < 0.085) return `[${w}](https://example.com/${r.pick(WORDS)})`;
  if (k < 0.09) return `#${r.pick(WORDS)}`;
  if (k < 0.093) return `==${w}==`;
  if (k < 0.095) return `:${r.pick(['smile', 'tada', 'rocket', 'warning', 'bulb'])}:`;
  if (k < 0.098) return `$${r.pick(['x^2', 'a_i + b_i', '\\frac{1}{n}', '\\sqrt{2}'])}$`;
  return w;
}

function sentence(r) {
  const n = 6 + r.int(18);
  const words = [];
  for (let i = 0; i < n; i++) words.push(word(r));
  const s = words.join(' ');
  return s[0].toUpperCase() + s.slice(1) + r.pick(['.', '.', '.', '?', '!']);
}

function paragraph(r, footnotes) {
  const n = 1 + r.int(5);
  const out = [];
  for (let i = 0; i < n; i++) out.push(sentence(r));
  if (r.next() < 0.05) {
    footnotes.push(sentence(r));
    out.push(`[^${footnotes.length}]`);
  }
  return out.join(' ');
}

function items(r, marker) {
  const out = [];
  for (let i = 0, n = 2 + r.int(6); i < n; i++) out.push(`${r.next() < 0.2 ? '  ' : ''}${marker(i)} ${sentence(r)}`);
  return out.join('\n');
}

function table(r) {
  const cols = 2 + r.int(3);
  const line = (cells) => `| ${cells.join(' | ')} |`;
  const out = [line(Array.from({ length: cols }, () => r.pick(WORDS))), `|${Array(cols).fill('---').join('|')}|`];
  for (let i = 0, n = 2 + r.int(6); i < n; i++)
    out.push(line(Array.from({ length: cols }, () => `${word(r)} ${r.pick(WORDS)}`)));
  return out.join('\n');
}

function block(r, footnotes) {
  const k = r.next();
  if (k < 0.12) return `${'#'.repeat(2 + r.int(3))} ${sentence(r).replace(/[.?!]$/, '')}`;
  if (k < 0.43) return paragraph(r, footnotes);
  if (k < 0.58) return items(r, () => '-');
  if (k < 0.65) return items(r, () => `- [${r.next() < 0.4 ? 'x' : ' '}]`);
  if (k < 0.7) return items(r, (i) => `${i + 1}.`);
  if (k < 0.75) return table(r);
  if (k < 0.79) return `> ${paragraph(r, footnotes)}`;
  if (k < 0.82) return `> [!${r.pick(['NOTE', 'TIP', 'WARNING'])}]\n> ${paragraph(r, footnotes)}`;
  if (k < 0.86) {
    const lines = ['```js'];
    for (let i = 0, n = 2 + r.int(6); i < n; i++)
      lines.push(`const ${r.pick(WORDS)}${i} = ${r.int(1000)}; // ${r.pick(WORDS)}`);
    lines.push('```');
    return lines.join('\n');
  }
  if (k < 0.87) return `$$\n\\sum_{i=1}^{${1 + r.int(9)}} x_i^2\n$$`;
  if (k < 0.872) return '```mermaid\ngraph TD;\n  A[Start] --> B{Done?};\n  B -- No --> A;\n```';
  if (k < 0.9) return `![${r.pick(WORDS)}](images/${r.pick(WORDS)}-${r.int(100)}.png)`;
  return paragraph(r, footnotes);
}

/** About `chars` characters of markdown with LF line breaks, ending with a line break. */
export function note(chars, seed = 1) {
  const r = new Rng(seed);
  const footnotes = [];
  const parts = [`---\ntitle: Note ${seed}\ntags: [one, two]\n---`, `# ${sentence(r).replace(/[.?!]$/, '')}`];
  let n = parts[0].length + parts[1].length;
  while (n < chars) {
    const before = footnotes.length;
    const b = block(r, footnotes);
    parts.push(b);
    n += b.length + 2;
    for (const text of footnotes.slice(before)) n += `[^${footnotes.length}]: `.length + text.length + 2;
  }
  const notes = footnotes.map((text, i) => `[^${i + 1}]: ${text}`);
  return [...parts, ...notes].join('\n\n') + '\n';
}
