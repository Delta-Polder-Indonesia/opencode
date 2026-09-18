import { expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { createReasoningDisclosure } from "../../session-ui/src/components/reasoning-disclosure"

test("thinking starts compact, can be expanded, and collapses on completion", async () => {
  const scope = createRoot((dispose) => {
    const [streaming, setStreaming] = createSignal(true)
    return { dispose, setStreaming, disclosure: createReasoningDisclosure(streaming) }
  })
  try {
    expect(scope.disclosure.open()).toBe(false)
    scope.disclosure.setOpen(true)
    expect(scope.disclosure.open()).toBe(true)
    scope.setStreaming(false)
    await Promise.resolve()
    expect(scope.disclosure.open()).toBe(false)
    scope.disclosure.setOpen(true)
    await Promise.resolve()
    expect(scope.disclosure.open()).toBe(true)
  } finally {
    scope.dispose()
  }
})

test("historical thinking stays collapsed but can be reopened", async () => {
  const scope = createRoot((dispose) => ({
    dispose,
    disclosure: createReasoningDisclosure(() => false),
  }))
  try {
    expect(scope.disclosure.open()).toBe(false)
    scope.disclosure.setOpen(true)
    await Promise.resolve()
    expect(scope.disclosure.open()).toBe(true)
    scope.disclosure.setOpen(false)
    expect(scope.disclosure.open()).toBe(false)
  } finally {
    scope.dispose()
  }
})
