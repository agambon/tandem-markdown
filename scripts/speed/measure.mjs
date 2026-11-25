// What the speed scripts share beside the page: a count read from the command line, and the
// median and percentiles their reports give, so that numbers meant to compare across the scripts
// are worked out one way.

/** The number after `name` on the command line (`--letters 40`), or `fallback` when it is not given. */
export function numberOption(name, fallback) {
  const at = process.argv.indexOf(name);
  return at >= 0 ? Number(process.argv[at + 1]) : fallback;
}

/** The value at `q` (0.95 for the 95th percentile) of numbers sorted from least to most: the nearest rank below. */
export function quantile(sorted, q) {
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

/** The median of numbers in any order. */
export function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return quantile(sorted, 0.5);
}
