// A string stand-in that counts the characters a reader reads from it, so a test can bound a
// reader's work on a hostile input instead of timing it. It answers only the string methods the
// readers under test use and throws on any other, so a reader that starts reading another way
// fails the test until it is counted, rather than going uncounted.

/** `text` behind a counter: pass `text` to the reader, then `read()` is how many characters it read. */
export function countingText(source: string): { text: string; read: () => number } {
  let read = 0;
  const wrap = (s: string): string => {
    const handler: ProxyHandler<object> = {
      get(_target, key) {
        if (typeof key === 'string' && /^\d+$/.test(key)) {
          read++;
          return s[Number(key)];
        }
        switch (key) {
          case 'length':
            return s.length;
          case 'charCodeAt':
            return (at: number) => {
              read++;
              return s.charCodeAt(at);
            };
          case 'indexOf':
            return (needle: string, from = 0) => {
              const start = Math.max(0, from);
              const at = s.indexOf(needle, start);
              read += Math.max(0, (at < 0 ? s.length : at + needle.length) - start);
              return at;
            };
          case 'startsWith':
            return (needle: string, from = 0) => {
              read += needle.length;
              return s.startsWith(needle, from);
            };
          case 'slice':
            return (from?: number, to?: number) => {
              const part = s.slice(from, to);
              read += part.length;
              return part;
            };
          case 'toLowerCase':
            return () => {
              read += s.length;
              return wrap(s.toLowerCase());
            };
          case 'toString':
          case 'valueOf':
          case Symbol.toPrimitive:
            return () => {
              read += s.length;
              return s;
            };
          default:
            throw new Error(`countingText does not count ${String(key)}`);
        }
      },
    };
    return new Proxy({}, handler) as unknown as string;
  };
  return { text: wrap(source), read: () => read };
}
