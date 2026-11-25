// Filling in a words table's sentences, in which «name» marks what is filled in.

/** `template` with each «name» in it replaced by `values[name]`; a «name» `values` lacks stays as written. */
export function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/«(\w+)»/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : whole,
  );
}
