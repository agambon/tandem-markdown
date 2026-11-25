// Which tag names are HTML, and which of them a file's HTML may use on the page.
//
// ALLOWED_ELEMENTS and ALLOWED_ATTRIBUTES take their lists from html-pipeline 2's
// `SanitizationFilter` allow-list (MIT), which GitHub publishes. html-pipeline's notice:
//
//   Copyright (c) 2012 GitHub Inc. and Jerry Cheung
//
//   Permission is hereby granted, free of charge, to any person obtaining a copy of this
//   software and associated documentation files (the "Software"), to deal in the Software
//   without restriction, including without limitation the rights to use, copy, modify,
//   merge, publish, distribute, sublicense, and/or sell copies of the Software, and to
//   permit persons to whom the Software is furnished to do so, subject to the following
//   conditions:
//
//   The above copyright notice and this permission notice shall be included in all copies
//   or substantial portions of the Software.
//
//   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED,
//   INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
//   PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT
//   HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF
//   CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE
//   OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

export { isHtmlElement } from '../../core/htmlElements';

/**
 * The elements that never hold anything: the HTML standard's void elements, and the obsolete
 * `keygen` and `param`, which its parser closes as soon as they open.
 */
export const VOID_ELEMENTS: ReadonlySet<string> = new Set(
  'area base br col embed hr img input keygen link meta param source track wbr'.split(' '),
);

/**
 * The elements drawn in a line, each with its own class (`tm-html-<name>`): GitHub keeps them
 * and they hold text.
 */
export const INLINE: ReadonlySet<string> = new Set(
  'b strong i em u ins s strike del mark sub sup kbd code tt samp var small abbr cite dfn span time bdo'.split(' '),
);

/**
 * The elements GitHub keeps in a file's HTML (html-pipeline's sanitization allow-list, which
 * GitHub publishes), with `picture` and `source`, which GitHub's documentation adds for a
 * picture that follows the theme. Everything else is removed; its text stays, except a
 * script's or a style's.
 */
export const ALLOWED_ELEMENTS: readonly string[] = (
  'h1 h2 h3 h4 h5 h6 h7 h8 br b i strong em a pre code img tt div ins del sup sub p ol ul table thead ' +
  'tbody tfoot blockquote dl dt dd kbd q samp var hr ruby rt rp li tr td th s strike summary details ' +
  'caption figure figcaption abbr bdo cite dfn mark small span time wbr picture source'
).split(' ');

/**
 * The attributes GitHub keeps on every allowed element, less `accesskey` and `tabindex`: a
 * file must not move the page's keys or its focus order. `id` is not kept, and `name` is kept
 * with `user-content-` before it, as GitHub does.
 */
export const ALLOWED_ATTRIBUTES: readonly string[] = (
  'abbr accept accept-charset action align alt aria-describedby aria-hidden aria-label ' +
  'aria-labelledby axis border cellpadding cellspacing char charoff charset checked clear cols ' +
  'colspan color compact coords datetime dir disabled enctype for frame headers height hreflang ' +
  'hspace ismap label lang maxlength media method multiple name nohref noshade nowrap open progress ' +
  'prompt readonly rel rev role rows rowspan rules scope selected shape size span start summary ' +
  'target title type usemap valign value vspace width itemprop'
).split(' ');

/** The attributes kept on one element only, beside ALLOWED_ATTRIBUTES. */
export const ELEMENT_ATTRIBUTES: Readonly<Record<string, readonly string[]>> = {
  a: ['href'],
  img: ['src', 'longdesc'],
  div: ['itemscope', 'itemtype'],
  blockquote: ['cite'],
  del: ['cite'],
  ins: ['cite'],
  q: ['cite'],
  source: ['srcset'],
};
