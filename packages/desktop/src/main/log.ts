import { appendFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"

/** Values that must never be written to the log file verbatim. */
const SECRET_RULES: ReadonlyArray<{ pattern: RegExp; replacement: string }> = [
  {
    pattern: /\b(auth_token|access_token|refresh_token|api[-_]?key|password|secret|authorization)=[^&\s"']+/gi,
    replacement: "$1=[redacted]",
  },
  { pattern: /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, replacement: "Bearer [redacted]" },
  { pattern: /\bsk-[A-Za-z0-9_-]{16,}/g, replacement: "[redacted]" },
]

export function redact(message: string) {
  let output = message
  for (const rule of SECRET_RULES) output = output.replace(rule.pattern, rule.replacement)
  return output
}

export function formatLogLine(level: string, message: string, now = new Date()) {
  return `${now.toISOString()} [${level}] ${redact(message)}\n`
}

export class DesktopLog {
  private readonly file: string

  constructor(private readonly dir: string) {
    this.file = join(dir, "desktop.log")
  }

  path() {
    return this.file
  }

  write(level: "info" | "warn" | "error", message: string) {
    const line = formatLogLine(level, message)
    try {
      mkdirSync(this.dir, { recursive: true })
      appendFileSync(this.file, line, "utf8")
    } catch {
      // Logging must never break the app.
    }
    if (level === "error") console.error(line.trimEnd())
    else console.log(line.trimEnd())
  }

  info(message: string) {
    this.write("info", message)
  }

  warn(message: string) {
    this.write("warn", message)
  }

  error(message: string) {
    this.write("error", message)
  }
}
