// A feature's fault (src/panel/render/faults.ts): the redraw that turns the feature off is
// dispatched once the update that met the fault is over.

import type { EditorView } from '@codemirror/view';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reportFault } from '../../../src/panel/render/faults';
import { fakeContext } from '../helpers';

describe("a fault's redraw", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('lets an error raised while the redraw is applied reach the page', () => {
    const view = {
      dispatch: () => {
        throw new Error('the redraw could not be applied');
      },
    } as unknown as EditorView;
    reportFault(fakeContext().ctx, 'emphasis', 'build', new Error('drawing failed'), view);
    expect(() => vi.runAllTimers()).toThrow('the redraw could not be applied');
  });

  it('does nothing before the panel has a view', () => {
    reportFault(fakeContext().ctx, 'emphasis', 'build', new Error('drawing failed'));
    expect(() => vi.runAllTimers()).not.toThrow();
  });
});
