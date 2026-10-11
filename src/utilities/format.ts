// Formatting of times, sizes and durations for humans (console, logs).

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

/** Local time "2026-10-03 11:20:15.123" (log line format). */
export function formatLocalDateTime(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

/** Time zone offset of a local date: "+03:00". */
export function formatTimezoneOffset(date: Date): string {
  const minutes = -date.getTimezoneOffset();
  const sign = minutes >= 0 ? '+' : '-';
  const absoluteMinutes = Math.abs(minutes);

  return `${sign}${pad(Math.floor(absoluteMinutes / 60))}:${pad(absoluteMinutes % 60)}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} bytes`;
  }

  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;

  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }

  const text = value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(2);

  // trailing zeros only of the fractional part: "1.50" → "1.5", "2.00" → "2", but "100" stays "100"
  return `${text.includes('.') ? text.replace(/\.?0+$/, '') : text} ${units[unit]}`;
}

export function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.round(milliseconds / 1000);

  if (totalSeconds < 60) {
    return `${totalSeconds} s`;
  }

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  return hours ? `${hours} h ${minutes} min` : `${minutes} min ${seconds} s`;
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}
