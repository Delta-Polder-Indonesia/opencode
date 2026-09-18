# Perencanaan Pengembangan Desktop AI IDE

Tanggal rencana: **19 September 2026**.
Status: **perencanaan; implementasi Electron belum dimulai**.

## Tujuan

Mengembangkan fork ini menjadi aplikasi desktop AI IDE yang dapat dibuka dari
ikon aplikasi, tanpa browser terpisah dan tanpa menjalankan server secara manual.
Pengalaman kerja diarahkan menyerupai Arena: explorer, editor, chat AI yang
ringkas, terminal, review perubahan, dan preview dalam satu jendela.
Bukan menyalin seluruh fitur atau tampilan Arena sekaligus.

Pendekatan: gunakan kembali UI, agen AI, terminal, review diff, dan backend yang
sudah ada. Tambahkan kemampuan desktop dan IDE secara bertahap, dengan pengujian
serta kriteria kelulusan sebelum melanjutkan tahap berikutnya.

## Kondisi awal dan batasan

- Audit awal dilakukan melalui pembacaan kode, bukan pengujian aplikasi menyeluruh.
- UI tersedia di `packages/app`, komponen sesi di `packages/session-ui`.
- `packages/app/src/context/platform.tsx` sudah menyediakan kontrak integrasi
  desktop (dialog folder, menu, notifikasi, penyimpanan, updater, dan lainnya).
  Kontrak ini belum berarti implementasi Electron tersedia.
- Paket `packages/desktop` tidak ditemukan pada checkout yang diaudit. Tautan
  desktop upstream dalam README bukan installer untuk fork ini.
- `packages/opencode/script/build.ts` memiliki jalur build binary dan embedding
  UI web; kelayakan bundling sebagai backend desktop harus diuji.
- Terminal, file viewer, review diff, infrastruktur LSP, dan backend background
  job sudah ada. Editor manual lengkap dan integrasi IDE lanjutan masih perlu
  dibangun atau diverifikasi lebih lanjut sebelum implementasi.
- Perubahan folder picker dan thinking ringkas sudah dibuat dalam sesi ini,
  tetapi belum lolos pengujian runtime. Jangan tandai sebagai fitur rilis selesai.
- Pada saat rencana ditulis, Bun dan dependensi belum tersedia di lingkungan
  kerja; typecheck, tes runtime, dan benchmark belum dapat dijalankan.
- Target distribusi awal yang diusulkan: **Windows x64**. Konfirmasikan OS dan
  arsitektur perangkat pengguna sebelum menetapkan konfigurasi installer.
- Aplikasi mandiri tidak berarti seluruh pekerjaan offline. Provider AI cloud
  membutuhkan internet; model lokal membutuhkan konfigurasi dan perangkat yang
  memadai. Proyek pengguna tetap bisa membutuhkan Git, Node.js, Python, compiler,
  atau toolchain lainnya.

## Aturan pengerjaan dan pencatatan

1. Kerjakan satu sub-tahap kecil, lalu periksa hasilnya sebelum memperluas cakupan.
2. Jangan merusak mode web, koneksi server remote, atau fungsi AI yang sudah ada.
3. Ikuti `AGENTS.md` pada paket terkait. Untuk perubahan timeline/session,
   catat baseline benchmark production dan bandingkan setelah perubahan.
4. Checklist hanya dicentang setelah pekerjaan dan verifikasinya benar-benar
   selesai. Jika terhalang lingkungan, tulis **terblokir**, bukan **lulus**.
5. Simpan bukti per tahap: file yang berubah, perintah tes, hasil, kendala,
   keputusan teknis, serta pekerjaan berikutnya.
6. Jangan masukkan token, password, API key, installer besar, atau hasil build
   ke Git. Gunakan penyimpanan artefak rilis untuk distribusi.
7. Jangan menyatakan siap rilis hanya karena jendela Electron berhasil terbuka.

## Tahap 0 — Persiapan dan baseline

- [ ] Konfirmasikan target OS/arsitektur pertama dan kebutuhan penggunaan lokal/remote.
- [ ] Siapkan Bun sesuai versi proyek serta instal dependensi.
- [ ] Jalankan baseline typecheck dan tes paket terkait; pisahkan kegagalan lama
      dari regresi baru.
- [ ] Jalankan aplikasi untuk memverifikasi alur proyek, sesi, terminal, dan diff.
- [ ] Verifikasi perubahan folder picker dan thinking ringkas, termasuk pengguna
      web, desktop lokal, server remote, dan membuka ulang reasoning lama.
