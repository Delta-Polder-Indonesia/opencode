#!/usr/bin/env bun
import { $ } from "bun"

import { buildNodeServer, resolveChannel } from "./utils"

const channel = resolveChannel()
await $`bun ./scripts/copy-icons.ts ${channel}`

await buildNodeServer()
