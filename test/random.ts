// The seed of the tests that draw cases at random (fast-check). The ordinary run uses FIXED_SEED,
// so it draws the same cases every time and a rare case cannot fail an unrelated change.
// TEST_SEED asks for others in a long run: `random` for a fresh seed, a number for that seed, or
// `<seed>:<path>` as a failure prints them, which goes straight to the failing case (with `-t`
// naming its test). A failure always prints the seed and the path.
import type { Parameters } from 'fast-check';

/** The seed of the ordinary run. */
const FIXED_SEED = 1;

const asked = (process.env.TEST_SEED ?? '').trim();
const colon = asked.indexOf(':');
const seedText = colon < 0 ? asked : asked.slice(0, colon);
const SEED =
  seedText === ''
    ? FIXED_SEED
    : seedText === 'random'
      ? (Date.now() ^ (Math.random() * 0x100000000)) | 0
      : Number(seedText);
if (!Number.isInteger(SEED))
  throw new Error(`TEST_SEED must be "random", a whole number or <seed>:<path>, not ${asked}`);
const PATH = colon < 0 ? undefined : asked.slice(colon + 1);

/** A replay runs one case, so a count of how many cases a property checked does not apply. */
export const replaying = PATH !== undefined;

/** `params` for `fc.assert`, with the seed, and the path to replay when TEST_SEED gives one. */
export function seeded<T>(params: Parameters<T> = {}): Parameters<T> {
  return { ...params, seed: SEED, ...(PATH === undefined ? {} : { path: PATH, endOnFailure: true }) };
}
