import { describe, expect, test } from "bun:test"
import {
  BACKEND_HOSTNAME,
  backendArgs,
  backendEnv,
  basicAuthHeader,
  failureSummary,
  parseListeningUrl,
} from "./backend-policy"

describe("parseListeningUrl", () => {
  test("reads the backend ready banner", () => {
    expect(parseListeningUrl("opencode server listening on http://127.0.0.1:4096")).toBe("http://127.0.0.1:4096")
    expect(parseListeningUrl("opencode server listening on http://127.0.0.1:39915")).toBe("http://127.0.0.1:39915")
  })

  test("ignores unrelated output", () => {
    expect(parseListeningUrl("Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.")).toBeUndefined()
    expect(parseListeningUrl("")).toBeUndefined()
    expect(parseListeningUrl("opencode server listening on not-a-url")).toBeUndefined()
  })

  test("requires an explicit port so we never guess", () => {
    expect(parseListeningUrl("opencode server listening on http://127.0.0.1")).toBeUndefined()
  })

  test("rejects non-http schemes", () => {
    expect(parseListeningUrl("opencode server listening on https://example.com:443")).toBeUndefined()
  })
})

describe("backendArgs", () => {
  test("binds loopback and lets the backend pick a free port", () => {
    expect(backendArgs()).toEqual(["serve", "--port", "0", "--hostname", "127.0.0.1"])
    expect(BACKEND_HOSTNAME).toBe("127.0.0.1")
  })
})

describe("backendEnv", () => {
  test("injects generated credentials and overrides inherited ones", () => {
    const env = backendEnv({ PATH: "/usr/bin", OPENCODE_SERVER_PASSWORD: "inherited" }, "generated")
    expect(env.OPENCODE_SERVER_PASSWORD).toBe("generated")
    expect(env.OPENCODE_SERVER_USERNAME).toBe("opencode")
    expect(env.PATH).toBe("/usr/bin")
  })
})

describe("basicAuthHeader", () => {
  test("matches the scheme the backend expects", () => {
    expect(basicAuthHeader("opencode", "secret")).toBe(`Basic ${Buffer.from("opencode:secret").toString("base64")}`)
  })
})

describe("failureSummary", () => {
  test("maps every reason to an i18n key rather than English copy", () => {
    const reasons = ["missing-binary", "spawn-failed", "exited-early", "startup-timeout", "unhealthy"] as const
    for (const reason of reasons) {
      expect(failureSummary(reason)).toMatch(/^backend\.error\./)
    }
    expect(new Set(reasons.map(failureSummary)).size).toBe(reasons.length)
  })
})
