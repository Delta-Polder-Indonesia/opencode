# Desktop icons

Channel-specific icons (`dev`, `beta`, `prod`) generated from the OpenCode logo
mark (see `packages/ui/src/components/logo.tsx`) with ImageMagick. Each channel
directory contains:

- `icon.png` (512x512 master), plus `32x32`, `64x64`, `128x128`, `128x128@2x`,
  and `dock.png` (256x256) sizes.
- `icon.ico` (Windows, multi-resolution).

Colors follow the upstream channel identity sampled from the reference artwork:
`dev` strong `#4F85F4` / weak `#77AEFF`, `prod` strong `#52514D` / weak `#252525`,
`beta` strong `#969695` / weak `#C8C8C8`.

`resources/icons/` (used by electron-builder and the menu) is produced by
`bun ./scripts/copy-icons.ts <channel>`.