- [ ] Catat benchmark production sebelum perubahan session/timeline berikutnya.
- [ ] Pastikan strategi build UI/backend dan kebutuhan aset/native dependency
      dapat dipenuhi pada target Windows.

**Kriteria selesai:** lingkungan pengembangan dapat menjalankan aplikasi dan tes;
status baseline serta kendala terdokumentasi. Jika pengujian Windows belum
tersedia, jangan menganggap build desktop Windows telah tervalidasi.

## Tahap 1 — Aplikasi desktop mandiri dengan Electron

### 1A. Kerangka dan integrasi UI

- [ ] Buat `packages/desktop` dengan main process, preload, renderer entry,
      konfigurasi build, serta script pengembangan.
- [ ] Gunakan kembali UI yang ada melalui `PlatformProvider`; jangan menduplikasi
      seluruh aplikasi dan jangan hanya membungkus situs upstream.
- [ ] Implementasikan dialog folder native, menu dasar, membuka tautan eksternal
      secara aman, dan penyimpanan data aplikasi sesuai lokasi OS.
- [ ] Pastikan proyek remote tetap menggunakan filesystem server, bukan dialog
      folder lokal yang menghasilkan path tidak relevan.

### 1B. Backend otomatis dan lifecycle

- [ ] Bundel backend/runtime yang kompatibel; pengguna tidak perlu memasang Bun
      hanya untuk menjalankan aplikasi desktop.
- [ ] Jalankan backend lokal otomatis dengan port tersedia, pemeriksaan kesehatan,
      batas waktu startup, dan penanganan benturan port.
- [ ] Tampilkan loading, error startup yang dapat dipahami, opsi pemulihan, dan log
      yang tidak membocorkan kredensial.
- [ ] Tentukan perilaku single-instance/multi-window serta kepemilikan proses.
- [ ] Saat aplikasi ditutup, hentikan backend dan proses anak yang dimilikinya
      dengan benar; jangan menghentikan server eksternal milik pengguna.
- [ ] Uji pemulihan setelah crash serta persistensi sesi/proyek setelah dibuka ulang.

### 1C. Keamanan

- [ ] Gunakan `nodeIntegration: false`, `contextIsolation: true`, dan sandbox renderer.
- [ ] Batasi API preload/IPC; validasi pengirim, argumen, path, dan operasi yang diizinkan.
- [ ] Backend desktop lokal bind hanya ke loopback dengan autentikasi; jangan
      membuka layanan eksekusi shell ke LAN secara default.
- [ ] Jangan menaruh token di URL/log; tentukan penyimpanan kredensial aman OS.
- [ ] Batasi navigasi, pembukaan jendela, origin, dan protokol tautan eksternal.
- [ ] Pertahankan pemeriksaan izin agen dan pisahkan konten proyek dari API istimewa.

### 1D. Installer dan penerimaan

- [ ] Pilih tooling packaging (misalnya Electron Builder atau Forge) setelah
      memeriksa kebutuhan native dependency, binary backend, dan lisensinya.
- [ ] Buat installer Windows x64 yang memuat aset UI lokal dan backend.
- [ ] Uji install, launch, pilih proyek, chat, terminal, tutup, buka ulang, dan uninstall
      pada lingkungan Windows yang bersih.
- [ ] Verifikasi path dengan spasi/non-ASCII, folder tidak bisa diakses, provider
      offline, backend gagal start, serta tidak ada proses yatim setelah exit.
- [ ] Dokumentasikan lokasi data, log, cara update awal, dan kebijakan uninstall data.
- [ ] Sebelum distribusi publik, tentukan code signing, asal artefak, serta proses
      rilis. Auto-update dapat menyusul, tetapi wajib tervalidasi bila diaktifkan.

**Kriteria selesai:** pengguna memasang aplikasi, membukanya lewat ikon, memilih
folder, memakai chat AI/terminal/review, lalu menutup dan membuka ulang tanpa
browser terpisah atau menjalankan server manual. Alur tersebut diuji pada target
Windows, bukan hanya dari sandbox Linux.

## Tahap 2 — Editor kode dan pengelolaan file

- [ ] Integrasikan Monaco Editor, sambil mempertahankan viewer diff yang sudah ada.
- [ ] Sediakan tab beberapa file, edit manual, undo/redo, dan simpan `Ctrl+S`.
- [ ] Tambahkan indikator belum tersimpan serta konfirmasi saat tab/aplikasi ditutup.
- [ ] Sediakan aksi membuat file/folder, rename, dan hapus dengan konfirmasi.
- [ ] Sinkronkan perubahan filesystem dengan explorer dan tab terbuka.
- [ ] Deteksi konflik saat AI/program lain mengubah file yang memiliki edit lokal;
      jangan menimpa perubahan pengguna secara diam-diam.
