# Catatan Sesi — Handover Arena

Catatan kerja fork `Delta-Polder-Indonesia/opencode`. Sesi berjalan:
`arena/01a0b0bc-opencode` (item 1–3, PR #3), `arena/01a0b171-opencode`
(item 4a/gate 1, PR #4), `arena/01a0b189-opencode` (item 4a-lanjut/gate 3),
`arena/01a0b19d-opencode` (gate 3 lanjutan: auto-resume inbox),
lalu `arena/01a0b1cd-opencode` (stale-owner fencing).
Ditulis ulang 2026-09-18 setelah slice fencing selesai.
Rencana induk: 5 perbaikan prioritas yang disepakati user (lihat
`specs/v2/todo.md` dan dokumen per-fase di `specs/v2/`).

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
3. **BackgroundJob ↔ eksekusi tool V2 (gate 2)** — commit `4e8866d`.
   `bash` kini punya `background: true` (tidak memblokir turn; izin sama;
   cap timeout tetap), tool baru owner-bound `job_get` / `job_wait` /
   `job_cancel` (sesi lain hanya melihat "Unknown job"), dan completion
   delivery durabel ke inbox sesi via jalur admission prompt biasa
   (`delivery: "queue"`; job yang dibatalkan tidak mengirim catatan).
4. **Status job durabel + restart recovery (gate 1)** — commit `29d4537`.
   Tabel `background_job` (migrasi `20260917222554_background_job_status`)
   ditulis MENGELILINGI registry process-local; `JobTool.launch` insert
   baris `running` setelah start sukses; watcher men-settle baris SEBELUM
   admit catatan; persistence best-effort; recovery boot node `tool/job`
   mengklaim atomik baris `running` milik runtime asing menjadi
   `interrupted` + catatan inbox; tool `job_*` fallback ke baris durabel.
   Status `interrupted` hanya dari recovery. `runtime_id` marker, bukan
   fence. Dok: `specs/v2/background-jobs.md` (gate 1+2).
5. **Observasi HTTP job V2 (gate 3)** — branch `arena/01a0b189-opencode`.
   Keputusan otorisasi kini TERTULIS EKSPLISIT di
   `specs/v2/background-jobs.md` ("Authorization decision (explicit)"):
   observasi HTTP itu **instance-wide**, mengikuti preseden V1 (handler
   `experimental` melihat semua job instance); owner-hiding tetap
   **hanya model-facing** (`job_*` tools) karena seluruh surface V2 sudah
   membeberkan isi sesi ke konsumen terautentikasi — duplikasi di HTTP
   hanya konsistensi-palsu. Permukaannya read-only:
   - `GET /api/job` (`v2.job.list`; query `sessionID`/`status`/`limit`,
     default 50) dan `GET /api/job/:jobID` (`v2.job.get`, 404
     `JobNotFoundError`) — group baru `server.job` di `packages/protocol`
     (`groups/background-job.ts`), handler `packages/server/src/handlers/
background-job.ts` yang hanya butuh `Database.Service`.
   - Sumber kebenaran = **baris durabel saja**; registry process-local
     sengaja tidak dikonsultasi (registry itu per-Location; baris maknanya
     sama dari proses mana pun, lintas restart). Konsekuensinya
     terdokumentasi: job yang persist-nya gagal tak terlihat remote;
     settle yang belum ter-persist sempat terbaca `running`; output selalu
     tail 16KB. Mutasi (cancel via API) sengaja ditunda sampai fencing.
   - Store: `BackgroundJobStore.list(db, {sessionID?, status?, limit?})`
     newest-first (`started_at` desc, `id` desc); `fromRow` kini membawa
     `session_id` (field opsional baru di `BackgroundJob.Info` — jalur
     model-facing tidak berubah karena `infoOutput` sudah whitelist).
   - SDK regen (`packages/sdk/js` → `openapi.json` + `src/v2/gen/*`).
   - Harness: helper seed `ctx.jobs([...])` baru (`types.ts`/`runtime.ts`/
     `runner.ts`) + 4 skenario (`v2.job.list`, `v2.job.list.session-filter`,
     `v2.job.get`, `v2.job.get.missing`). Lock-test TODO di
     `tool-bash.test.ts` diperbarui sadar: entri gate job dihapus karena
     sudah selesai.

6. **Auto-resume inbox saat completion job** — branch
   `arena/01a0b19d-opencode`. Catatan completion live kini diadmit sebagai
   `steer` (drain aktif mempromosikannya di batas provider-turn berikutnya,
   bukan menunggu drain nganggur) dan memicu wake advisory process-local
   lewat hub `SessionWake` (`packages/core/src/session/wake.ts`) yang
   di-subscribe `SessionExecutionLocal` di root; tool layer tidak lagi
   (dan tidak boleh) bergantung pada `SessionExecution` karena itu menutup
   siklus layer runner → tool registry → bash → execution → runner.
   Recovery saat boot tetap `queue` TANPA wake (proses yang baru boot tidak
   menjadwalkan kerja provider; startup discovery tetap di slice recovery).
   Hub adalah global node biasa: satu instance per proses, dibagi ke
   location tree karena node eksekusi juga bergantung padanya (diuji di
   `session-wake.test.ts`, termasuk kontrol location-only tetap
   per-Location). Wake bersifat advisory: tidak pernah me-retry provider
   attempt yang ambigu. Dok: `specs/v2/background-jobs.md` +
   `specs/v2/session.md` + entri done di `specs/v2/todo.md`.

7. **Stale-owner fencing / clustered execution** — branch
   `arena/01a0b1cd-opencode`. Tabel lease `runtime_fence` (migrasi
   `20260918000000_runtime_fence`) melacak liveness proses via heartbeat
   periodik (interval 10 detik, TTL 30 detik). Service `RuntimeFence`
   (global node, depends on `Database`) mengklaim baris fence secara atomik
   saat boot; fiber heartbeat memperbarui baris setiap 10 detik; finalizer
   melepaskan baris saat shutdown bersih; crash membiarkan baris kedaluwarsa
   secara natural. Recovery `JobTool` kini hanya mengklaim baris `running`
   milik runtime yang fence-nya sudah kedaluwarsa ATAU tidak punya baris
   fence sama sekali (pra-migrasi / shutdown bersih). `JobTool.node`
   depends on `RuntimeFence.node` sehingga fence selalu diklaim sebelum
   recovery berjalan. Verifikasi: core 1140/1140 (baseline 1128 + 12 tes
   fence), typecheck core bersih, httpapi-exercise 214/214 + auth 214/214.
   Dok: `specs/v2/background-jobs.md` (section "Stale-owner fencing") +
   `specs/v2/todo.md` (entri done). HTTP mutation (cancel via API) kini
   tidak diblokir oleh fencing.

8. **Kecepatan test suite core** — branch `arena/01a0b1e7-opencode`.
   Profil + optimasi tanpa spek formal (keputusan user). Wall clock
   `bun test` di `packages/core`: **38.8s → ~26.5s** (1140 tes, 0 gagal).
   Temuan: ~22s dari 38s terkonsentrasi di ±15 tes; penyebab utama
   adalah boot subprocess pada tes flock (16 proses bun × ~570ms di 2 core).
   Perubahan (semua di sisi tes/script, tanpa perubahan runtime):
   - `test/fixture/effect-flock-worker.ts`: pakai `LayerNode.compile`
     langsung, bukan `AppNodeBuilder.build` (yang menarik seluruh graf
     location-services) → boot worker 570ms → 270ms.
   - Tes contention flock/effect-flock: 16 → 8 worker; tes `util.flock`
     memakai `baseDelayMs`/`maxDelayMs` ketat dan `staleMs` lebih kecil
     di tes yang menguji pemulihan, bukan pacing retry.
     `effect-flock.test.ts` 9.5s → 3.3s; `flock.test.ts` 5.7s → 2.2s.
   - `script/migration.ts --check`: dua run drizzle-kit (diff incremental
     + dump full schema) independen, kini dijalankan paralel → 3.4s → 2.0s.
   Sisa yang sengaja TIDAK diubah: `WebFetchTool` "conversion throws"
   (1.4s — butuh stack overflow nyata via turndown, bergantung kedalaman),
   `ModelsDev` "swallows HTTP errors" (0.7s — backoff nyata `retryTransient`
   200ms+340ms; butuh jadwal retry injectable untuk dipercepat), tiga tes
   negatif `Watcher` (masing-masing 500ms `noUpdate`), dan fast-check
   `Config` v1→v2 (100 run, 0.6s).

## Yang BELUM selesai (antrian sesi berikutnya, urutan prioritas user)

4-lanjut. **Sisa item #4** — urutannya:
a. **Durable continuation recovery** (bagian "Deferred durable
continuation recovery" di `todo.md`) — auto-resume inbox sudah DONE
(arena/01a0b19d, lihat #6). Yang tersisa dari slice ini: policy pemulihan
penuh — provider-attempt preparation vs dispatch ambiguity, keputusan
eksplisit `retry`/`abandon`, bounded automatic retry, budget/backoff,
status pemulihan yang terlihat, dan startup discovery.
b. **Stale-owner fencing / clustered execution** — DONE (lihat #7).
c. **Kecepatan test suite** — DONE tahap pertama (lihat #8; 38.8s → ~26.5s).
Kandidat lanjutan bila diperlukan: jadwal retry injectable di `ModelsDev`,
`noUpdate` watcher lebih pendek. 5. Pinggir lain (bukan prioritas user, tercatat di dokumen fase): adopsi
cursor di app/desktop sync (menunggu "New Data Mode"); background agent
dispatch (`job_*` dispatch-ready, tapi tool `task`/sub-agent V2 belum ada
di core — port dulu dari package app).

## Batasan sandbox yang HARUS diketahui sesi berikutnya

- **RAM ~3.9GB, tanpa swap.** `bun run typecheck` di `packages/opencode`
  (root, tsgo penuh) OOM-kill di branch ini; tree baseline saja butuh
  ~701 detik. JANGAN jalankan full-repo typecheck di sandbox ini.
  Bukti kualitas yang dipakai: typecheck `packages/core` + `packages/
protocol` + `packages/server` + `packages/sdk/js`, test suite, dan
  httpapi-exercise.
- Mode `effect` pada harness httpapi-exercise punya 8 kegagalan
  **pre-existing** (butuh provider/model eksternal) — terverifikasi gagal
  identik di tree baseline; bukan regresi. (Mode coverage hijau penuh.)
- Jangan jalankan pekerjaan berat bersamaan (dua tsgo/test suite sekaligus
  membuat sandbox nyaris lumpuh ±10 menit).
- Sandbox bisa **kehilangan toolchain bun + node_modules** antar sesi:
  instal ulang via `npm install -g bun`, lalu
  `NODE_TLS_REJECT_UNAUTHORIZED=0 bun install` (tarball github
  `ghostty-web` gagal verifikasi TLS tanpa env ini; kegagalan
  `tree-sitter-powershell`/node-gyp bersifat transient — retry saja;
  run pertama biasanya sudah meng-extract semua paket, retry cepat).
  `bun.lock` sengaja tidak dicommit (mengikuti konvensi sesi awal).
- `bun dev generate` (dipakai regen SDK) menulis `packages/opencode/
config.json` sebagai efek samping — hapus, jangan dicommit.
- Jalankan satu proses berat per waktu; total suite core ~35 detik,
  harness httpapi-exercise coverage ~3 detik di luar build.

## Cara verifikasi cepat di sesi berikutnya

```bash
cd /home/user/opencode
npm install -g bun 2>/dev/null; NODE_TLS_REJECT_UNAUTHORIZED=0 bun install
cd packages/core && bun test && bun run typecheck      # ~27s + ~10s
cd ../opencode && bun run script/httpapi-exercise.ts --mode coverage \
  --fail-on-missing --fail-on-skip                     # 214 skenario
```
