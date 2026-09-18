/**
 * Shared IPC contract between the Electron main process and the sandboxed
 * renderer preload bridge.
 *
 * Everything here must stay free of Electron and Node imports so both sides and
 * the unit tests can load it.
 */

export const IPC = {
  info: "desktop:info",
  openExternal: "desktop:open-external",
  openDirectoryPicker: "desktop:dialog:open-directory",
  storageGet: "desktop:storage:get",
  storageSet: "desktop:storage:set",
  storageRemove: "desktop:storage:remove",
  defaultServerGet: "desktop:server:get-default",
  defaultServerSet: "desktop:server:set-default",
  notify: "desktop:notify",
  setTitlebar: "desktop:window:set-titlebar",
  runMenuAction: "desktop:menu:run-action",
  publishTranslations: "desktop:i18n:publish",
  restart: "desktop:app:restart",
  backendState: "desktop:backend:state",
  backendRetry: "desktop:backend:retry",
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]

export const IPC_CHANNELS: readonly IpcChannel[] = Object.values(IPC)

/** Renderer -> main events the main process pushes back into the renderer. */
export const IPC_EVENT = {
  menuAction: "desktop:event:menu-action",
  menuCommand: "desktop:event:menu-command",
  backendState: "desktop:event:backend-state",
} as const

/**
 * Backend lifecycle as the renderer sees it. Deliberately free of process
 * details (pid, binary path, credentials): the renderer only needs to know
 * whether it can connect, and what to tell the user when it cannot.
 */
export type BackendStatus =
  | { status: "starting" }
  | { status: "ready"; url: string }
  | { status: "external"; url: string }
  | { status: "failed"; messageKey: string; detail?: string }
  | { status: "stopped" }

export type DesktopInfo = {
  version: string
  os: "windows" | "macos" | "linux"
  windowID: string
  /** Backend the renderer should talk to. Always loopback for the bundled server. */
  serverUrl: string
  /** Default server chosen by the user, when different from the local backend. */
  defaultServerUrl: string | null
  /**
   * Credentials for the bundled loopback backend, which is password protected so
   * other local users cannot drive it. Null when the backend is not ours.
   */
  localServerAuth: { username: string; password: string } | null
  /** Current backend lifecycle state at the time the renderer asked. */
  backend: BackendStatus
}

export type DirectoryPickerRequest = { title?: string; multiple?: boolean }
export type NotifyRequest = { title: string; description?: string }
export type TitlebarRequest = { mode: "light" | "dark"; scheme?: "system" | "light" | "dark" }
export type StorageGetRequest = { namespace: string; key: string }
export type StorageSetRequest = { namespace: string; key: string; value: string }
export type StorageRemoveRequest = { namespace: string; key: string }

/** Maximum size accepted for a single persisted renderer value (1 MiB). */
export const STORAGE_MAX_VALUE_BYTES = 1024 * 1024
/** Maximum size accepted for a notification field. */
export const NOTIFY_MAX_TEXT_LENGTH = 1024

const STORAGE_NAME = /^[a-zA-Z0-9._-]{1,64}$/
// Control characters are matched on purpose: keys containing them are rejected.
// oxlint-disable-next-line no-control-regex
const STORAGE_KEY = /^[^\u0000-\u001f/\\]{1,256}$/

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function optionalString(value: unknown, max: number) {
  if (value === undefined) return true
  return typeof value === "string" && value.length <= max
}

export function parseDirectoryPickerRequest(value: unknown): DirectoryPickerRequest | undefined {
  if (value === undefined) return {}
  if (!isRecord(value)) return undefined
  if (!optionalString(value.title, 256)) return undefined
  if (value.multiple !== undefined && typeof value.multiple !== "boolean") return undefined
  return { title: value.title as string | undefined, multiple: value.multiple as boolean | undefined }
}

export function parseNotifyRequest(value: unknown): NotifyRequest | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value.title !== "string" || !value.title.length || value.title.length > NOTIFY_MAX_TEXT_LENGTH)
    return undefined
  if (!optionalString(value.description, NOTIFY_MAX_TEXT_LENGTH)) return undefined
  return { title: value.title, description: value.description as string | undefined }
}

export function parseTitlebarRequest(value: unknown): TitlebarRequest | undefined {
  if (!isRecord(value)) return undefined
  if (value.mode !== "light" && value.mode !== "dark") return undefined
  if (value.scheme !== undefined && !["system", "light", "dark"].includes(value.scheme as string)) return undefined
  return { mode: value.mode, scheme: value.scheme as TitlebarRequest["scheme"] }
}

function parseStorageTarget(value: unknown) {
  if (!isRecord(value)) return undefined
  if (typeof value.namespace !== "string" || !STORAGE_NAME.test(value.namespace)) return undefined
  if (typeof value.key !== "string" || !STORAGE_KEY.test(value.key)) return undefined
  return { namespace: value.namespace, key: value.key }
}

export function parseStorageGetRequest(value: unknown): StorageGetRequest | undefined {
  return parseStorageTarget(value)
}

export function parseStorageRemoveRequest(value: unknown): StorageRemoveRequest | undefined {
  return parseStorageTarget(value)
}

export function parseStorageSetRequest(value: unknown): StorageSetRequest | undefined {
  const target = parseStorageTarget(value)
  if (!target || !isRecord(value)) return undefined
  if (typeof value.value !== "string") return undefined
  if (byteLength(value.value) > STORAGE_MAX_VALUE_BYTES) return undefined
  return { ...target, value: value.value }
}

export function byteLength(value: string) {
  return new TextEncoder().encode(value).byteLength
}

/**
 * External links are limited to the protocols the app actually needs. Anything
 * else (file:, javascript:, ms-msdt:, custom handlers) is rejected outright so a
 * compromised renderer cannot launch local handlers.
 */
export function parseExternalUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 4096) return undefined
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return undefined
  }
  if (url.protocol !== "http:" && url.protocol !== "https:" && url.protocol !== "mailto:") return undefined
  return url.href
}

/** Server URLs the renderer may persist as its startup default. */
export function parseServerUrl(value: unknown): string | null | undefined {
  if (value === null) return null
  if (typeof value !== "string" || value.length > 2048) return undefined
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return undefined
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined
  return url.toString()
}
