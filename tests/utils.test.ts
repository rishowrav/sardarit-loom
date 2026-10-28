import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classNames,
  formatBytes,
  formatDate,
  formatDateShort,
  formatDuration,
  formatTimer,
  resolutionLabel,
  toIlikePattern,
  truncate,
} from "@/lib/utils";

describe("formatBytes", () => {
  it("handles non-positive and non-finite input", () => {
    assert.equal(formatBytes(0), "0 B");
    assert.equal(formatBytes(-5), "0 B");
    assert.equal(formatBytes(Number.NaN), "0 B");
    assert.equal(formatBytes(Number.POSITIVE_INFINITY), "0 B");
  });

  it("formats across units", () => {
    assert.equal(formatBytes(512), "512 B");
    assert.equal(formatBytes(1024), "1.0 KB");
    assert.equal(formatBytes(1536), "1.5 KB");
    assert.equal(formatBytes(8 * 1024 * 1024), "8.0 MB");
    assert.equal(formatBytes(2.5 * 1024 ** 3), "2.5 GB");
    assert.equal(formatBytes(1024 ** 4), "1.0 TB");
  });

  it("caps at the largest unit", () => {
    const exabytes = 1024 ** 6;
    assert.equal(formatBytes(exabytes), "1048576.0 TB");
  });
});

describe("formatDuration", () => {
  it("handles null/invalid input", () => {
    assert.equal(formatDuration(null), "0:00");
    assert.equal(formatDuration(undefined), "0:00");
    assert.equal(formatDuration(-10), "0:00");
    assert.equal(formatDuration(Number.NaN), "0:00");
  });

  it("formats seconds and minutes", () => {
    assert.equal(formatDuration(0), "0:00");
    assert.equal(formatDuration(59), "0:59");
    assert.equal(formatDuration(60), "1:00");
    assert.equal(formatDuration(3599), "59:59");
  });

  it("pads hours", () => {
    assert.equal(formatDuration(3600), "1:00:00");
    assert.equal(formatDuration(3725), "1:02:05");
    assert.equal(formatDuration(36_000), "10:00:00");
  });

  it("rounds fractional seconds", () => {
    assert.equal(formatDuration(61.6), "1:02");
  });
});

describe("formatTimer", () => {
  it("converts milliseconds", () => {
    assert.equal(formatTimer(0), "0:00");
    assert.equal(formatTimer(65_000), "1:05");
    assert.equal(formatTimer(3_661_000), "1:01:01");
  });
});

describe("formatDate / formatDateShort", () => {
  it("returns an em dash for invalid dates", () => {
    assert.equal(formatDate("not-a-date"), "—");
    assert.equal(formatDateShort("not-a-date"), "—");
  });

  it("describes recent timestamps relatively", () => {
    const now = Date.now();
    assert.equal(formatDateShort(new Date(now).toISOString()), "just now");
    assert.equal(formatDateShort(new Date(now - 5 * 60_000).toISOString()), "5m ago");
    assert.equal(formatDateShort(new Date(now - 3 * 3_600_000).toISOString()), "3h ago");
    assert.equal(
      formatDateShort(new Date(now - 2 * 86_400_000).toISOString()),
      "2d ago",
    );
  });
});

describe("resolutionLabel", () => {
  it("labels known tiers", () => {
    assert.equal(resolutionLabel(null, null), "—");
    assert.equal(resolutionLabel(1920, 1080), "1920×1080 (1080p)");
    assert.equal(resolutionLabel(2560, 1440), "2560×1440 (1080p)");
    assert.equal(resolutionLabel(1280, 720), "1280×720 (720p)");
    assert.equal(resolutionLabel(800, 600), "800×600");
    assert.equal(resolutionLabel(0, 0), "—");
  });
});

describe("toIlikePattern", () => {
  it("escapes SQL LIKE wildcards", () => {
    assert.equal(toIlikePattern("50%"), "%50\\%%");
    assert.equal(toIlikePattern("a_b"), "%a\\_b%");
    assert.equal(toIlikePattern("back\\slash"), "%back\\\\slash%");
  });

  it("neutralises PostgREST filter characters", () => {
    assert.equal(toIlikePattern("a*b,c"), "%a b c%");
    assert.equal(toIlikePattern("plain"), "%plain%");
  });
});

describe("truncate / classNames", () => {
  it("truncates long text with an ellipsis", () => {
    assert.equal(truncate("short", 10), "short");
    assert.equal(truncate("abcdefghij", 5), "abcd…");
    assert.equal(truncate("abc", 3), "abc");
  });

  it("joins only truthy class names", () => {
    assert.equal(classNames("a", false, null, undefined, "b"), "a b");
    assert.equal(classNames(), "");
  });
});
