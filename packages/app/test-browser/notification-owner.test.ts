import { expect, test } from "bun:test"
import { createRoot, getOwner } from "solid-js"
import { createServerNotificationState } from "../src/context/notification"
import type { Platform } from "../src/context/platform"

/**
 * Regression guard for the notification directory lookup.
 *
 * `handleSessionIdle` / `handleSessionError` resolve a session asynchronously,
 * so the lookup runs with no reactive owner of its own. `ensureDirSyncContext`
 * registers an `onCleanup` on the caller's owner: called ownerless it produced
 * a cleanup Solid never runs (dev-solid warns "cleanups created outside a
 * `createRoot`") and pinned the directory context forever. The lookup must run
 * under the owner of the notification state that triggered it.
 */
test("resolves the session directory under the notification state's owner", async () => {
  const listeners: Array<(event: { name: string; details: unknown }) => void> = []
  const calls: Array<{ directory: string; owner: ReturnType<typeof getOwner> }> = []
  const session = { id: "ses_1", title: "Session", directory: "/workspace" }

  const state = createRoot((dispose) => {
    const created = createServerNotificationState({
      sdk: {
        scope: "test-scope",
        event: {
          listen: (handler: (event: { name: string; details: unknown }) => void) => {
            listeners.push(handler)
            return () => {}
          },
        },
      } as never,
      sync: {
        ensureDirSyncContext: (directory: string) => {
          // Recorded here, at the call: this is where the cleanup is registered.
          calls.push({ directory, owner: getOwner() })
          return { session: { get: () => session, sync: async () => session } }
        },
      } as never,
      active: () => true,
      directory: () => "/workspace",
      sessionID: () => "ses_1",
      platform: { platform: "web", notify: async () => {} } as unknown as Platform,
      settings: {
        sounds: { agentEnabled: () => false, agent: () => "done", errorsEnabled: () => false, errors: () => "error" },
        notifications: { agent: () => false, errors: () => false },
      } as never,
      language: { t: (key: string) => key } as never,
      navigate: () => {},
    })
    return { created, dispose }
  })

  try {
    expect(listeners).toHaveLength(1)
    listeners[0]({
      name: "/workspace",
      details: { type: "session.idle", properties: { sessionID: "ses_1" } },
    })
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(calls).toHaveLength(1)
    expect(calls[0].directory).toBe("/workspace")
    expect(calls[0].owner).not.toBeNull()
    expect(state.created.session.all("ses_1")).toHaveLength(1)
  } finally {
    state.dispose()
  }
})
