import { describe, expect, it } from 'vitest';
import { find } from './treeHelpers';

const codes = (text: string) => find(text, 'EmojiCode').map((n) => n.text);

describe('emoji codes', () => {
  it('reads every :name: shape, whatever stands around it', () => {
    expect(codes('Nice :smile: and a:rocket:b')).toEqual([':smile:', ':rocket:']);
  });

  it("reads shapes from the left, the first winning a shared colon, as GitHub's filter does", () => {
    expect(codes('a:b:smile:')).toEqual([':b:']);
    expect(codes(':smile:word:')).toEqual([':smile:']);
  });

  it('keeps two codes that share no colon', () => {
    expect(codes(':smile::rocket:')).toEqual([':smile:', ':rocket:']);
  });

  it('reads the middle of a time as a shape, which is never drawn', () => {
    expect(codes('12:30:45')).toEqual([':30:']);
  });
});
