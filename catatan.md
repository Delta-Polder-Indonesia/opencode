# Perencanaan Pengembangan Desktop AI IDE

Tanggal rencana: **19 September 2026**.
Status: **Tahap 0 sebagian selesai; Tahap 1A dan 1B terimplementasi (backend
terverifikasi terhadap server nyata, integrasi Electron runtime belum
tervalidasi); Tahap 1D belum dimulai**. Lihat bagian [Progres](#progres) untuk
bukti per tahap.

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
  **Pembaruan 2026-09-18:** `packages/desktop` kini ada (Tahap 1A). Installer
  masih belum dibuat.
- `packages/opencode/script/build.ts` memiliki jalur build binary dan embedding
  UI web; kelayakan bundling sebagai backend desktop harus diuji.
- Terminal, file viewer, review diff, infrastruktur LSP, dan backend background
  job sudah ada. Editor manual lengkap dan integrasi IDE lanjutan masih perlu
  dibangun atau diverifikasi lebih lanjut sebelum implementasi.
- Perubahan folder picker dan thinking ringkas sudah dibuat dalam sesi ini,
  tetapi belum lolos pengujian runtime. Jangan tandai sebagai fitur rilis selesai.
- Pada saat rencana ditulis, Bun dan dependensi belum tersedia di lingkungan
  kerja; typecheck, tes runtime, dan benchmark belum dapat dijalankan.
  **Pembaruan 2026-09-18:** Bun 1.3.14 dan dependensi sudah terpasang; typecheck
  serta tes unit berjalan. Runtime aplikasi dan benchmark masih terblokir.
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

- [x] Konfirmasikan target OS/arsitektur pertama dan kebutuhan penggunaan lokal/remote.
      Target tetap **Windows x64**; koneksi lokal memakai backend loopback, koneksi
      remote tetap lewat alur server yang sudah ada.
- [x] Siapkan Bun sesuai versi proyek serta instal dependensi.
      Bun `1.3.14` (sesuai `packageManager`) dipasang lewat npm karena `bun.sh`
      diblokir di sandbox; `bun install` perlu `NODE_EXTRA_CA_CERTS`.
- [x] Jalankan baseline typecheck dan tes paket terkait; pisahkan kegagalan lama
      dari regresi baru. Rincian pada entri progres di bawah.
- [ ] **Terblokir** — Jalankan aplikasi untuk memverifikasi alur proyek, sesi,
      terminal, dan diff. Backend belum dijalankan penuh di sandbox ini
      (`packages/opencode` ter-OOM saat typecheck; runtime end-to-end belum diuji).
- [~] Verifikasi perubahan folder picker dan thinking ringkas. **Sebagian**:
      terverifikasi lewat unit test dan pembacaan kode (web, desktop lokal, remote);
      verifikasi runtime membuka ulang reasoning lama masih terblokir.
- [ ] **Terblokir** — Catat benchmark production sebelum perubahan
      session/timeline berikutnya. Sesi ini tidak menyentuh kode session/timeline,
      jadi benchmark belum wajib; belum dapat dijalankan di sandbox.
- [~] Pastikan strategi build UI/backend dan kebutuhan aset/native dependency
      dapat dipenuhi pada target Windows. **Sebagian**: build UI renderer terbukti
      berhasil; binary Electron dan backend bundel belum dapat diunduh/diuji di sini.

**Kriteria selesai:** lingkungan pengembangan dapat menjalankan aplikasi dan tes;
status baseline serta kendala terdokumentasi. Jika pengujian Windows belum
tersedia, jangan menganggap build desktop Windows telah tervalidasi.

## Tahap 1 — Aplikasi desktop mandiri dengan Electron

### 1A. Kerangka dan integrasi UI

- [x] Buat `packages/desktop` dengan main process, preload, renderer entry,
      konfigurasi build, serta script pengembangan.
- [x] Gunakan kembali UI yang ada melalui `PlatformProvider`; jangan menduplikasi
      seluruh aplikasi dan jangan hanya membungkus situs upstream.
      Renderer hanya berisi entry + implementasi `Platform`; seluruh UI diimpor
      dari `@opencode-ai/app`.
- [x] Implementasikan dialog folder native, menu dasar, membuka tautan eksternal
      secara aman, dan penyimpanan data aplikasi sesuai lokasi OS.
      Belum tervalidasi runtime (binary Electron tidak tersedia di sandbox).
- [x] Pastikan proyek remote tetap menggunakan filesystem server, bukan dialog
      folder lokal yang menghasilkan path tidak relevan.
      `directoryPickerKind()` hanya memilih dialog native ketika koneksi lokal.

### 1B. Backend otomatis dan lifecycle

- [~] Bundel backend/runtime yang kompatibel; pengguna tidak perlu memasang Bun
      hanya untuk menjalankan aplikasi desktop. **Sebagian**: `script/backend.ts`
      memanggil `bun build --compile` (menghasilkan executable mandiri) dan
      `electron-builder.yml` mengemasnya sebagai `extraResources` di luar asar.
      Kompilasi binary Windows belum dijalankan di sesi ini.
- [x] Jalankan backend lokal otomatis dengan port tersedia, pemeriksaan kesehatan,
      batas waktu startup, dan penanganan benturan port.
      `--port 0` (utamakan 4096, fallback port bebas), polling `/api/health`,
      batas waktu 60 detik. Benturan port diverifikasi langsung: instance kedua
      mendapat port 39915.
- [x] Tampilkan loading, error startup yang dapat dipahami, opsi pemulihan, dan log
      yang tidak membocorkan kredensial. Renderer menunggu backend sehat; kegagalan
      menghasilkan alasan bertipe (`missing-binary`, `spawn-failed`, `exited-early`,
      `startup-timeout`, `unhealthy`) yang dipetakan ke kunci i18n, plus
      `backendRetry` untuk mencoba lagi. Log meredaksi kredensial.
- [x] Tentukan perilaku single-instance/multi-window serta kepemilikan proses.
      Single-instance lock; satu backend dimiliki proses main dan dipakai bersama
      semua window; server eksternal tidak pernah dimiliki aplikasi.
- [x] Saat aplikasi ditutup, hentikan backend dan proses anak yang dimilikinya
      dengan benar; jangan menghentikan server eksternal milik pengguna.
      `before-quit` ditunda sampai anak benar-benar keluar; SIGTERM ke process
      group lalu eskalasi SIGKILL. Diverifikasi: port dilepas, tidak ada proses yatim.
- [ ] **Terblokir** — Uji pemulihan setelah crash serta persistensi sesi/proyek
      setelah dibuka ulang. Butuh Electron runtime yang belum tersedia di sandbox.

### 1C. Keamanan

- [x] Gunakan `nodeIntegration: false`, `contextIsolation: true`, dan sandbox renderer.
      Diuji lewat `src/main/index.test.ts` dengan modul `electron` yang di-mock.
- [x] Batasi API preload/IPC; validasi pengirim, argumen, path, dan operasi yang diizinkan.
      Semua handler memakai `senderWindow()` + parser di `src/shared/ipc.ts`.
- [x] Backend desktop lokal bind hanya ke loopback dengan autentikasi; jangan
      membuka layanan eksekusi shell ke LAN secara default.
      Backend dijalankan dengan `--hostname 127.0.0.1` dan password acak per
      proses. Diverifikasi terhadap backend nyata: 200 dengan kredensial benar,
      401 tanpa kredensial dan dengan password salah.
- [~] Jangan menaruh token di URL/log; tentukan penyimpanan kredensial aman OS.
      **Sebagian**: password backend dikirim lewat environment (bukan argv/URL,
      sehingga tidak tampak di daftar proses) dan log meredaksi token/API key.
      Penyimpanan kredensial OS (mis. Credential Manager) belum ditentukan.
- [x] Batasi navigasi, pembukaan jendela, origin, dan protokol tautan eksternal.
      `will-navigate` + `setWindowOpenHandler` + CSP di HTML renderer; hanya
      `http:`, `https:`, `mailto:` yang boleh dibuka keluar.
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

### Progres

#### 2026-09-18 — Tahap 0 (Persiapan dan baseline)

**Status:** sebagian selesai; verifikasi runtime aplikasi **terblokir**.

**Perubahan dan file terkait**

- `packages/app/src/index.ts` — ekspor `loadInitialLocale` agar renderer desktop
  dapat memuat locale awal tanpa mengimpor jalur internal `@/`.
- `packages/app/src/i18n/parity.test.ts` — domain paritas "desktop" kini
  kondisional. Fork ini memakai ulang kamus app (`DESKTOP_NATIVE_*`) dan tidak
  memiliki `packages/desktop/src/renderer/i18n/`, sehingga dua tes selalu gagal
  sebelum perubahan ini.
- `bun.lock` — lockfile hasil `bun install` (sebelumnya tidak ada di repo).

**Verifikasi (perintah dan hasil)**

| Perintah | Hasil |
| --- | --- |
| `bun install` (dengan `NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt`) | berhasil |
| `bun turbo typecheck --concurrency=1` | **16/17 lulus**; `opencode#typecheck` gagal |
| `cd packages/app && bun run typecheck` | lulus |
| `cd packages/app && bun run test:unit` | **724 pass / 0 fail** (sebelumnya 722/2) |
| `cd packages/app && bun run test:browser` | 43 pass / 0 fail |
| `cd packages/session-ui && bun test src` | 83 pass / 0 fail |
| `cd packages/ui && bun run test` | 27 pass / 0 fail |
| `cd script && bun test translate-app.test.ts` | 15 pass / 0 fail |
| `cd packages/app && bun run build` | berhasil (mode web tidak rusak) |

**Kegagalan lama vs regresi baru**

- *Lama (bukan regresi):* `packages/app/src/i18n/parity.test.ts` gagal 2 tes di
  HEAD `abc2353` karena merujuk direktori i18n desktop upstream yang tidak ada di
  fork ini. Sudah diperbaiki; sekarang 0 fail.
- *Lama (belum diperbaiki):* `opencode#typecheck` mati dengan `SIGKILL`. Ini
  kehabisan memori pada sandbox (RAM 3 GB, 2 vCPU), bukan kesalahan tipe —
  `tsgo` dibunuh OS tanpa mencetak diagnostik. Perlu diuji ulang di mesin
  dengan RAM lebih besar.
- *Regresi baru:* tidak ada.

**Verifikasi PR #14 (folder picker + thinking ringkas)**

- Folder picker: `packages/app/src/components/directory-picker.tsx` memakai
  `directoryPickerKind()`; dialog native hanya untuk `platform === "desktop"`
  **dan** `ServerConnection.local(server)`. Server remote tetap memakai
  `DialogSelectDirectoryV2` yang menelusuri filesystem server. Tes
  `directory-picker.test.ts` + `directory-picker-domain.test.ts`: 24 pass / 0 fail.
- Thinking ringkas: `createReasoningDisclosure()` hanya menutup otomatis saat
  streaming berhenti dan tidak mengatur ulang pilihan manual pengguna; badan
  reasoning hanya dirender saat terbuka, jadi reasoning lama dapat dibuka ulang.
- **Belum terverifikasi runtime.** Klik-per-klik di aplikasi nyata (web, desktop
  lokal, server remote) belum dilakukan.

**Benchmark session/timeline:** tidak dijalankan. Sesi ini tidak mengubah kode
session/timeline, jadi aturan benchmark belum berlaku. Perubahan berikutnya di
area itu wajib mencatat baseline production lebih dulu.

**Kendala/risiko**

- `bun.sh` dan GitHub release assets tidak dapat diakses dari sandbox; Bun
  dipasang lewat registry npm.
- `bun install` gagal tanpa `NODE_EXTRA_CA_CERTS` (verifikasi rantai sertifikat
  tarball GitHub).
- Binary Electron tidak dapat diunduh, sehingga tidak ada jendela Electron yang
  benar-benar dibuka di sesi ini.

**Langkah berikutnya:** jalankan ulang `opencode#typecheck` dan alur aplikasi
end-to-end pada mesin dengan memori memadai.

#### 2026-09-18 — Tahap 1A (Kerangka Electron dan integrasi UI)

**Status:** implementasi selesai; **belum tervalidasi runtime**.

**Perubahan dan file terkait** — paket baru `packages/desktop`:

| Berkas | Isi |
| --- | --- |
| `src/main/index.ts` | Proses main: window ter-hardening, IPC tervalidasi, single-instance, kebijakan navigasi/permission |
| `src/main/config.ts` | Penegakan URL backend loopback dan kebijakan navigasi |
| `src/main/menu.ts` | Template menu dari `@opencode-ai/app/desktop-menu` (tidak ada definisi menu kedua) |
| `src/main/storage.ts` | Penyimpanan key/value bernamespace di direktori data aplikasi OS |
| `src/main/log.ts` | Log berkas dengan redaksi token/password/API key |
| `src/preload/index.ts` | Satu-satunya jembatan `contextBridge`; tidak membocorkan `ipcRenderer` |
| `src/shared/ipc.ts` | Kontrak IPC + parser validasi (bebas Electron/Node) |
| `src/renderer/entry.tsx` | Entry renderer: memasang UI app lewat `PlatformProvider` |
| `src/renderer/platform.ts` | Implementasi `Platform` desktop |
| `src/renderer/bootstrap.ts` | Koneksi server awal (loopback) |
| `index.html` | Host renderer dengan CSP ketat |
| `vite.renderer.config.ts` | Build renderer memakai ulang plugin `@opencode-ai/app/vite` |
| `script/build.ts`, `script/dev.ts` | Build (main/preload CJS + renderer Vite) dan launcher dev |
| `electron-builder.yml` | Konfigurasi NSIS Windows x64 (**konfigurasi saja, belum dijalankan**) |
| `AGENTS.md`, `README.md` | Aturan paket dan cara pakai |

**Keputusan teknis**

1. **Pakai ulang UI, bukan duplikasi.** Renderer hanya berisi entry dan adaptor
   `Platform`; semua komponen diimpor dari `@opencode-ai/app`. Konfigurasi Vite
   memakai ulang `@opencode-ai/app/vite` sehingga alias `@/`, Tailwind, Solid,
   dan transform theme-preload identik dengan mode web.
2. **Electron, bukan wrapper situs.** Renderer memuat berkas lokal (`file://`)
   pada aplikasi terpaket; tidak ada pemuatan `app.opencode.ai`.
3. **Electron 44.4.0 + electron-builder 26.15.3** (rilis stabil terbaru saat ini;
   keduanya sudah tercantum di `trustedDependencies`/`minimumReleaseAgeExcludes`
   root, menandakan pilihan yang sudah diantisipasi repo).
4. **Preload harus CJS.** Preload dengan `sandbox: true` tidak mendukung ESM,
   jadi `script/build.ts` membundel main dan preload sebagai CommonJS.
5. **Base URL relatif** (`base: "./"`) supaya aset tetap termuat dari `file://`.
6. **Locale IPC satu arah.** Renderer mengirim bundel `DESKTOP_NATIVE_*` ke main
   lewat `publishTranslations`, divalidasi `parseDesktopNativeBundle()` sebelum
   menu dibangun ulang. Tidak ada string Inggris yang di-hardcode di paket ini.
7. **URL backend hanya loopback.** `OPENCODE_DESKTOP_SERVER_URL` diabaikan jika
   bukan `http:` loopback; jika hasil akhirnya bukan loopback, aplikasi keluar.

**Keamanan (Tahap 1C, diterapkan sejak awal)**

- `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`,
  `webviewTag: false`, `webSecurity: true`, `allowRunningInsecureContent: false`.
- Setiap handler IPC memverifikasi bahwa pengirimnya adalah window yang dibuat
  proses ini **dan** bahwa URL frame-nya berada pada origin yang diizinkan.
- Setiap payload melewati parser: namespace/kunci penyimpanan menolak traversal
  dan karakter kontrol, nilai dibatasi 1 MiB, URL eksternal dibatasi
  `http:`/`https:`/`mailto:`, URL server dibatasi `http:`/`https:`.
- Permission handler menolak semua permintaan secara default; `will-attach-webview`
  diblokir; CSP melarang `frame-src`, `object-src`, `base-uri`, `form-action`.
- Log meredaksi `auth_token`, `api_key`, `password`, `Bearer …`, dan kunci `sk-…`.

**Verifikasi (perintah dan hasil)**

| Perintah | Hasil |
| --- | --- |
| `cd packages/desktop && bun test src` | **44 pass / 0 fail** (6 berkas) |
| `cd packages/desktop && bun run typecheck` | bersih |
| `cd packages/desktop && bun run script/build.ts` | berhasil: `dist/main/index.cjs`, `dist/preload/index.cjs`, `dist/renderer/*` |
| Vite dev server renderer pada `127.0.0.1:4455` | melayani HTML + mentransformasi `entry.tsx` |
| `bunx oxlint packages/desktop` | 0 warning / 0 error |
| `bunx prettier --check` | lulus |
| `cd packages/app && bun run build` + `test:unit` | tetap hijau (mode web tidak rusak) |

Cakupan tes: validasi kontrak IPC, kebijakan loopback/navigasi, redaksi log,
penyimpanan, pembangunan menu, dan smoke test proses main (modul `electron`
di-mock) yang menegaskan preferensi keamanan window serta penolakan IPC dari
frame asing.

**Belum terverifikasi / terblokir**

- **Tidak ada jendela Electron yang pernah dibuka.** Binary Electron tidak dapat
  diunduh di sandbox (`github.com` release assets memutus TLS) dan tidak ada
  display. Dialog folder native, menu, notifikasi, dan penyimpanan hanya teruji
  melalui mock.
- **Tidak ada installer.** `electron-builder.yml` belum pernah dijalankan; belum
  ada artefak Windows, belum ada code signing, dan **tidak ada klaim siap rilis**.
- **Backend belum otomatis** (Tahap 1B). Saat ini backend harus dijalankan manual
  di `127.0.0.1:4096`, sehingga janji "tanpa menjalankan server manual" belum
  terpenuhi.

**Langkah berikutnya**

1. Tahap 1B: bundel/supervisi backend — pemilihan port, health check, batas waktu
   startup, UI loading/error, dan penghentian proses anak saat keluar.
2. Jalankan `bun run dev` di mesin Windows/Linux berdisplay untuk memvalidasi
   jendela, dialog folder, menu, dan penyimpanan secara nyata.
3. Setelah 1B stabil, jalankan `electron-builder` untuk installer Windows x64 dan
   uji install/launch/uninstall pada Windows bersih (Tahap 1D).

#### 2026-09-18 — Tahap 1B (Backend otomatis dan lifecycle)

**Status:** implementasi selesai dan **terverifikasi terhadap backend nyata**;
integrasi di dalam Electron runtime **belum tervalidasi**.

**Perubahan dan file terkait**

| Berkas | Isi |
| --- | --- |
| `src/main/backend.ts` | `BackendSupervisor`: spawn, tunggu banner port, polling health, shutdown pohon proses |
| `src/main/backend-policy.ts` | Logika murni: parsing banner, argumen, environment, header auth, pemetaan kegagalan |
| `src/main/paths.ts` | Resolusi path binary backend (packaged vs dev; di luar asar) |
| `script/backend.ts` | Menyiapkan executable backend via `bun build --compile` |
| `script/verify-backend.ts` | Pemeriksaan integrasi terhadap backend sungguhan |
| `src/main/index.ts` | Integrasi lifecycle: startup, IPC status/retry, `before-quit` |
| `src/shared/ipc.ts` | Tipe `BackendStatus` + kanal `backendState`/`backendRetry` |
| `src/renderer/bootstrap.ts` | `waitForBackend()`, kredensial pada koneksi server |
| `electron-builder.yml` | Backend dikemas sebagai `extraResources` (wajib di luar asar) |
| `.gitignore` | Binary backend hasil staging tidak masuk Git |

**Keputusan teknis**

1. **`--port 0`, bukan port tetap.** Backend sudah mengutamakan 4096 lalu jatuh ke
   port bebas. Port dibaca dari stdout, tidak pernah ditebak. Diverifikasi
   langsung: instance kedua mendapat 39915 saat 4096 terpakai.
2. **Password acak per proses lewat environment.** Tidak lewat argv (agar tidak
   tampak di daftar proses) dan tidak lewat URL. `OPENCODE_SERVER_PASSWORD` milik
   induk sengaja ditimpa agar kredensial yang diberikan ke renderer selalu cocok.
3. **Kepemilikan proses eksplisit.** Backend yang di-spawn aplikasi dimatikan saat
   keluar; server dari `OPENCODE_DESKTOP_SERVER_URL` tidak pernah disentuh.
4. **Kegagalan bertipe, bukan menggantung.** Lima alasan kegagalan dipetakan ke
   kunci i18n; 401/403 tidak di-retry karena retry tidak akan menolong.
5. **Backend di luar asar.** Berkas di dalam arsip asar tidak dapat dieksekusi,
   jadi dikemas sebagai `extraResources`.
6. **Gating startup memakai mekanisme yang sudah ada.** Renderer menunggu backend
   sehat sebelum mount, dan `ErrorPage` bersama sudah punya kunci
   `error.page.description.localServerStartup` untuk semua locale — tidak ada
   string Inggris baru yang di-hardcode.

**Bug yang ditemukan tes sendiri:** `killTree()` semula hanya memanggil
`process.kill(-pid)`. Ketika pemberian sinyal ke process group gagal, shutdown
menggantung selamanya. Kini gagal-sinyal jatuh ke `child.kill()`.

**Verifikasi (perintah dan hasil)**

| Perintah | Hasil |
| --- | --- |
| `cd packages/desktop && bun test src` | **81 pass / 0 fail** (10 berkas) |
| `cd packages/desktop && bun run typecheck` | bersih |
| `cd packages/desktop && bun run script/verify-backend.ts` | **8/8 pemeriksaan lulus** |
| `cd packages/desktop && bun run script/build.ts` | berhasil |
| `bunx oxlint packages/desktop` | 0 warning / 0 error |
| `cd packages/app && bun run test:unit` | 724 pass / 0 fail (tidak ada regresi) |

Pemeriksaan integrasi `verify-backend.ts` terhadap backend **sungguhan**:
mencapai fase ready, bind ke `127.0.0.1`, health 200 dengan kredensial hasil
generate, **401 tanpa kredensial**, **401 dengan password salah**, supervisor
melaporkan stopped, dan **port dilepas setelah shutdown**. Diperiksa terpisah:
tidak ada proses backend yatim yang tersisa.

**Kendala/risiko**

- Binary backend Windows belum dikompilasi di sini; `script/backend.ts` sudah
  ada tetapi hanya jalur build untuk platform saat ini yang dijalankan.
- Verifikasi integrasi memakai shim yang menjalankan backend dari source melalui
  Bun, bukan executable `--compile`. Kontrak proses (stdout, port, auth, sinyal)
  sama, namun kompilasi mandiri masih perlu diuji tersendiri.
- Pemulihan setelah crash dan persistensi sesi setelah buka ulang belum diuji:
  butuh Electron runtime.

**Langkah berikutnya**

1. Kompilasi backend untuk `windows-x64` dan uji `script/backend.ts --target windows-x64`.
2. Jalankan `bun run dev` pada mesin berdisplay untuk memvalidasi loading,
   layar error, dan retry secara nyata.
3. Tahap 1D: `electron-builder --win --x64`, lalu uji install → buka lewat ikon →
   pilih folder → chat → terminal → tutup → buka ulang → uninstall pada Windows bersih.

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
