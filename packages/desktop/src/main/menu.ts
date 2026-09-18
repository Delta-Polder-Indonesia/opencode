import {
  DESKTOP_MENU,
  desktopMenuVisible,
  type DesktopMenuEntry,
  type DesktopMenuPlatform,
} from "@opencode-ai/app/desktop-menu"
import {
  DESKTOP_NATIVE_ENGLISH,
  type DesktopNativeBundle,
  type DesktopNativeKey,
} from "@opencode-ai/app/i18n/desktop-native"

export type MenuHandlers = {
  /** Native window/app level action (zoom, reload, quit, ...). */
  action: (action: string) => void
  /** Command routed into the renderer so the existing UI handles it. */
  command: (command: string) => void
  /** External documentation/support link. */
  link: (href: string) => void
}

export type MenuTemplateItem = {
  label?: string
  role?: string
  type?: "separator" | "normal"
  accelerator?: string
  click?: () => void
  submenu?: MenuTemplateItem[]
}

export function menuPlatform(platform: NodeJS.Platform): DesktopMenuPlatform {
  return platform === "darwin" ? "macos" : "windows"
}

function translator(bundle?: DesktopNativeBundle) {
  return (key: DesktopNativeKey) => bundle?.messages[key] ?? DESKTOP_NATIVE_ENGLISH[key]
}

function entryTemplate(
  entry: DesktopMenuEntry,
  platform: DesktopMenuPlatform,
  t: (key: DesktopNativeKey) => string,
  handlers: MenuHandlers,
): MenuTemplateItem | undefined {
  if (!desktopMenuVisible(entry, platform)) return undefined
  if (entry.type === "separator") return { type: "separator" }

  const item: MenuTemplateItem = {}
  if (entry.labelKey) item.label = t(entry.labelKey)
  const accelerator = entry.accelerator?.[platform]
  if (accelerator) item.accelerator = accelerator

  // Prefer native roles: they keep platform behaviour (and work while the
  // renderer is busy) without any privileged IPC.
  if (entry.role) {
    item.role = entry.role
    return item
  }
  if (entry.href) {
    const href = entry.href
    item.click = () => handlers.link(href)
    return item
  }
  if (entry.command) {
    const command = entry.command
    item.click = () => handlers.command(command)
    return item
  }
  if (entry.action) {
    const action = entry.action
    item.click = () => handlers.action(action)
    return item
  }
  return item
}

/**
 * Builds a platform-appropriate Electron menu template from the menu definition
 * the web app already owns, so desktop and web keep the same command surface.
 */
export function buildMenuTemplate(
  platform: DesktopMenuPlatform,
  handlers: MenuHandlers,
  bundle?: DesktopNativeBundle,
): MenuTemplateItem[] {
  const t = translator(bundle)
  const menus: MenuTemplateItem[] = []
  for (const menu of DESKTOP_MENU) {
    if (!desktopMenuVisible(menu, platform)) continue
    const submenu = (menu.items ?? [])
      .map((entry) => entryTemplate(entry, platform, t, handlers))
      .filter((entry): entry is MenuTemplateItem => !!entry)
    if (!submenu.length) continue
    menus.push({ label: t(menu.labelKey), submenu })
  }
  return menus
}
