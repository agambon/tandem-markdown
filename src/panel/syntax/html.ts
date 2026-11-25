// What HTML in a file and other programs' pictures add: picture sizes, players, pictures for one theme.

import { AzurePictureSize, LogseqPictureBraces, PictureBraces } from '../markdown/pictureSize';
import type { Syntax } from './types';

export const HTML = [
  {
    id: 'pictureSizes',
    default: true,
    description:
      'Draw a picture at the size written in braces after it, `![](pic.png){width=50%}` (Pandoc, Quarto, GitLab), or after its alt text and a bar, as Obsidian writes it.',
    parse: [PictureBraces],
    draw: [],
  },
  {
    id: 'otherPictureSizes',
    default: false,
    description:
      "Read a picture's size written after its address, `![](pic.png =300x200)` (Azure DevOps), and in Logseq's braces, `![](pic.png){:height 200, :width 300}`.",
    parse: [AzurePictureSize, LogseqPictureBraces],
    draw: [],
  },
  {
    id: 'media',
    default: false,
    description:
      'Play video and sound files from the workspace where a file has `<video>` or `<audio>`, an embed such as `![[talk.ogg]]`, or a link to one written as a picture, `![demo](demo.mp4)`. Nothing plays by itself; files from https addresses only while `tandemMarkdown.images.allowRemote` is on.',
    parse: [],
    draw: [],
  },
  {
    id: 'themePictures',
    default: true,
    description:
      'Show a picture whose address ends in `#gh-dark-mode-only` or `#only-dark` only with a dark theme, and one ending in `#gh-light-mode-only` or `#only-light` only with a light theme (GitHub, Material for MkDocs).',
    parse: [],
    draw: [],
  },
] as const satisfies readonly Syntax[];
