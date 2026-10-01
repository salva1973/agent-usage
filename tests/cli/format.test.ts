import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { colorText, formatCompact, formatLocalDate, formatLocalTime, formatPercent, formatRelativeTime } from "../../src/cli/render/format.js";

afterEach(() => vi.unstubAllEnvs());

test.each<[number | null, string]>([
  [0, "0"], [22, "22"], [22.5, "22.5"], [22.04, "22"], [99.99, "100"], [100, "100"], [null, "?"],
])("formatPercent(%s) is %s", (value, expected) => {
  expect(formatPercent(value)).toBe(expected);
});

test.each<[number | null, string]>([
  [0, "0"], [999, "999"], [1000, "1.0k"], [1999, "2.0k"], [1000000, "1.00M"],
  [12400000, "12.40M"], [1000000000, "1.00B"], [3103172254, "3.10B"], [null, "?"],
])("formatCompact(%s) is %s", (value, expected) => {
  expect(formatCompact(value)).toBe(expected);
});

test.each([
  [-1, "(now)"], [0, "(now)"], [59000, "(in 0m)"], [60000, "(in 1m)"],
  [3599999, "(in 59m)"], [3600000, "(in 1h 0m)"], [7199999, "(in 1h 59m)"],
  [86399999, "(in 23h 59m)"], [86400000, "(in 1d 0h)"], [172799999, "(in 1d 23h)"],
])("relative offset %s truncates to %s", (milliseconds, expected) => {
  const now = new Date("2026-10-01T13:40:00Z");
  expect(formatRelativeTime(new Date(now.getTime() + milliseconds), now)).toBe(expected);
});

describe.each(["UTC", "Europe/Rome"])("local calendar formatting in %s", (timezone) => {
  beforeEach(() => vi.stubEnv("TZ", timezone));

  test.each([
    ["2026-10-01T13:40:00Z", "2026-10-01T18:39:40Z", "resets today 18:39", "resets today 20:39"],
    ["2026-10-01T13:40:00Z", "2026-10-02T10:00:00Z", "resets tomorrow 10:00", "resets tomorrow 12:00"],
    ["2026-10-01T13:40:00Z", "2026-10-04T13:09:07Z", "resets Sun 04 Oct 13:09", "resets Sun 04 Oct 15:09"],
    ["2026-10-31T12:00:00Z", "2026-11-01T10:00:00Z", "resets tomorrow 10:00", "resets tomorrow 11:00"],
    ["2026-10-31T12:00:00Z", "2026-11-02T10:00:00Z", "resets Mon 02 Nov 10:00", "resets Mon 02 Nov 11:00"],
    ["2026-12-31T12:00:00Z", "2027-01-01T10:00:00Z", "resets tomorrow 10:00", "resets tomorrow 11:00"],
    ["2026-10-01T22:30:00Z", "2026-10-01T23:30:00Z", "resets today 23:30", "resets today 01:30"],
    ["2026-10-01T21:30:00Z", "2026-10-01T23:30:00Z", "resets today 23:30", "resets tomorrow 01:30"],
    ["2026-10-24T12:00:00Z", "2026-10-25T12:00:00Z", "resets tomorrow 12:00", "resets tomorrow 13:00"],
  ])("reset %s → %s uses the local date", (now, reset, utc, rome) => {
    const nowDate = new Date(now);
    const resetDate = new Date(reset);
    const originalNow = nowDate.getTime();
    const originalReset = resetDate.getTime();
    expect(formatLocalTime(resetDate, nowDate)).toBe(timezone === "UTC" ? utc : rome);
    expect(nowDate.getTime()).toBe(originalNow);
    expect(resetDate.getTime()).toBe(originalReset);
  });

  test("calendar keys follow the local date at UTC midnight boundaries", () => {
    expect(formatLocalDate(new Date("2026-10-01T22:30:00Z"))).toBe(timezone === "UTC" ? "2026-10-01" : "2026-10-02");
  });
});

test.each([
  ["bold", "\u001b[1m"], ["dim", "\u001b[2m"], ["red", "\u001b[31m"], ["yellow", "\u001b[33m"],
] as const)("ANSI helper applies %s and resets", (style, code) => {
  expect(colorText("text", true, style)).toBe(`${code}text\u001b[0m`);
  expect(colorText("text", false, style)).toBe("text");
});

test("ANSI helper combines styles and leaves unstyled text alone", () => {
  expect(colorText("LIMITED", true, "red", "bold")).toBe("\u001b[31m\u001b[1mLIMITED\u001b[0m");
  expect(colorText("text", true)).toBe("text");
});
