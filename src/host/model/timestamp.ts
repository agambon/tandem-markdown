// Times in local time, in the forms the names and texts the host writes give them.

/** `date`'s parts in local time: the year, and each other part as two digits. */
export function localTime(date: Date): {
  year: number;
  month: string;
  day: string;
  hours: string;
  minutes: string;
  seconds: string;
} {
  const two = (n: number) => String(n).padStart(2, '0');
  return {
    year: date.getFullYear(),
    month: two(date.getMonth() + 1),
    day: two(date.getDate()),
    hours: two(date.getHours()),
    minutes: two(date.getMinutes()),
    seconds: two(date.getSeconds()),
  };
}

/** `yyyyMMdd-HHmmss` in local time, for file names. */
export function timestamp(date: Date): string {
  const t = localTime(date);
  return `${t.year}${t.month}${t.day}-${t.hours}${t.minutes}${t.seconds}`;
}
