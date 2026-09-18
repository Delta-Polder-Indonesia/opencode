import { describe, expect, test } from "bun:test"
import { formatLogLine, redact } from "./log"

describe("redact", () => {
  test("removes credentials from urls", () => {
    expect(redact("GET /?auth_token=abc123&x=1")).toBe("GET /?auth_token=[redacted]&x=1")
    expect(redact("api_key=sk-lmnopqrstuvwxyz1234")).toBe("api_key=[redacted]")
    expect(redact("password=hunter2")).toBe("password=[redacted]")
  })

  test("removes bearer tokens and api keys", () => {
    expect(redact("Authorization: Bearer abc.def.ghi")).toContain("Bearer [redacted]")
    expect(redact("key sk-abcdefghijklmnop1234")).toBe("key [redacted]")
  })

  test("leaves ordinary messages untouched", () => {
    expect(redact("loading renderer bundle")).toBe("loading renderer bundle")
  })
})

describe("formatLogLine", () => {
  test("includes an ISO timestamp, level, and redacted message", () => {
    const line = formatLogLine("info", "auth_token=secret", new Date("2026-09-18T10:00:00.000Z"))
    expect(line).toBe("2026-09-18T10:00:00.000Z [info] auth_token=[redacted]\n")
  })
})
