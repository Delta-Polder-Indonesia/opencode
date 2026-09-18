# Prompt untuk sesi berikutnya

Salin blok di bawah ini sebagai pesan pertama di sesi baru.

---

## Prompt A — Verifikasi UI + Tahap 1D (installer Windows)

> Lanjutkan pengembangan Desktop AI IDE di `Delta-Polder-Indonesia/opencode`.
> Komunikasi dan laporan progres dalam **bahasa Indonesia**.
>
> **Konteks — baca dulu sebelum mulai:**
>
> - `catatan.md` bagian "Perencanaan Pengembangan Desktop AI IDE", khususnya
>   bagian **"RINGKASAN PENUTUP — Tahap 1A + 1B SELESAI"**.
> - `packages/desktop/AGENTS.md` dan `AGENTS.md` root.
> - `packages/desktop/PANDUAN-WINDOWS.md` (cara menjalankan di Windows).
>
> **Status saat ini:** Tahap 0 sebagian, Tahap 1A dan 1B **selesai dan sudah
> tervalidasi di Windows 10 x64 nyata** — aplikasi Electron terbuka, menjalankan
> backend lokalnya sendiri (loopback + password acak per proses), dan me-render
> UI OpenCode. Semua sudah masuk `main` lewat PR #15.
>
> **Ruang lingkup sesi ini — hanya dua hal:**
>
> **1. Verifikasi UI yang sudah hidup** (belum pernah diuji sama sekali):
>
> - Folder picker (dialog native Windows).
> - Chat end-to-end — membuktikan kredensial backend benar-benar dipakai.
> - Terminal di dalam aplikasi.
> - **Kebersihan proses saat keluar**: tutup aplikasi, lalu pastikan tidak ada
>   `opencode.exe` tersisa di Task Manager. Jalur `taskkill /T` sudah ditulis
>   dan diuji lewat mock, **tetapi belum pernah dijalankan sungguhan** — ini
>   yang paling rawan.
> - Layar error + tombol coba lagi: rename `resources\backend\opencode.exe`,
>   jalankan, lalu kembalikan namanya dan tekan coba lagi.
>
> **2. Tahap 1D — installer Windows x64:**
>
> - `bun run package:win` (backend + bundel + `electron-builder --win --x64`).
> - Uji pada Windows bersih: install → buka dari ikon desktop → pilih folder →
>   chat → tutup → buka ulang → uninstall.
>
> **Ketentuan kerja:**
>
> 1. Tetap di branch sesi; jangan pindah branch.
> 2. Jangan merusak mode web maupun koneksi server remote.
> 3. Keamanan tetap: `nodeIntegration: false`, `contextIsolation: true`,
>    sandbox renderer, IPC tervalidasi, backend hanya loopback + berpassword.
> 4. Monaco, live preview, Git UI, debugger = tahap berikutnya, **bukan** sekarang.
> 5. Perbarui checklist dan progres `catatan.md`: perubahan, hasil pengujian,
>    kendala, keputusan teknis, langkah berikutnya.
> 6. Kerjakan implementasinya, bukan sekadar menyusun rencana.
> 7. Kalau build/uji Windows belum bisa dilakukan, tulis **terblokir/belum
>    terverifikasi** — jangan mengklaim installer siap rilis.
>
> **Catatan lingkungan sandbox (hemat waktu, jangan diulang):**
>
> - Bun: `npm i -g bun@1.3.14` (installer `bun.sh` diblokir TLS).
> - `bun install` butuh `NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt`
>   dan `--ignore-scripts` (build native `tree-sitter-powershell` gagal).
> - Build backend butuh `MODELS_DEV_API_JSON` bila `models.dev` diblokir.
> - **Binary Electron tidak bisa diunduh di sandbox** — runtime Electron hanya
>   bisa diuji di mesin Windows pengguna. Jangan buang waktu mencoba.
> - Jalankan test dari direktori paket, bukan dari root repo.
> - Sandbox bisa me-reset `node_modules` dan `.git` di tengah sesi; pulihkan
>   dengan `git fetch origin <branch>` lalu `git reset --soft FETCH_HEAD`.

---

## Prompt B — Kalau ingin langsung ke Tahap 2 (fitur IDE)

> Lanjutkan pengembangan Desktop AI IDE di `Delta-Polder-Indonesia/opencode`.
> Komunikasi dalam **bahasa Indonesia**.
>
> Baca `catatan.md` (bagian "RINGKASAN PENUTUP — Tahap 1A + 1B SELESAI") dan
> `packages/desktop/AGENTS.md`.
>
> Tahap 1A dan 1B sudah selesai dan tervalidasi di Windows nyata. Sesi ini fokus
> pada **Tahap 2**: [sebutkan satu saja — editor Monaco, live preview, Git UI,
> > atau debugger].
>
> Ketentuan: tetap di branch sesi, jangan rusak mode web, keamanan tetap dijaga,
> i18n wajib untuk setiap string baru, dan ikuti ketentuan benchmark bila
> menyentuh session/timeline. Perbarui `catatan.md` di akhir.
>
> **Penting:** verifikasi UI dari Tahap 1B (folder picker, chat, kebersihan
> proses saat keluar) dan installer Tahap 1D **belum dikerjakan**. Kalau sesi ini
> langsung ke Tahap 2, catat kedua hal itu sebagai utang yang masih terbuka.

---

## Ringkasan teknis yang perlu dibawa ke sesi baru

**Kontrak backend (terverifikasi runtime):**

- Health: `GET /api/health` → `{"healthy":true}`; Basic auth wajib.
- Banner stdout: `opencode server listening on http://<host>:<port>`.
- `--port 0` → utamakan 4096, lalu port bebas.

**Keputusan yang masih berlaku:**

- Bind `127.0.0.1` saja; password `randomBytes(24).toString("base64url")` per
  run, dikirim lewat **environment** (bukan argv/URL).
- `useExternal(url)` tidak pernah spawn/kill; `backendRetry` hanya dari `failed`.
- Windows: `taskkill /T` (tanpa `/F` pada tahap graceful). POSIX: process group.
- **Jangan pernah pakai `__dirname`** di `packages/desktop/src/main/` — Bun
  mengganti saat build. Pakai `mainBundleDir()` dari `paths.ts`.
- Backend wajib di luar asar (`extraResources`).

**Perintah verifikasi:**

```sh
cd packages/desktop
bun test src                      # 99 pass
bun run script/verify-backend.ts  # 8/8, butuh resources/backend/
bun run script/build.ts
cd ../app && bun run test:unit    # 724 pass
```
