// The timing the host and the panels rely on in each other.
import { describe, expect, it } from 'vitest';
import { FLUSH_MS, FLUSH_WAIT_MS } from '../../src/core/protocol';

describe('flush timing', () => {
  it('has the host wait longer for an answer to a flush than a panel takes to give one', () => {
    expect(FLUSH_WAIT_MS).toBeGreaterThan(FLUSH_MS);
  });
});
