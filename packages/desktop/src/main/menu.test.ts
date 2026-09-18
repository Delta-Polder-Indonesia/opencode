import { describe, expect, test } from "bun:test"
import { buildMenuTemplate, menuPlatform, type MenuTemplateItem } from "./menu"

function flatten(items: MenuTemplateItem[]): MenuTemplateItem[] {
  return items.flatMap((item) => [item, ...flatten(item.submenu ?? [])])
}

const handlers = {
  action: () => {},
  command: () => {},
  link: () => {},
}

describe("menuPlatform", () => {
  test("maps node platforms to menu platforms", () => {
    expect(menuPlatform("darwin")).toBe("macos")
    expect(menuPlatform("win32")).toBe("windows")
    expect(menuPlatform("linux")).toBe("windows")
  })
})

describe("buildMenuTemplate", () => {
  test("omits the macOS app menu on Windows", () => {
    const windows = buildMenuTemplate("windows", handlers)
    const macos = buildMenuTemplate("macos", handlers)
    expect(windows.some((menu) => menu.label === "OpenCode")).toBe(false)
    expect(macos.some((menu) => menu.label === "OpenCode")).toBe(true)
  })

  test("builds the standard top-level menus", () => {
    const labels = buildMenuTemplate("windows", handlers).map((menu) => menu.label)
    expect(labels).toEqual(["File", "Edit", "View", "Go", "Window", "Help"])
  })

  test("uses Windows accelerators", () => {
    const items = flatten(buildMenuTemplate("windows", handlers))
    const selectAll = items.find((item) => item.label === "Select All")
    expect(selectAll?.accelerator).toBe("Ctrl+A")
  })

  test("applies translated labels when a bundle is published", () => {
    const template = buildMenuTemplate("windows", handlers, {
      locale: "id",
      messages: { "desktop.menu.file": "Berkas" } as never,
    })
    expect(template[0].label).toBe("Berkas")
    // Untranslated keys fall back to the English source copy.
    expect(template[1].label).toBe("Edit")
  })

  test("every leaf item has a role, click handler, or separator", () => {
    const items = flatten(buildMenuTemplate("windows", handlers)).filter((item) => !item.submenu)
    expect(items.length).toBeGreaterThan(0)
    for (const item of items) {
      expect(item.type === "separator" || !!item.role || !!item.click).toBe(true)
    }
  })
})
