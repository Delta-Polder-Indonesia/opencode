# Catatan Sesi — Handover Arena

Catatan kerja fork `Delta-Polder-Indonesia/opencode` (branch sesi:
`arena/01a0b0bc-opencode`). Ditulis 2026-09-17 agar sesi berikutnya bisa
lanjut tanpa menebak-nebak. Rencana induk: 5 perbaikan prioritas yang
disepakati user (lihat `specs/v2/todo.md` dan dokumen per-fase di `specs/v2/`).

## Yang SUDAH selesai (terverifikasi)

1. **Batch streamed deltas + covering context indexes** — commit `b4a187b`.
   Delta text/reasoning/tool-input dicoalesce per fragmen (jendela 50ms,
   ambang 16KB, flush pada batas/settlement/gagal). Setengah bagian index
   = verifikasi saja (sudah memadai; tanpa migrasi baru).
   Dok: `specs/v2/streaming-responsiveness.md`.
2. **Replayable session event cursors (HTTP/SDK)** — commit `1e90341`.
   Endpoint + SDK sudah ada dari sebelumnya; slice ini menambah skenario
   uji kontrak cursor (`v2.session.history.cursor`,
   `v2.session.events.cursor`) + dokumen kontrak konsumen
   `specs/v2/session-event-cursor.md` (resep catch-up-then-tail).
   Bukti: 210/210 skenario httpapi-exercise hijau (mode coverage & auth).
3. **BackgroundJob ↔ eksekusi tool V2** — commit `4e8866d`.
   `bash` kini punya `background: true` (tidak memblokir turn; izin sama;
   cap timeout tetap), tool baru owner-bound `job_get` / `job_wait` /
   `job_cancel` (sesi lain hanya melihat "Unknown job"), dan completion
   delivery durabel ke inbox sesi via jalur admission prompt biasa
   (`delivery: "queue"`; job yang dibatalkan tidak mengirim catatan).
   Dok kontrak + sisa slice: `specs/v2/background-jobs.md`.
   Bukti: 1117/1117 test `packages/core` hijau; typecheck `packages/core`
   pass (tsgo ~14 detik).

## Yang BELUM selesai (antrian sesi berikutnya, urutan prioritas user)

4. **Interruption/retries durabel + stale-owner fencing** — belum mulai.
   Catatan desain ada di `specs/v2/todo.md` ("add durable/clustered
   interruption, retries, and stale-owner fencing…" dan bagian "Deferred
   durable continuation recovery"). Ini juga mencakup sisa slice fase 3:
   status job durabel + restart recovery (gate 1), observasi HTTP (gate 3),
   dan auto-resume sesi idle saat completion note masuk (sengaja ditahan
   agar tidak menimbulkan siklus layer runner↔tool).
5. **Kecepatan test suite** — `specs/perf/test-suite.md`; belum mulai.

Sisa pinggir lain (bukan prioritas user, tercatat di dokumen fase):

- Adopsi cursor di app/desktop sync (menunggu "New Data Mode").
- Background agent dispatch: `job_*` sudah siap, tapi tool `task`/sub-agent
  V2 belum ada di core — port dulu dari package app.

## Batasan sandbox yang HARUS diketahui sesi berikutnya

- **RAM ~3.9GB, tanpa swap.** `bun run typecheck` di `packages/opencode`
  (root, tsgo penuh) OOM-kill di branch ini; tree baseline saja butuh
  ~701 detik. JANGAN jalankan full-repo typecheck di sandbox ini.
  Bukti kualitas yang dipakai: typecheck `packages/core` + test suite.
- Mode `effect` pada harness httpapi-exercise punya 8 kegagalan
  **pre-existing** (butuh provider/model eksternal) — terverifikasi gagal
  identik di tree baseline; bukan regresi.
- Jangan jalankan pekerjaan berat bersamaan (dua tsgo/test suite sekaligus
  membuat sandbox nyaris lumpuh ±10 menit).
- Sandbox sempat **kehilangan toolchain bun + node_modules** setelah
  restore: instal ulang via `npm install -g bun`, lalu
  `NODE_TLS_REJECT_UNAUTHORIZED=0 bun install` (tarball github
  `ghostty-web` gagal verifikasi TLS tanpa env ini; kegagalan
  `tree-sitter-powershell`/node-gyp bersifat transient — retry saja).
  `bun.lock` sengaja tidak dicommit (mengikuti konvensi sesi awal).
- Jalankan satu proses berat per waktu; total suite core ~31 detik,
  harness httpapi-exercise coverage beberapa menit.

## Cara verifikasi cepat di sesi berikutnya

```bash
cd /home/user/opencode
npm install -g bun 2>/dev/null; NODE_TLS_REJECT_UNAUTHORIZED=0 bun install
cd packages/core && bun test && bun run typecheck      # ~35s + ~14s
cd ../opencode && bun run script/httpapi-exercise.ts --mode coverage \
  --fail-on-missing --fail-on-skip                     # 210 skenario
```
