import { describe, expect, it } from 'vitest';
import { codeLanguage } from '../../../src/panel/markdown';
import { fenceInfo } from '../../../src/panel/markdown/fenceInfo';

describe('fenceInfo', () => {
  it('reads the language from braces, as Pandoc, Quarto and R Markdown write it', () => {
    expect(fenceInfo('{.python}')).toEqual({ language: 'python', title: null });
    expect(fenceInfo('{#c .haskell .numberLines}')).toEqual({ language: 'haskell', title: null });
    expect(fenceInfo('{.python filename="run.py"}')).toEqual({ language: 'python', title: 'run.py' });
    expect(fenceInfo('{r}')).toEqual({ language: 'r', title: null });
    expect(fenceInfo('{python}')).toEqual({ language: 'python', title: null });
    expect(fenceInfo('{r label, echo=FALSE}')).toEqual({ language: 'r', title: null });
  });

  it('reads the language up to a brace or a space, and a title (VitePress, Hugo, Docusaurus)', () => {
    expect(fenceInfo('js{1,4}')).toEqual({ language: 'js', title: null });
    expect(fenceInfo('go {linenos=inline}')).toEqual({ language: 'go', title: null });
    expect(fenceInfo('js title="app.js" {1,4-6} showLineNumbers')).toEqual({ language: 'js', title: 'app.js' });
    expect(fenceInfo("py title='a b.py'")).toEqual({ language: 'py', title: 'a b.py' });
  });

  it('keeps an info string meant for one output format, and a plain one, as written', () => {
    expect(fenceInfo('{=latex}')).toEqual({ language: '{=latex}', title: null });
    expect(fenceInfo('c++')).toEqual({ language: 'c++', title: null });
    expect(fenceInfo('')).toEqual({ language: '', title: null });
  });
});

describe('codeLanguage', () => {
  it('colors a block in the language its whole info string names, an id before it included', () => {
    expect(codeLanguage('{#id .haskell .numberLines}', true)?.name).toBe('Haskell');
    expect(codeLanguage('{.python filename="run.py"}', true)?.name).toBe('Python');
    expect(codeLanguage('js title="app.js"', true)?.name).toBe('JavaScript');
  });

  it('reads only the first word while code fence labels are off', () => {
    expect(codeLanguage('js title="app.js"', false)?.name).toBe('JavaScript');
    expect(codeLanguage('{#id .haskell}', false)).toBeNull();
    expect(codeLanguage('', false)).toBeNull();
  });
});