- [ ] Tangani file biner/besar, encoding, line ending, file read-only, dan kegagalan simpan.
- [ ] Pertahankan operasi filesystem melalui backend yang sesuai agar proyek
      remote tidak salah menulis ke komputer lokal.

**Kriteria selesai:** pengguna dapat mengedit dan menyimpan kode langsung,
mengelola file, serta menangani perubahan bersamaan dari AI tanpa kehilangan
perubahan yang belum disimpan.

## Tahap 3 — Alur kerja terpadu seperti Arena

Susunan awal (dapat disesuaikan setelah pengujian penggunaan):

```text
+---------------------------------------------------------------+
| Proyek / Tab / Perintah / Pengaturan                           |
+--------------+----------------------------+-------------------+
| Explorer     | Editor / Diff / Preview    | Chat AI           |
|              |                            | Thinking ringkas  |
|              |                            | Jawaban dan aksi  |
+--------------+----------------------------+                   |
|              | Terminal / Output / Job    |                   |
+--------------+----------------------------+-------------------+
```

- [ ] Buat panel yang dapat diubah ukurannya/disembunyikan dan simpan preferensinya.
- [ ] Pastikan thinking ringkas bisa dibuka, otomatis menutup saat selesai, dan
      dapat dibuka ulang tanpa memenuhi chat secara default.
- [ ] Permudah navigasi dari jawaban AI ke file dan review perubahan.
- [ ] Tambahkan panel background job: daftar, status, output, dan pembatalan,
      dengan batasan otorisasi API yang sudah ada tetap diperhatikan.
- [ ] Tambahkan pengelolaan proses aplikasi pengguna: start/stop, status, output,
      dan deteksi/pemilihan port.
- [ ] Tambahkan live preview web dengan navigasi yang dibatasi dan isolasi dari
      preload/IPC aplikasi utama; konten proyek tidak boleh mendapat akses Node.
- [ ] Sediakan fallback membuka preview eksternal jika embedding ditolak aplikasi.
- [ ] Uji aksesibilitas keyboard, layar kecil, persistensi panel, dan performa sesi panjang.

**Kriteria selesai:** alur meminta AI → memeriksa diff → menjalankan aplikasi →
mengecek preview → menghentikan proses dapat dilakukan dari satu jendela, dengan
fallback jelas bila aplikasi yang dipreview tidak mendukung embedding.

## Tahap 4 — Fitur IDE lanjutan

Kerjakan per fitur, bukan sekaligus:

- [ ] Integrasikan LSP dengan editor: autocomplete, hover, go to definition,
      references, dan rename symbol.
- [ ] Tambahkan panel Problems untuk error/warning yang dapat diklik.
- [ ] Tambahkan pencarian isi proyek dan navigasi hasil; replace lintas file harus
      memiliki preview/konfirmasi dan perlindungan perubahan belum tersimpan.
- [ ] Tambahkan Source Control: status, stage/unstage, commit, pull/push, branch,
      dan alur konflik yang tidak menyembunyikan operasi destruktif.
- [ ] Tambahkan konfigurasi Run serta test explorer untuk toolchain yang dipilih.
- [ ] Terakhir, integrasikan debugger melalui DAP: breakpoint, stepping,
      variabel, dan call stack untuk bahasa/runtime yang didukung.

**Kriteria selesai:** setiap fitur punya cakupan bahasa/runtime yang jelas dan tes
end-to-end. Jangan mengklaim kompatibel seluruh ekstensi VS Code hanya karena
menggunakan Monaco atau Electron.

## Target rilis awal dan langkah berikutnya

**Target rilis awal:** installer Windows → buka aplikasi → pilih folder → chat AI
→ lihat perubahan → gunakan terminal → tutup dan buka kembali dengan aman.
Editor manual masuk tahap berikutnya; Git lengkap, debugger, marketplace ekstensi,
dan dukungan seluruh OS bukan syarat rilis desktop awal.

**Langkah berikutnya:** mulai Tahap 0, konfirmasikan target Windows, pulihkan
lingkungan build/test, lalu implementasikan Tahap 1A. Rencana ini belum merupakan
klaim bahwa Electron, installer, atau fitur IDE baru telah dibuat.

### Format pembaruan progres

