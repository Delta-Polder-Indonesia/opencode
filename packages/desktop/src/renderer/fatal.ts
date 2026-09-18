/**
 * Last-resort renderer diagnostics.
 *
 * Every early-return in the bootstrap path used to leave an empty document: the
 * window opened, nothing mounted, and there was no clue anywhere about why. A
 * blank white window is the single worst failure mode for a desktop shell,
 * because it is indistinguishable from a hang.
 *
 * This paints a plain, dependency-free panel instead. It deliberately does not
 * use the shared UI or i18n: it has to work when those are exactly what failed
 * to load, and it is developer-facing diagnostic text, not product copy.
 */
export type FatalDetails = {
  title: string
  detail?: string
  hint?: string
}

export function renderFatal(root: HTMLElement, { title, detail, hint }: FatalDetails) {
  root.textContent = ""

  const panel = document.createElement("div")
  panel.setAttribute("role", "alert")
  panel.style.cssText = [
    "font:13px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace",
    "padding:24px",
    "margin:auto",
    "max-width:70ch",
    "color:#111",
    "background:#fff",
    "border:1px solid #d4d4d4",
    "border-radius:8px",
    "white-space:pre-wrap",
    "word-break:break-word",
  ].join(";")

  const heading = document.createElement("strong")
  heading.textContent = title
  heading.style.cssText = "display:block;margin-bottom:8px;font-size:14px"
  panel.append(heading)

  if (detail) {
    const body = document.createElement("div")
    body.textContent = detail
    body.style.cssText = "margin-bottom:8px"
    panel.append(body)
  }

  if (hint) {
    const note = document.createElement("div")
    note.textContent = hint
    note.style.cssText = "color:#666"
    panel.append(note)
  }

  root.append(panel)
}

/** Formats an unknown throw for display without swallowing the stack. */
export function describeError(error: unknown) {
  if (error instanceof Error) return error.stack ?? `${error.name}: ${error.message}`
  return String(error)
}
