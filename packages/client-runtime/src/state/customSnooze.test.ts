// @effect-diagnostics globalDate:off -- Tests exercise local calendar and elapsed-time snooze input.
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  customSnoozeDateError,
  localSnoozeDate,
  localSnoozeTime,
  resolveCustomSnooze,
} from "./threadSettled.ts";

const now = new Date(2026, 8, 14, 14, 30);

afterEach(() => vi.unstubAllEnvs());

describe("custom snooze", () => {
  it("converts local date and time to an absolute wake time", () => {
    expect(resolveCustomSnooze({ mode: "date", date: "2026-09-15", time: "09:15" }, now)).toBe(
      new Date(2026, 8, 15, 9, 15).toISOString(),
    );
  });

  it.each([
    ["2026-09-14", "14:30"],
    ["2026-09-13", "09:00"],
    ["2027-02-29", "09:00"],
    ["2026-13-01", "09:00"],
    ["2026-09-15", "24:00"],
    ["2026-09-15", "09:60"],
    ["", "09:00"],
    ["2026-09-15", ""],
  ])("rejects invalid or non-future calendar input %s %s", (date, time) => {
    expect(resolveCustomSnooze({ mode: "date", date, time }, now)).toBeNull();
  });

  it.each([
    ["minutes", "45", 45 * 60_000],
    ["hours", "1.5", 90 * 60_000],
    ["days", "2", 48 * 3_600_000],
  ] as const)("resolves %s from the confirmation time", (unit, amount, elapsed) => {
    const confirmedAt = new Date(now.getTime() + 5 * 60_000);
    expect(resolveCustomSnooze({ mode: "duration", amount, unit }, confirmedAt)).toBe(
      new Date(confirmedAt.getTime() + elapsed).toISOString(),
    );
  });

  it.each(["", "0", "-1", "NaN", "Infinity", "1e300"])("rejects invalid duration %s", (amount) => {
    expect(resolveCustomSnooze({ mode: "duration", amount, unit: "hours" }, now)).toBeNull();
  });

  it("rejects nonexistent local times at the spring DST transition", () => {
    vi.stubEnv("TZ", "America/Los_Angeles");
    expect(
      resolveCustomSnooze(
        { mode: "date", date: "2027-03-14", time: "02:30" },
        new Date("2027-03-01T00:00:00Z"),
      ),
    ).toBeNull();
  });

  it("treats duration days as 24 hours across DST", () => {
    vi.stubEnv("TZ", "America/Los_Angeles");
    const before = new Date(2027, 2, 13, 12);
    const wake = resolveCustomSnooze({ mode: "duration", amount: "1", unit: "days" }, before);
    expect(wake).toBe(new Date(2027, 2, 14, 13).toISOString());
  });

  it("formats local input values without converting to UTC", () => {
    const date = new Date(2026, 0, 2, 3, 4);
    expect(localSnoozeDate(date)).toBe("2026-01-02");
    expect(localSnoozeTime(date)).toBe("03:04");
  });
});

describe("customSnoozeDateError", () => {
  it("reports the minute showing on the clock as past instead of invalid", () => {
    // 14:30:30 on the wall clock; the time control offers minutes, so 14:30
    // is pickable but already started.
    const at = new Date(2026, 8, 14, 14, 30, 30);
    expect(customSnoozeDateError({ date: "2026-09-14", time: "14:30" }, at)).toBe("past");
    expect(customSnoozeDateError({ date: "2026-09-14", time: "14:29" }, at)).toBe("past");
  });

  it("stays quiet for the next minute, which the resolver accepts", () => {
    const at = new Date(2026, 8, 14, 14, 30, 30);
    expect(customSnoozeDateError({ date: "2026-09-14", time: "14:31" }, at)).toBeNull();
    expect(resolveCustomSnooze({ mode: "date", date: "2026-09-14", time: "14:31" }, at)).toBe(
      new Date(2026, 8, 14, 14, 31).toISOString(),
    );
  });

  it.each([
    ["", "09:00"],
    ["2026-09-14", "09:60"],
    ["2027-02-29", "09:00"],
    ["2026-13-01", "09:00"],
  ])("reports malformed or rolled-over input %s %s as invalid", (date, time) => {
    expect(customSnoozeDateError({ date, time }, now)).toBe("invalid");
  });

  it("reports a nonexistent local time at the DST transition as invalid, not past", () => {
    vi.stubEnv("TZ", "America/Los_Angeles");
    expect(
      customSnoozeDateError(
        { date: "2027-03-14", time: "02:30" },
        new Date("2027-03-01T00:00:00Z"),
      ),
    ).toBe("invalid");
  });
});
