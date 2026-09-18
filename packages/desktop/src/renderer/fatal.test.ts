import { describe, expect, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { describeError, renderFatal } from "./fatal"

if (!globalThis.document) GlobalRegistrator.register()

function root() {
  const element = document.createElement("div")
  document.body.append(element)
  return element
}

describe("renderFatal", () => {
  test("replaces the blank document with a readable reason", () => {
    const element = root()
    element.innerHTML = "<span>stale</span>"

    renderFatal(element, { title: "The interface failed to start", detail: "boom", hint: "check the log" })

    expect(element.textContent).toContain("The interface failed to start")
    expect(element.textContent).toContain("boom")
    expect(element.textContent).toContain("check the log")
    // Whatever was there before must not linger behind the panel.
    expect(element.textContent).not.toContain("stale")
  })

  test("is announced to assistive technology", () => {
    const element = root()
    renderFatal(element, { title: "nope" })
    expect(element.querySelector("[role=alert]")).not.toBeNull()
  })

  test("renders without optional detail or hint", () => {
    const element = root()
    renderFatal(element, { title: "only a title" })
    expect(element.textContent).toBe("only a title")
  })

  test("escapes rather than interprets markup in the detail", () => {
    const element = root()
    renderFatal(element, { title: "t", detail: "<img src=x onerror=alert(1)>" })
    // Diagnostics can quote server output, so they must never become live nodes.
    expect(element.querySelector("img")).toBeNull()
    expect(element.textContent).toContain("<img src=x onerror=alert(1)>")
  })
})

describe("describeError", () => {
  test("keeps the stack when given an Error", () => {
    const error = new Error("kaboom")
    expect(describeError(error)).toContain("kaboom")
  })

  test("stringifies a non-Error throw instead of losing it", () => {
    expect(describeError("plain string")).toBe("plain string")
    expect(describeError(42)).toBe("42")
  })
})
