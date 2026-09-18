# Catatan Sesi — Handover Arena

Catatan kerja fork `Delta-Polder-Indonesia/opencode`. Sesi berjalan:
`arena/01a0b0bc-opencode` (item 1–3, PR #3), `arena/01a0b171-opencode`
(item 4a/gate 1, PR #4), `arena/01a0b189-opencode` (item 4a-lanjut/gate 3),
lalu `arena/01a0b19d-opencode` (gate 3 lanjutan: auto-resume inbox),
`arena/01a0b1cd-opencode` (stale-owner fencing), lalu
`arena/01a0b1b6-opencode` (item 4 final review), dan sekarang
`arena/01a0b221-opencode` (audit klaim catatan + rapikan dokumentasi perf).
Ditulis ulang 2026-09-18 setelah slice item 4 selesai.

Hasil audit `arena/01a0b221-opencode` (2026-09-18): seluruh 8 item di bawah
terverifikasi ADA dan gate-nya dijalankan ulang di HEAD `9c3ad825c` —
core `1148 pass / 0 fail`, typecheck `core`+`protocol`+`server`+`sdk/js` bersih,
harness coverage `220/220`, harness effect `212 pass / 8 fail` tanpa katalog
model dan **`220/220`** dengan `OPENCODE_MODELS_PATH`.

Dua klaim dokumentasi ternyata keliru dan sudah diperbaiki:

- **Item 8** menunjuk file perf yang salah (lihat koreksi di item 8).
- **8 kegagalan mode `effect`** bukan "butuh provider/model eksternal" dan bukan
  kondisi yang tak terhindarkan. Penyebab tunggalnya: sandbox tidak bisa
  menjangkau `https://models.opencode.ai`. Sediakan katalog lokal dan
  semuanya lolos — lihat koreksi di "Verifikasi final item 4" dan di bagian
  batasan sandbox.

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
   hanya konsistensi-palsu. Permukaannya semula read-only:
   - `GET /api/job` (`v2.job.list`; query `sessionID`/`status`/`limit`,
     default 50) dan `GET /api/job/:jobID` (`v2.job.get`, 404
     `JobNotFoundError`) — group baru `server.job` di `packages/protocol`
     (`groups/background-job.ts`), handler `packages/server/src/handlers/
background-job.ts` yang hanya butuh `Database.Service`. Item 4 kemudian
     menambahkan `POST /api/job/:jobID/cancel` yang lease-fenced.
   - Sumber kebenaran = **baris durabel saja**; registry process-local
     sengaja tidak dikonsultasi (registry itu per-Location; baris maknanya
     sama dari proses mana pun, lintas restart). Konsekuensinya
     terdokumentasi: job yang persist-nya gagal tak terlihat remote;
     settle yang belum ter-persist sempat terbaca `running`; output selalu
     tail 16KB.
   - Store: `BackgroundJobStore.list(db, {sessionID?, status?, limit?})`
     newest-first (`started_at` desc, `id` desc); `fromRow` kini membawa
     `session_id` (field opsional baru di `BackgroundJob.Info` — jalur
     model-facing tidak berubah karena `infoOutput` sudah whitelist).
   - SDK regen (`packages/sdk/js` → `openapi.json` + `src/v2/gen/*`).
   - Harness: helper seed `ctx.jobs([...])` baru (didefinisikan di
     `test/server/httpapi-exercise/` — `types.ts`/`runtime.ts`/`runner.ts`;
     skenarionya sendiri di `index.ts`). Slice gate 3 menambah 4 skenario
     (`v2.job.list`, `v2.job.list.session-filter`, `v2.job.get`,
     `v2.job.get.missing`); item 4 menyusul menambah 2 skenario cancel
     (`v2.job.cancel`, `v2.job.cancel.stale-owner`), sehingga totalnya 6.
     Lock-test TODO di
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

7. **Stale-owner fencing / clustered execution** — diwarisi dari branch
   `arena/01a0b1cd-opencode` dan dipertahankan dalam integrasi final. Tabel
   `runtime_fence` melacak liveness proses lewat heartbeat global (interval
   10 detik, TTL 30 detik); service `RuntimeFence` mengklaim dan melepaskan
   fence saat boot/shutdown. Recovery tetap memakai lease dan fence per job,
   sehingga `runtime_id` saja tidak pernah menjadi bukti kepemilikan.
8. **Kecepatan test suite core** — diwarisi dari branch
   `arena/01a0b1e7-opencode` dan dipertahankan dalam integrasi final. Optimasi
   test/script menurunkan wall clock sekitar `38.8s` menjadi `~26.5s`
   (1140 test, 0 gagal); perubahan hanya pada fixture, contention tests, dan
   migration check paralelisasi. Temuan dan batasannya dicatat di
   **`perf/core-test-suite.md`**.
   Koreksi (audit 2026-09-18): entri ini semula menunjuk `perf/test-suite.md`,
   yang salah — file itu cakupannya `packages/opencode/test/**` dan tidak
   pernah membahas core. Baseline `38.8s` / `1140` juga tidak tercatat di
   file markdown mana pun; satu-satunya sumbernya adalah pesan commit
   `5ee4b25f3`. Keduanya kini tertulis di `perf/core-test-suite.md` beserta
   pengukuran ulang di HEAD `9c3ad825c`: **26.95s, 1148 pass, 0 fail**
   (8 test tambahan muncul setelah optimasi mendarat).

## Status item #4 dan pinggiran

4a/4b **selesai di branch ini**. `SessionProviderAttemptTable` membedakan
`prepared` dari `dispatched`, startup discovery hanya menandai state dan tidak
memanggil provider, prepared-only loss mendapat satu safe retry setelah
backoff, ambiguous dispatch tetap `decision_required`, dan retry/abandon
memerlukan kontrol eksplisit dengan budget terbatas. `SessionExecutionLeaseTable`
dan heartbeat provider memakai monotonic `fence`; `runtime_id` hanya marker.
Global `runtime_fence` heartbeat menambah deteksi liveness proses, tetapi tidak
menggantikan fence per-row. HTTP cancel kini menunggu keputusan lease: live owner mendapat
`cancel_requested_at`, expired owner difence sebagai `interrupted` dengan
`stale_owner=true`. Kontrak: `specs/v2/session-recovery.md` dan
`specs/v2/background-jobs.md`.

4c **sudah ada dan diverifikasi** di `specs/perf/test-suite.md`, dengan
riwayat pengukuran di `perf/test-suite.md`: benchmark full-suite satu run,
profiler per-file sequential, metric output, hypothesis loop, dan dead ends.

Pinggiran (bukan prioritas item #4): adopsi cursor di app/desktop sync
(menunggu "New Data Mode"); background agent dispatch (`job_*`
dispatch-ready, tetapi tool `task`/sub-agent V2 belum ada di core — port dulu
dari package app).

## Verifikasi final item 4 (2026-09-18)

- Targeted core recovery/background-job tests: `21 pass`, `0 fail`, `90 expect()`;
  scoped typechecks for `protocol`, `core`, `server`, and `sdk/js` pass sequentially.
- HTTP coverage and auth gates: masing-masing `selected=220`, `pass=220`,
  `fail=0`, `skip=0`, `missing=0`, `extra=0`.
- Accepted full benchmark remains the one-run `304.404s` result recorded in
  `perf/test-suite.md`. The latest scoped server profile (`49` files, sequential) is recorded in
  `perf/test-suite.md`: slowest `test/server/httpapi-session.test.ts` at
  `12.944s` (`METRIC slowest_test_file_seconds=12.944`).
- Effect route execution: without a reachable models catalog the run is
  `212 pass`, `8 fail`, `0 skip`, `missing=0`, `extra=0`. The eight failures are
  `config.providers`, `provider.list`, `v2.session.permission.create`,
  `session.init`, `session.prompt`, `session.prompt_async`, `session.command`,
  and `session.summarize`.
  **Koreksi (audit 2026-09-18):** entri ini semula menyebut kedelapannya
  "require provider/model-backed or legacy route behavior". Itu salah. Penyebab
  tunggalnya adalah sandbox tidak bisa menjangkau
  `https://models.opencode.ai/api.json`. Enam di antaranya 500 dengan
  `HttpClientError: Transport error (GET https://models.opencode.ai/api.json)`
  (dibuktikan dengan membocorkan `Cause.pretty` lewat middleware error sementara);
  `session.prompt_async` menggantung >150 detik pada dependensi yang sama; dan
  `v2.session.permission.create` menjawab `effect: "deny"` karena resolusi agent
  gagal tanpa katalog, sehingga jatuh ke `missingAgentPermissions`
  (`packages/core/src/permission.ts:144`).
  Dengan katalog lokal, **kedelapannya lolos**:

  ```sh
  cd packages/opencode
  OPENCODE_MODELS_PATH=test/tool/fixtures/models-api.json \
    bun run script/httpapi-exercise.ts --mode effect
  # summary pass=220 fail=0 skip=0 missing=0 extra=0  (147s)
  ```

  Fixture itu snapshot `api.json` asli (4.9MB, 159 provider) yang sudah ada di
  tree. Urutan load `ModelsDev.populate` adalah disk → snapshot → fetch
  (`packages/core/src/models-dev.ts:184`), jadi `OPENCODE_MODELS_PATH`
  menghilangkan fetch sama sekali.
- Repository-wide `bun run lint` still exits on a pre-existing octal-literal
  error in `packages/session-ui/src/v2/components/prompt-input/index.tsx`;
  changed-file lint had no errors (only existing warnings).
- Generated `packages/opencode/config.json` was removed; `openapi.json` and
  `bun.lock` remain uncommitted per the standing constraints.

## Alat bantu dev Windows (sesi `arena/01a0b41d-opencode`, 2026-09-18)

Bukan bagian dari 5 item prioritas — ini kebutuhan operasional pemakaian
sehari-hari (`opencode web` / `serve`) di Windows:

- `script/dev-safe.ps1` — runner PowerShell. Selalu meminta
  `OPENCODE_SERVER_PASSWORD` (prompt tanpa echo, tidak masuk riwayat),
  membind `127.0.0.1` kecuali `-AllowLan`, membersihkan env var setelah
  server berhenti, dan punya `-Verify` (mode periksa: apakah port
  mendengarkan di `0.0.0.0` dan apakah autentikasi aktif / `401`).
  Opsi baru: `-WithDevUi` (+ `-DevUiPort`, default 3000) menjalankan server
  di belakang lalu Vite dev UI di `127.0.0.1` (menimpa `host: "0.0.0.0"`
  di `packages/app/vite.config.ts`), dan `-FromSource` untuk menjalankan
  checkout ini lewat `bun`.
- `script/dev-safe.cmd` — pembungkus klik-dua-kali untuk script di atas.

Temuan yang perlu diketahui: `opencode attach <url>` (dan `run`) **belum ada**
di fork ini — `packages/opencode/src/cli/cmd/` tidak punya `attach.ts`,
sementara upstream `anomalyco/opencode` punya. Halaman docs
`opencode.ai/docs/web/` bagian "Attaching a Terminal" karena itu tidak
berlaku di fork ini. Bagian lain halaman itu (port/hostname/mdns/cors/
password) sudah terverifikasi cocok, dengan satu detail tak terdokumentasi:
mDNS hanya memaksa hostname `0.0.0.0` kalau `server.hostname` di config
tidak diisi.

## Batasan sandbox yang HARUS diketahui sesi berikutnya

- **RAM ~3.9GB, tanpa swap.** `bun run typecheck` di `packages/opencode`
  (root, tsgo penuh) OOM-kill di branch ini; tree baseline saja butuh
  ~701 detik. JANGAN jalankan full-repo typecheck di sandbox ini.
  Bukti kualitas yang dipakai: typecheck `packages/core` + `packages/
protocol` + `packages/server` + `packages/sdk/js`, test suite, dan
  httpapi-exercise.
- Mode `effect` pada harness httpapi-exercise **bisa hijau penuh** di sandbox
  ini, asal katalog model disediakan lokal. Kegagalan `212 pass / 8 fail` yang
  sebelumnya dianggap "pre-existing / butuh provider eksternal" sebenarnya
  akibat egress sandbox yang memblokir `https://models.opencode.ai`
  (`curl` gagal `SSL_ERROR_SYSCALL` bahkan dengan `-k`, jadi bukan soal
  sertifikat). Solusinya:
  `OPENCODE_MODELS_PATH=test/tool/fixtures/models-api.json` → `220/220 pass`.
  Jangan warisi asumsi lama bahwa delapan kegagalan itu tak terhindarkan.
  (Mode coverage hijau penuh dengan atau tanpa env ini.)
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
cd packages/core && bun test && bun run typecheck      # ~35s + ~10s
cd ../opencode && bun run script/httpapi-exercise.ts --mode coverage \
  --fail-on-missing --fail-on-skip                     # 220 skenario
```
