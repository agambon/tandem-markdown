// What, in the pictures the panel shows for diagrams (SVG documents in `data:` addresses),
// could run or load, for the browser specs. The pictures are read in a page of their own with
// no content policy, so reading them reports nothing: script elements, frames and objects,
// handlers, and addresses that are scripts or that point outside the picture.

/** One line per thing found in `sources` (the pictures' addresses), naming the picture by its place in the list. */
export async function inspectPictures(browser, sources) {
  const reader = await browser.newPage();
  try {
    return await reader.evaluate((sources) => {
      const found = [];
      for (const [i, src] of sources.entries()) {
        const svg = decodeURIComponent(src.slice(src.indexOf(',') + 1));
        const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
        if (doc.querySelector('parsererror')) found.push(`${i}: not well-formed`);
        for (const el of doc.querySelectorAll('*')) {
          if (/^(script|iframe|frame|object|embed|form|base|link|meta)$/i.test(el.localName))
            found.push(`${i}: <${el.localName}>`);
          for (const attr of el.attributes) {
            const value = attr.value.trim().toLowerCase();
            if (/^on/i.test(attr.localName)) found.push(`${i}: [${attr.name}]`);
            if (
              /^(href|src|xlink:href)$/i.test(attr.name) &&
              /^(javascript|vbscript|data:text|https?:|\/\/)/.test(value)
            )
              found.push(`${i}: [${attr.name}=${value.slice(0, 30)}]`);
          }
        }
        if (/url\(\s*['"]?(https?:|\/\/)/i.test(svg)) found.push(`${i}: a stylesheet address outside the picture`);
      }
      return found;
    }, sources);
  } finally {
    await reader.close();
  }
}
