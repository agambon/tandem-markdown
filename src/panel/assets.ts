// The panel's own files beside its bundle (a library's stylesheet and fonts), found from the
// page's `<meta name="tm-assets">`, which holds the address of dist/panel/.

/** The address of `path` under dist/panel/, or null on a page with no `tm-assets` (tests). */
function assetUrl(path: string): string | null {
  if (typeof document === 'undefined') return null;
  const base = document.querySelector('meta[name="tm-assets"]')?.getAttribute('content');
  return base ? new URL(path, new URL(base, document.baseURI)).href : null;
}

/** The module at `path` under dist/panel/, imported. The page's policy allows scripts from the panel's own files. */
export function loadAsset(path: string): Promise<unknown> {
  const url = assetUrl(path);
  return url ? import(url) : Promise.reject(new Error(`This page has no address for ${path}`));
}

const stylesheets = new Map<string, Promise<void>>();

/**
 * Adds the stylesheet at `path` under dist/panel/ to the page, once. Resolves when it has
 * loaded; rejects when it could not be, or when the page does not say where the panel's files
 * are. With no page at all (unit tests) there is nothing to style, and it resolves. The page's
 * policy allows stylesheets from the panel's own files.
 */
export function addStylesheet(path: string): Promise<void> {
  if (typeof document === 'undefined') return Promise.resolve();
  const base = document.querySelector('meta[name="tm-assets"]')?.getAttribute('content');
  if (!base)
    return Promise.reject(new Error(`The page does not say where the panel's files are, so ${path} cannot load`));
  const href = new URL(path, new URL(base, document.baseURI)).href;
  let loading = stylesheets.get(href);
  if (!loading) {
    loading = new Promise((resolve, reject) => {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = href;
      link.addEventListener('load', () => resolve());
      link.addEventListener('error', () => reject(new Error(`Could not load ${href}`)));
      document.head.appendChild(link);
    });
    stylesheets.set(href, loading);
  }
  return loading;
}
