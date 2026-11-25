import { describe, expect, it } from 'vitest';
import { COPY_FAILED, copyAction } from '../../src/panel/copyText';
import { fakeContext } from './helpers';

describe('copyAction', () => {
  it('copies all of the text and lets its notice close', async () => {
    const { ctx, notices } = fakeContext();
    const written: string[] = [];
    const action = copyAction(ctx, 'Copy text', 'every word typed', async (t) => {
      written.push(t);
    });
    expect(action.label).toBe('Copy text');
    expect(action.closeWhenDone).toBe(true);
    expect(await action.run()).toBe(true);
    expect(written).toEqual(['every word typed']);
    expect(notices).toEqual([]);
  });

  it('keeps its notice when the copy fails, and says the text is still there', async () => {
    const { ctx, notices } = fakeContext();
    const action = copyAction(ctx, 'Copy text', 'typed', () => Promise.reject(new Error('Denied')));
    expect(await action.run()).toBe(false);
    expect(notices.map((n) => n.text)).toEqual([COPY_FAILED]);
  });
});
