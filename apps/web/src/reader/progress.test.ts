import { describe, it, expect, vi, afterEach } from "vitest";
import { createProgressTracker, scrollFraction, clampFraction } from "./progress.ts";

afterEach(() => vi.useRealTimers());

describe("progress", () => {
  it("debounces to the latest value every 3s", () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const t = createProgressTracker(send);
    t.update(0.1);
    t.update(0.2);
    t.update(0.3);
    vi.advanceTimersByTime(2999);
    expect(send).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(0.3);
    t.update(0.5);
    vi.advanceTimersByTime(3000);
    expect(send).toHaveBeenLastCalledWith(0.5);
  });
  it("flush sends immediately and cancels timer", () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const t = createProgressTracker(send);
    t.update(0.7);
    t.flush();
    expect(send).toHaveBeenCalledWith(0.7);
    vi.advanceTimersByTime(5000);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("skips unchanged values", () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const t = createProgressTracker(send, 0.4);
    t.update(0.4);
    vi.advanceTimersByTime(3000);
    expect(send).not.toHaveBeenCalled();
  });
  it("dispose drops pending", () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const t = createProgressTracker(send);
    t.update(0.9);
    t.dispose();
    vi.advanceTimersByTime(5000);
    t.flush();
    expect(send).not.toHaveBeenCalled();
  });
  it("computes scroll fraction", () => {
    expect(scrollFraction({ scrollTop: 50, scrollHeight: 300, clientHeight: 100 })).toBe(0.25);
    expect(scrollFraction({ scrollTop: 0, scrollHeight: 100, clientHeight: 100 })).toBe(0);
    expect(clampFraction(2)).toBe(1);
    expect(clampFraction(NaN)).toBe(0);
  });
});