Tambahkan entri setelah setiap sub-tahap:

```text
Tanggal:
Tahap/sub-tahap:
Status: belum dimulai / dikerjakan / terblokir / selesai
Perubahan dan file terkait:
Verifikasi (perintah dan hasil):
Kendala/risiko:
Keputusan:
Langkah berikutnya:
```

---

## Arsip catatan teknis sebelumnya

Bagian di bawah dipertahankan sebagai riwayat. Status dan hasil pengujian di
arsip merujuk sesi/commit yang disebutkan, bukan otomatis hasil pengujian rencana
desktop ini.

# Catatan Sesi — Handover Arena

Catatan kerja fork `Delta-Polder-Indonesia/opencode`. Sesi berjalan:
`arena/01a0b0bc-opencode` (item 1–3, PR #3), `arena/01a0b171-opencode`
(item 4a/gate 1, PR #4), `arena/01a0b189-opencode` (item 4a-lanjut/gate 3),
lalu `arena/01a0b19d-opencode` (gate 3 lanjutan: auto-resume inbox),
`arena/01a0b1cd-opencode` (stale-owner fencing), lalu
`arena/01a0b1b6-opencode` (item 4 final review),
`arena/01a0b221-opencode` (audit klaim catatan + rapikan dokumentasi perf),
dan sekarang `arena/01a0b49c-opencode` (dev-safe: deteksi binary opencode
lama + URL hanya tampil setelah server sehat).
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

Laporan nyata dari user (2026-09-18, sesi `arena/01a0b49c-opencode`): setelah
isi password muncul URL `http://localhost:4096`, beberapa detik kemudian error
`Failed to change directory to E:\...\opencode\web --port 4096 --hostname
127.0.0.1` dan jendela tertutup. Penyebabnya: **`opencode` di PATH mesin itu
versi lama / asing** (versi pastinya tidak diketahui) yang tidak mengenal
perintah `web`/`serve`; semua argumen digabung lalu dianggap nama folder
proyek. Pesan "Failed to change directory to" tidak ada di kode fork ini,
jadi binary-nya memang bukan dari versi sekarang. Dua kelemahan script ikut terlihat: URL ditampilkan SEBELUM server
terbukti hidup, dan kode keluar selalu 0 walau server gagal. Perbaikan di
`dev-safe.ps1`:

1. **Pra-cek kemampuan** sebelum tahap password: `<binary> <mode> --help`
   wajib memuat opsi `--hostname`; kalau tidak, script berhenti dengan
   petunjuk jelas (`where.exe opencode`, `npm i -g opencode-ai@latest`,
   alternatif `-FromSource`). Shim `.ps1` dilewati dari pra-cek ini karena
   jebakan `exit` dalam-sesi yang sudah pernah terjadi.
2. **Mode biasa kini menjalankan server sebagai proses anak** (pola yang sama
   dengan jalur `-WithDevUi`), menunggu `/global/health` menjawab 200 sambil
   mendeteksi kematian dini proses, dan BARU menampilkan URL setelah server
   benar-benar sehat. Kode keluar proses server diteruskan (dulu selalu 0).

`dev-safe.tests.ps1` menambah 2 uji regresi (total 11): binary tiruan "lama"
(tanpa `--hostname` di help) harus ditolak sebelum tahap password dengan
petunjuk pembaruan; binary tiruan yang mati dengan `exit /b 3` saat
menjalankan server harus menghasilkan kode keluar 3, pesan "langsung
berhenti", dan tanpa banner "Server siap". `Invoke-DevSafe` kini selalu
meneruskan `-Opencode` supaya pengujian bisa mengganti binary lewat
`$script:Opencode` apa pun mode pemanggilan runner-nya.

CI-nya: `.github/workflows/dev-safe-windows.yml` (job `windows-latest`, dipicu
`workflow_dispatch` dengan input `run_e2e`, atau push yang menyentuh file-file
di atas). Hasil uji tampil sebagai tabel di step summary halaman run, plus
artifact `dev-safe-summary` (14 hari) dan `::error` per kegagalan. Harness-nya
`script/dev-safe.tests.ps1`: 7 uji perilaku memakai server HTTP palsu
(TcpListener: 401 tanpa header Authorization, 200 dengan header) + 1 uji e2e
memakai server opencode sungguhan dari npm. Run pertama yang hijau:
`35341492000`.

Repo kini **publik** (2026-09-18). Konsekuensinya: menit Actions standard-runner
gratis, jadi workflow dipicu juga oleh `pull_request` dan boleh memuat uji e2e
dan uji `-WithDevUi`. Audit isi repo saat menjadi publik: tidak ada kredensial
asli (yang cocok dengan pola rahasia hanya fixture tes, mis. `sk-1234...` dan
`AKIAIOSFODNN7EXAMPLE`); TIDAK ada `.env`/kunci privat/berkas >5MB; commit
trailer `Co-authored-by` adalah artefak hook sandbox, bukan rahasia. Satu
kebocoran nyata dari kerjaan sesi ini: contoh IP LAN pribadi user tertulis di
`script/dev-safe.ps1` (kini `<IP-PC>`) dan ikut tersimpan di blob commit lama,
plus disebut juga di pesan satu commit. **Riwayat branch sudah ditulis ulang**
dengan resep ini:

```bash
printf 'IP-LAMA==><IP-PC>\n' > /tmp/rep.txt
git filter-repo --refs 'main..arena/01a0b41d-opencode' \
  --replace-text /tmp/rep.txt --replace-message /tmp/rep.txt
```

Pelajaran penting (mahal, sudah dibuktikan dua kali di sesi ini):

- **Rentang `--refs main..<branch>` itu wajib.** Tanpa itu filter-repo menulis
  ulang SELURUH riwayat — ribuan commit upstream ikut berhash baru, `main`
  bergeser (`9521ccf` → hash lain), merge-base dengan `main` di GitHub hilang,
  dan PR akan terlihat seperti menambahkan seluruh isi repo. Riwayat upstream
  yang sudah publik memang tidak boleh ditulis ulang; jangan pernah
  mem-force-push `main`.
- Dengan rentang itu: `main` tetap `9521ccf`, merge-base utuh, hanya commit
  branch yang berubah.
- Verifikasi setelah rewrite: `git merge-base main HEAD` == `9521ccf`,
  `git log --all -S '<IP-LAMA>'` kosong, `git log --all --format=%s%n%b | grep -c <IP>`
  = 0, dan **`git rev-parse HEAD^{tree}` sama dengan sebelum rewrite** (isi
  berkas tidak berubah, hanya riwayat).
- Konsekuensi: semua SHA commit branch berubah → force-push dengan
  `--force-with-lease`; siapa pun yang sudah clone branch ini harus fetch ulang.
- `git bundle create` untuk backup bisa bersifat *thin* (menyimpan
  prerequisites) sehingga tidak bisa di-fetch ulang kalau objek aslinya sudah
  dipangkas — simpan salinan direktori repo atau biarkan remote sebagai sumber
  pemulihan.

Belum aktif dan sebaiknya dinyalakan di Settings: Dependabot alerts
(terkonfirmasi mati) dan secret protection/push protection.

Tiga jebakan PowerShell yang ditemukan di sesi ini (semuanya terbukti lewat CI,
bukan lewat pembacaan kode):

1. **`$error` variabel otomatis read-only.** `foreach ($error in $parseErrors)`
   membuat step CI mati tanpa sempat melaporkan error apa pun. Sekarang ada step
   yang menolak `$error/$true/$false/$host/$input/$args` sebagai variabel loop.
2. **`"$var:"` di dalam string adalah parse error** ("`:` was not followed by a
   valid variable name character"). Pakai `${var}:`. Ditemukan di baris 424
   `dev-safe.tests.ps1` dan pada `-u $User:PASSWORD` di `dev-safe.ps1`.
3. **PowerShell meratakan array satu elemen** yang dikembalikan fungsi menjadi
   string, sehingga `$x[0]` mengambil **huruf pertama** isi string ('D' dari
   `D:\...`). Ini membuat `-WithDevUi` gagal untuk semua pengguna Windows.
   `Resolve-ViteCommand` kini mengembalikan objek `{ File, Args }`.

**Temuan penting dari CI (tidak terlihat dari pembacaan kode):** di runner
Windows, `Get-Command opencode` mengembalikan shim **`.ps1`** dari npm
(`C:\npm\prefix\opencode.ps1`), bukan `.cmd`/`.exe`. Shim `.ps1` berjalan di
dalam sesi PowerShell pemanggil dan diakhiri `exit`, sehingga `dev-safe.ps1`
langsung berhenti (exit 0) dan server tidak pernah hidup. `dev-safe.ps1`
sekarang memilih `.exe`/`.cmd` lebih dulu lewat `Get-Command -All`; shim
`curl.exe` juga diberi `--max-time`. Pelajaran umum: untuk shim npm di Windows,
jangan pakai hasil `Get-Command` pertama begitu saja.

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
