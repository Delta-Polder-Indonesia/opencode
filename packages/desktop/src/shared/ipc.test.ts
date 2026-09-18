import { describe, expect, test } from "bun:test"
import {
  IPC_CHANNELS,
  parseDirectoryPickerRequest,
  parseExternalUrl,
  parseNotifyRequest,
  parseServerUrl,
  parseStorageGetRequest,
  parseStorageSetRequest,
  parseTitlebarRequest,
  STORAGE_MAX_VALUE_BYTES,
} from "./ipc"

describe("ipc contract", () => {
  test("channel names are unique and namespaced", () => {
    expect(new Set(IPC_CHANNELS).size).toBe(IPC_CHANNELS.length)
    expect(IPC_CHANNELS.every((channel) => channel.startsWith("desktop:"))).toBe(true)
  })
})

describe("parseExternalUrl", () => {
  test("accepts web and mail links", () => {
    expect(parseExternalUrl("https://opencode.ai/docs")).toBe("https://opencode.ai/docs")
    expect(parseExternalUrl("http://127.0.0.1:4096/")).toBe("http://127.0.0.1:4096/")
    expect(parseExternalUrl("mailto:hi@example.com")).toBe("mailto:hi@example.com")
  })

  test("rejects protocols that can launch local handlers", () => {
    expect(parseExternalUrl("file:///etc/passwd")).toBeUndefined()
    expect(parseExternalUrl("javascript:alert(1)")).toBeUndefined()
    expect(parseExternalUrl("ms-msdt:/id")).toBeUndefined()
    expect(parseExternalUrl("vscode://file/C:/x")).toBeUndefined()
    expect(parseExternalUrl(42)).toBeUndefined()
    expect(parseExternalUrl(`https://example.com/${"a".repeat(5000)}`)).toBeUndefined()
  })
})

describe("parseServerUrl", () => {
  test("accepts http(s) urls and explicit clearing", () => {
    expect(parseServerUrl("http://127.0.0.1:4096")).toBe("http://127.0.0.1:4096/")
    expect(parseServerUrl("https://team.example.com")).toBe("https://team.example.com/")
    expect(parseServerUrl(null)).toBeNull()
  })

  test("rejects other input", () => {
    expect(parseServerUrl("ws://127.0.0.1:4096")).toBeUndefined()
    expect(parseServerUrl("not a url")).toBeUndefined()
    expect(parseServerUrl(undefined)).toBeUndefined()
  })
})

describe("parseStorage*", () => {
  test("accepts safe namespaces and keys", () => {
    expect(parseStorageGetRequest({ namespace: "settings", key: "theme.v1" })).toEqual({
      namespace: "settings",
      key: "theme.v1",
    })
  })

  test("rejects traversal and control characters", () => {
    expect(parseStorageGetRequest({ namespace: "../escape", key: "a" })).toBeUndefined()
    expect(parseStorageGetRequest({ namespace: "ok", key: "a/b" })).toBeUndefined()
    expect(parseStorageGetRequest({ namespace: "ok", key: "a\u0000b" })).toBeUndefined()
    expect(parseStorageGetRequest({ namespace: "", key: "a" })).toBeUndefined()
    expect(parseStorageGetRequest("settings")).toBeUndefined()
  })

  test("rejects oversized values", () => {
    expect(parseStorageSetRequest({ namespace: "a", key: "b", value: "x" })).toEqual({
      namespace: "a",
      key: "b",
      value: "x",
    })
    expect(
      parseStorageSetRequest({ namespace: "a", key: "b", value: "x".repeat(STORAGE_MAX_VALUE_BYTES + 1) }),
    ).toBeUndefined()
    expect(parseStorageSetRequest({ namespace: "a", key: "b", value: 5 })).toBeUndefined()
  })
})

describe("parseDirectoryPickerRequest", () => {
  test("defaults to an empty request", () => {
    expect(parseDirectoryPickerRequest(undefined)).toEqual({})
  })

  test("validates optional fields", () => {
    expect(parseDirectoryPickerRequest({ title: "Pick", multiple: true })).toEqual({ title: "Pick", multiple: true })
    expect(parseDirectoryPickerRequest({ multiple: "yes" })).toBeUndefined()
    expect(parseDirectoryPickerRequest([])).toBeUndefined()
  })
})

describe("parseNotifyRequest", () => {
  test("requires a non-empty title", () => {
    expect(parseNotifyRequest({ title: "Done" })).toEqual({ title: "Done", description: undefined })
    expect(parseNotifyRequest({ title: "" })).toBeUndefined()
    expect(parseNotifyRequest({ description: "x" })).toBeUndefined()
  })
})

describe("parseTitlebarRequest", () => {
  test("only accepts known theme modes", () => {
    expect(parseTitlebarRequest({ mode: "dark", scheme: "system" })).toEqual({ mode: "dark", scheme: "system" })
    expect(parseTitlebarRequest({ mode: "sepia" })).toBeUndefined()
    expect(parseTitlebarRequest({ mode: "light", scheme: "neon" })).toBeUndefined()
  })
})
