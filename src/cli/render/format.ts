export type AnsiStyle = "bold" | "dim" | "red" | "yellow";

const ansiCodes: Record<AnsiStyle, string> = { bold: "\u001b[1m", dim: "\u001b[2m", red: "\u001b[31m", yellow: "\u001b[33m" };

/** Apply the requested ANSI styles only when color output is enabled. */
export function colorText(text: string, color: boolean, ...styles: AnsiStyle[]): string {
  return color && styles.length > 0 ? `${styles.map((style) => ansiCodes[style]).join("")}${text}\u001b[0m` : text;
}

/** Format a known percentage to at most one decimal, without a percent sign. */
export function formatPercent(value: number | null): string {
  return value === null ? "?" : String(Math.round(value * 10) / 10);
}

/** Format token counts with the handoff's fixed decimal precision and suffixes. */
export function formatCompact(value: number | null): string {
  if (value === null) return "?";
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}k`;
  return String(Math.trunc(value));
}

/** Return a sortable calendar-date key in the process's local timezone. */
export function formatLocalDate(date: Date): string {
  return `${String(date.getFullYear()).padStart(4, "0")}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** Format a reset timestamp as today, tomorrow or a punctuation-free local date. */
export function formatLocalTime(reset: Date, now: Date): string {
  const parts = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "2-digit", month: "short",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(reset);
  const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find((entry) => entry.type === type)!.value;
  const clock = `${part("hour")}:${part("minute")}`;
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const resetDay = formatLocalDate(reset);
  if (resetDay === formatLocalDate(now)) return `resets today ${clock}`;
  if (resetDay === formatLocalDate(tomorrow)) return `resets tomorrow ${clock}`;
  return `resets ${part("weekday")} ${part("day")} ${part("month")} ${clock}`;
}

/** Format time until reset using truncated days/hours/minutes, never rounding up. */
export function formatRelativeTime(reset: Date, now: Date): string {
  const milliseconds = reset.getTime() - now.getTime();
  if (milliseconds <= 0) return "(now)";
  const minutes = Math.trunc(milliseconds / 60000);
  if (minutes >= 1440) return `(in ${Math.trunc(minutes / 1440)}d ${Math.trunc(minutes / 60) % 24}h)`;
  if (minutes >= 60) return `(in ${Math.trunc(minutes / 60)}h ${minutes % 60}m)`;
  return `(in ${minutes}m)`;
}
