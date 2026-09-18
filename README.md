<h1 align="center">OpenCode</h1>
<p align="center">The open source AI coding agent.</p>
<p align="center">
  <a href="https://www.npmjs.com/package/opencode-ai"><img alt="npm" src="https://img.shields.io/npm/v/opencode-ai?style=flat-square" /></a>
  <a href="https://opencode.ai/discord"><img alt="Discord" src="https://img.shields.io/discord/1391832426048651334?style=flat-square&label=discord" /></a>
  <a href="https://github.com/anomalyco/opencode"><img alt="Upstream" src="https://img.shields.io/badge/upstream-anomalyco%2Fopencode-blue?style=flat-square" /></a>
</p>

> [!IMPORTANT]
> **Catatan fork.** Repositori ini adalah fork tidak resmi dari
> [anomalyco/opencode](https://github.com/anomalyco/opencode) (MIT) yang
> dipelihara oleh **Delta Polder Indonesia**. Bukan produk resmi OpenCode dan
> tidak berafiliasi dengan tim OpenCode. Untuk instalasi, dokumentasi, dan
> dukungan umum, rujuk ke repositori upstream.

[![OpenCode Desktop](screenshot-uk.png)](https://opencode.ai)

---

### Installation

```bash
# YOLO
curl -fsSL https://opencode.ai/install | bash

# Package managers
npm i -g opencode-ai@latest        # or bun/pnpm/yarn
scoop install opencode             # Windows
choco install opencode             # Windows
brew install anomalyco/tap/opencode # macOS and Linux (recommended, always up to date)
brew install opencode              # macOS and Linux (official brew formula, updated less)
sudo pacman -S opencode            # Arch Linux (Stable)
paru -S opencode-bin               # Arch Linux (Latest from AUR)
mise use -g opencode               # Any OS
nix run nixpkgs#opencode           # or github:anomalyco/opencode for latest dev branch
```

> [!TIP]
> Remove versions older than 0.1.x before installing.

### Menjalankan di Windows (aman)

Server opencode di Windows **tidak punya autentikasi kecuali** kamu mengatur
`OPENCODE_SERVER_PASSWORD`. Tanpa password, siapa pun yang bisa menjangkau
portnya (mis. lewat Wi-Fi kantor) dapat menjalankan perintah shell dan mengubah
file di PC-mu. Karena itu `packages/app/vite.config.ts` yang memakai
`host: "0.0.0.0"` dan flag `--hostname 0.0.0.0` / `--mdns` harus dihindari
kecuali benar-benar perlu.

#### Cara cepat

```cmd
:: klik dua kali di Explorer, atau:
script\dev-safe.cmd
```

`dev-safe.cmd` menjalankan `script\dev-safe.ps1` dengan setelan paling aman:
bind `127.0.0.1`, meminta password lewat prompt (tidak terlihat saat diketik),
lalu membersihkan password lagi setelah server berhenti.

#### Opsi `script\dev-safe.ps1`

| Perintah | Hasil |
| --- | --- |
| `powershell -ExecutionPolicy Bypass -File .\script\dev-safe.ps1` | Server + UI di satu port `4096`, hanya localhost |
| `... -WithDevUi` | Server `:4096` + Vite dev UI `:3000` (hot reload), keduanya `127.0.0.1` |
| `... -WithDevUi -DevUiPort 3001` | Sama, kalau port `3000` sedang dipakai |
| `... -FromSource` | Menjalankan dari checkout ini lewat `bun` (jalankan `bun install` dulu) |
| `... -Verify` | **Tidak** menjalankan apa pun; hanya melaporkan port ini terbuka ke jaringan atau tidak, dan autentikasi aktif atau tidak |
| `... -AllowLan -Cors http://<IP-PC>:3000` | Membuka ke LAN (berisiko, disertai peringatan) |

#### Tanpa script

```powershell
# 1) Masukkan password tanpa tampil di layar
$sec = Read-Host "Password opencode" -AsSecureString
$env:OPENCODE_SERVER_PASSWORD = [System.Net.NetworkCredential]::new("", $sec).Password

# 2) Jalankan tanpa --hostname (default 127.0.0.1)
opencode web --port 4096      # UI + API di satu port, buka http://localhost:4096
# atau
opencode serve --port 4096    # API saja, untuk dipakai bareng `bun run dev:web`

# 3) Bersihkan setelah selesai
Remove-Item Env:\OPENCODE_SERVER_PASSWORD
```

Username default `opencode` (ubah dengan `OPENCODE_SERVER_USERNAME`). Password
tidak bisa disimpan di `opencode.json` — hanya lewat environment.

#### Verifikasi cepat

```powershell
netstat -ano | findstr :4096                                    # harus 127.0.0.1:4096, bukan 0.0.0.0:4096
curl.exe -s -o NUL -w "%{http_code}`n" http://127.0.0.1:4096/global/health   # harus 401 tanpa login
```

Kunci hostname di `C:\Users\<nama>\.config\opencode\opencode.json` agar `--mdns`
tidak pernah diam-diam membuka `0.0.0.0`:

```json
{ "server": { "hostname": "127.0.0.1", "port": 4096 } }
```

Butuh diakses dari HP/laptop lain? Jangan buka LAN — pakai SSH tunnel
(`ssh -N -L 4096:127.0.0.1:4096 user@PC-INI`) atau VPN seperti Tailscale.

> Alat di atas diuji otomatis di Windows oleh workflow
> [`dev-safe (Windows)`](.github/workflows/dev-safe-windows.yml) pada setiap PR.

### Desktop App (BETA)

OpenCode is also available as a desktop application. Download directly from the [releases page](https://github.com/anomalyco/opencode/releases) or [opencode.ai/download](https://opencode.ai/download).

| Platform              | Download                           |
| --------------------- | ---------------------------------- |
| macOS (Apple Silicon) | `opencode-desktop-mac-arm64.dmg`   |
| macOS (Intel)         | `opencode-desktop-mac-x64.dmg`     |
| Windows               | `opencode-desktop-windows-x64.exe` |
| Linux                 | `.deb`, `.rpm`, or `.AppImage`     |

```bash
# macOS (Homebrew)
brew install --cask opencode-desktop
# Windows (Scoop)
scoop bucket add extras; scoop install extras/opencode-desktop
```

#### Installation Directory

The install script respects the following priority order for the installation path:

1. `$OPENCODE_INSTALL_DIR` - Custom installation directory
2. `$XDG_BIN_DIR` - XDG Base Directory Specification compliant path
3. `$HOME/bin` - Standard user binary directory (if it exists or can be created)
4. `$HOME/.opencode/bin` - Default fallback

```bash
# Examples
OPENCODE_INSTALL_DIR=/usr/local/bin curl -fsSL https://opencode.ai/install | bash
XDG_BIN_DIR=$HOME/.local/bin curl -fsSL https://opencode.ai/install | bash
```

### Agents

OpenCode includes two built-in agents you can switch between with the `Tab` key.

- **build** - Default, full-access agent for development work
- **plan** - Read-only agent for analysis and code exploration
  - Denies file edits by default
  - Asks permission before running bash commands
  - Ideal for exploring unfamiliar codebases or planning changes

Also included is a **general** subagent for complex searches and multistep tasks.
This is used internally and can be invoked using `@general` in messages.

Learn more about [agents](https://opencode.ai/docs/agents).

### Documentation

For more info on how to configure OpenCode, [**head over to our docs**](https://opencode.ai/docs).

Dokumen internal fork ini:

| Berkas | Isi |
| --- | --- |
| [`catatan.md`](./catatan.md) | Catatan handover antar-sesi: keputusan, temuan, dan batasan sandbox |
| [`specs/v2/`](./specs/v2) | Spesifikasi kerja V2 (streaming, background jobs, session cursor, dsb.) |
| `script/dev-safe.ps1` | Runner aman untuk Windows, plus `script/dev-safe.tests.ps1` untuk ujinya |

### Contributing

Repositori ini tidak memuat panduan kontribusi upstream (`CONTRIBUTING.md`).
Untuk berkontribusi ke proyek OpenCode, baca
[panduan upstream](https://github.com/anomalyco/opencode/blob/dev/CONTRIBUTING.md).
Untuk perubahan khusus fork ini, buka pull request ke branch `main` repositori
ini — CI Windows (`script/dev-safe.*`) akan berjalan otomatis.

### Building on OpenCode

If you are working on a project that's related to OpenCode and is using "opencode" as part of its name, for example "opencode-dashboard" or "opencode-mobile", please add a note to your README to clarify that it is not built by the OpenCode team and is not affiliated with us in any way.

---

**Upstream** [opencode.ai](https://opencode.ai) | [Docs](https://opencode.ai/docs) | [Discord](https://discord.gg/opencode) | [X.com](https://x.com/opencode) | [GitHub](https://github.com/anomalyco/opencode)
