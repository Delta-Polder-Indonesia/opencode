# Catatan Sesi — Handover Arena

Catatan kerja fork `Delta-Polder-Indonesia/opencode`. Sesi berjalan:
`arena/01a0b0bc-opencode` (item 1–3, PR #3) lalu `arena/01a0b171-opencode`
(item 4a/gate 1, PR sesuai branch). Ditulis ulang 2026-09-17 setelah slice
gate 1 selesai. Rencana induk: 5 perbaikan prioritas yang disepakati user
(lihat `specs/v2/todo.md` dan dokumen per-fase di `specs/v2/`).

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
3. **BackgroundJob ↔ eksekusi tool V2 (gate 2)** — commit `4e8866d`.
   `bash` kini punya `background: true` (tidak memblokir turn; izin sama;
   cap timeout tetap), tool baru owner-bound `job_get` / `job_wait` /
   `job_cancel` (sesi lain hanya melihat "Unknown job"), dan completion
   delivery durabel ke inbox sesi via jalur admission prompt biasa
   (`delivery: "queue"`; job yang dibatalkan tidak mengirim catatan).
4. **Status job durabel + restart recovery (gate 1)** — branch
   `arena/01a0b171-opencode`. Tabel `background_job` (migrasi
   `20260917222554_background_job_status`) ditulis MENGELILINGI registry
   process-local — registry tetap in-memory, durability dilapiskan di
   `background-job/store.ts`. `JobTool.launch` insert baris `running`
   setelah start sukses; watcher men-settle baris SEBELUM admit catatan
   (crash di antaranya pulih sebagai `interrupted`, outcome unknown —
   jujur). Persistence best-effort: kegagalan DB tidak pernah memblokir /
   menyembunyikan job hidup. Tiap proses punya `runtime_id`; recovery jalan
   saat boot node `tool/job`, mengklaim atomik (UPDATE…RETURNING terpaga)
   baris `running` milik runtime asing menjadi `interrupted` + mengirim
   catatan inbox ke sesi owner yang masih ada; baris runtime sendiri &
   settled tidak disentuh (idempoten lintas rebuild Location). Tool `job_*`
   fallback ke baris durabel setelah registry hilang; owner-hiding tetap
   berlaku untuk baris persisten. Status baru `interrupted` hanya diproduksi
   recovery. Asumsi satu-runtime-per-database terdokumentasi; `runtime_id`
   marker, BUKAN fence.
   Dok kontrak: `specs/v2/background-jobs.md` (gate 1 + gate 2).
   Bukti slice ini: 1123/1123 test `packages/core` hijau (6 skenario baru:
   launch/settle persisten + bounded tail 16KB, cancel persisten, klaim
   recovery + catatan, row runtime-sendiri/settled tak tersentuh, sesi
   terhapus tanpa catatan, tool membaca baris persisten + owner hiding);
   typecheck `packages/core` pass; httpapi-exercise 210/210 tetap hijau.

## Yang BELUM selesai (antrian sesi berikutnya, urutan prioritas user)

4-lanjut. **Sisa item #4** — urutannya:
   a. **Gate 3: observasi HTTP job V2.** Prekursor teknis sudah ada
      (status durabel + recovery). Keputusan desain terbuka: otorisasi —
      usulan awal mengikuti preseden V1 (handler `experimental` melihat
      semua job instance; owner-hiding hanya untuk lapisan model-facing),
      tapi harus ditulis eksplisit dulu di `specs/v2/background-jobs.md`.
      Butuh: route + handler + SDK regen + skenario httpapi-exercise baru.
   b. **Durable continuation recovery** (bagian "Deferred durable
      continuation recovery" di `todo.md`) — termasuk auto-resume sesi idle
      saat catatan completion masuk (sengaja ditahan: mencegah siklus layer
      runner↔tool) dan steer-ke-sesi-aktif.
   c. **Stale-owner fencing / clustered execution** — lease/heartbeat di
      atas `runtime_id`; terkait interruption/retries terkluster di todo.
5. **Kecepatan test suite** — `specs/perf/test-suite.md`; belum mulai.

Sisa pinggir lain (bukan prioritas user, tercatat di dokumen fase):

- Adopsi cursor di app/desktop sync (menunggu "New Data Mode").
- Background agent dispatch: `job_*` sudah dispatch-ready, tapi tool
  `task`/sub-agent V2 belum ada di core — port dulu dari package app.

## Batasan sandbox yang HARUS diketahui sesi berikutnya

- **RAM ~3.9GB, tanpa swap.** `bun run typecheck` di `packages/opencode`
  (root, tsgo penuh) OOM-kill di branch ini; tree baseline saja butuh
  ~701 detik. JANGAN jalankan full-repo typecheck di sandbox ini.
  Bukti kualitas yang dipakai: typecheck `packages/core` + test suite +
  httpapi-exercise.
- Mode `effect` pada harness httpapi-exercise punya 8 kegagalan
  **pre-existing** (butuh provider/model eksternal) — terverifikasi gagal
  identik di tree baseline; bukan regresi. (Mode coverage 210 skenario
  hijau penuh.)
- Jangan jalankan pekerjaan berat bersamaan (dua tsgo/test suite sekaligus
  membuat sandbox nyaris lumpuh ±10 menit).
- Sandbox bisa **kehilangan toolchain bun + node_modules** antar sesi:
  instal ulang via `npm install -g bun`, lalu
  `NODE_TLS_REJECT_UNAUTHORIZED=0 bun install` (tarball github
  `ghostty-web` gagal verifikasi TLS tanpa env ini; kegagalan
  `tree-sitter-powershell`/node-gyp bersifat transient — retry saja).
  `bun.lock` sengaja tidak dicommit (mengikuti konvensi sesi awal).
- Jalankan satu proses berat per waktu; total suite core ~37 detik,
  harness httpapi-exercise coverage ~3 detik di luar build.

## Cara verifikasi cepat di sesi berikutnya

```bash
cd /home/user/opencode
npm install -g bun 2>/dev/null; NODE_TLS_REJECT_UNAUTHORIZED=0 bun install
cd packages/core && bun test && bun run typecheck      # ~37s + ~12s
cd ../opencode && bun run script/httpapi-exercise.ts --mode coverage \
  --fail-on-missing --fail-on-skip                     # 210 skenario
```
