import { describe, expect, test } from "bun:test"
import { backendSettled, backendUsable, serverConnection, waitForBackend } from "./bootstrap"
import type { BackendStatus, DesktopInfo } from "../shared/ipc"

function info(overrides: Partial<DesktopInfo> = {}): DesktopInfo {
  return {
    version: "1.18.31",
    os: "windows",
    windowID: "w1",
    serverUrl: "http://127.0.0.1:39915",
    defaultServerUrl: null,
    localServerAuth: { username: "opencode", password: "generated" },
    backend: { status: "ready", url: "http://127.0.0.1:39915" },
    ...overrides,
  }
}

describe("serverConnection", () => {
  test("carries the generated credentials for the bundled backend", () => {
    expect(serverConnection(info())).toEqual({
      type: "http",
      http: { url: "http://127.0.0.1:39915", username: "opencode", password: "generated" },
    })
  })

  test("sends no credentials for a server the user runs themselves", () => {
    const conn = serverConnection(info({ localServerAuth: null, serverUrl: "http://127.0.0.1:4096" }))
    expect(conn).toEqual({ type: "http", http: { url: "http://127.0.0.1:4096" } })
  })
})

describe("backendUsable / backendSettled", () => {
  test("ready and external backends are usable", () => {
    expect(backendUsable({ status: "ready", url: "http://127.0.0.1:1" })).toBe(true)
    expect(backendUsable({ status: "external", url: "http://127.0.0.1:2" })).toBe(true)
  })

  test("starting is neither usable nor settled", () => {
    expect(backendUsable({ status: "starting" })).toBe(false)
    expect(backendSettled({ status: "starting" })).toBe(false)
  })

  test("failed is settled but not usable", () => {
    const failed: BackendStatus = { status: "failed", messageKey: "backend.error.startupTimeout" }
    expect(backendUsable(failed)).toBe(false)
    expect(backendSettled(failed)).toBe(true)
  })
})

describe("waitForBackend", () => {
  test("resolves immediately when the backend is already ready", async () => {
    const status = await waitForBackend({
      state: async () => ({ status: "ready", url: "http://127.0.0.1:4096" }),
      subscribe: () => () => {},
    })
    expect(status).toEqual({ status: "ready", url: "http://127.0.0.1:4096" })
  })

  test("waits for a starting backend to become ready", async () => {
    let emit: ((state: BackendStatus) => void) | undefined
    const pending = waitForBackend({
      state: async () => ({ status: "starting" }),
      subscribe: (handler) => {
        emit = handler
        return () => {}
      },
    })
    await Promise.resolve()
    emit!({ status: "starting" })
    emit!({ status: "ready", url: "http://127.0.0.1:5000" })
    expect(await pending).toEqual({ status: "ready", url: "http://127.0.0.1:5000" })
  })

  test("resolves on failure instead of hanging", async () => {
    const status = await waitForBackend({
      state: async () => ({ status: "failed", messageKey: "backend.error.missingBinary" }),
      subscribe: () => () => {},
    })
    expect(status.status).toBe("failed")
  })

  test("unsubscribes once settled", async () => {
    let unsubscribed = false
    await waitForBackend({
      state: async () => ({ status: "ready", url: "http://127.0.0.1:4096" }),
      subscribe: () => () => {
        unsubscribed = true
      },
    })
    expect(unsubscribed).toBe(true)
  })

  test("does not miss a transition that lands before the first read resolves", async () => {
    let emit: ((state: BackendStatus) => void) | undefined
    const pending = waitForBackend({
      state: () =>
        new Promise((resolve) => {
          emit!({ status: "ready", url: "http://127.0.0.1:6000" })
          resolve({ status: "starting" })
        }),
      subscribe: (handler) => {
        emit = handler
        return () => {}
      },
    })
    expect(await pending).toEqual({ status: "ready", url: "http://127.0.0.1:6000" })
  })
})
