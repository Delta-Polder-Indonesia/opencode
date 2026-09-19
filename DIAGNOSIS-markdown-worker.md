# Diagnosis: Teks balasan AI tidak pernah tampil di kolom chat

**Ruang lingkup:** HANYA diagnosis akar masalah (tanpa perbaikan).
**Render path yang sakit:** `PART_MAPPING["text"]` → `PacedMarkdown` → `Markdown`
(`packages/session-ui/src/components/message-part.tsx` →
`packages/session-ui/src/components/markdown.tsx`). Parsing markdown pindah ke
Web Worker sejak PR #40356 (`markdown.worker.ts` via `markdown-worker.ts`).

---

## 1. Kesimpulan (root cause)

Ketika Web Worker markdown **tidak tersedia** (konstruktor gagal, worker mati,
atau respons `error`), komponen `Markdown` **mati total** — bukan "teks
terhapus dari store". Alur datanya sehat (store/streaming terbukti oleh
`packages/app/src/context/global-sync/streaming-answer.test.ts` dan oleh test
BASELINE repro); yang gagal adalah **alur render**:

1. `getWorker()` **throw sinkron** — `markdown-worker.ts:116-124`
   (branch `disabled` di L118; konstruktor `new Worker(...)` di L120; catch
   L121-123 yang membungkusnya jadi `MarkdownWorkerUnavailableError`).
2. Loader resource `projection` (`projectMarkdown` — `markdown-worker.ts:68-75`,
   memanggil `getWorker()` di L69) melempar → resource masuk **error state**
   (Solid `createResource`: throw sinkron di loader → `completeLoad(undefined, err)`).
3. Solid 1.9.10: getter `resource.latest` untuk resource yang error **melempar
   error-nya** (`if (err && !pr) throw err` di `dist/solid.js`) — ia tidak
   mengembalikan `undefined`.
4. Bacaan `projection.latest` re-throw error tersebut:
   - `markdown.tsx:393` — `currentProjection()`
   - `markdown.tsx:406` — source resource `html` (throw saat setup komponen →
     mount mati, DOM kosong)
   - `markdown.tsx:497-499` — render effect (`html.latest ?? html()` dan
     `currentProjection()` → throw pada delta berikutnya saat mid-stream)
5. Lemparan naik sampai `SessionRouteErrorBoundary`
   (`packages/app/src/pages/session.tsx:168`; definisi L180-197, `<ErrorBoundary>`
   L185) → **seluruh konten session diganti fallback/ErrorPage** → teks jawaban
   (dan bagian lainnya di bawah boundary) tidak pernah tampil.

Faktor perburuk: `fail()` (`markdown-worker.ts:200-215`) menyetel flag
`disabled` **di level modul (process-global)** — sekali gagal, SEMUA mount
`Markdown` streaming berikutnya mati langsung tanpa retry.

**Asimetri yang membuktikan titik kehilangan:** jalur non-streaming (statis)
TIDAK memakai resource `projection` (pakai `completedProjection`) dan kegagalan
parse-nya di-catch → fallback teks-escaped tetap tampil (test CONTROL). Itulah
mengapa di lingkungan yang rusak, output tool/riwayat masih terlihat tetapi
jawaban streaming mati. `pendingBlocks()` BUKAN titik kehilangan — ia tidak
tercapai dalam mode gagal (error sudah terlempar di pembacaan `.latest`).

---

## 2. (a) Bug muncul di mana — web / desktop / keduanya?

| Lingkungan | Asal renderer | Worker same-origin? | Hasil |
|---|---|---|---|
| **Web (browser)** | http/https, origin server | Ya; **tidak ada CSP** di `packages/app` (tanpa meta di `index.html`, tanpa header CSP di server) | Tidak terjadi karena origin/CSP. Jika pun terjadi di web, lewat varian "worker mati saat runtime" (bagian bawah). |
| **Desktop dev** | `http://127.0.0.1:4455` (`DEV_RENDERER_URL`, `main/index.ts:52`) | Ya (same-origin http); CSP `script-src 'self'` mengizinkan worker same-origin | Tidak terjadi. |
| **Desktop packaged — kode SAAT INI** | skema custom **`oc://renderer`** (`RENDERER_ENTRY_URL`, `renderer-protocol.ts:24`), didaftarkan `standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true` (`main/index.ts:69`) | Ya — origin nyata `oc://renderer`, BUKAN `file://` opaque. Handler protokol melayani `assets/*.js` dengan `text/javascript`; CSP `'self'` teresolusi ke origin ini | Konstruktor tidak throw. **Hipotesis awal (file:// + CSP) sudah TERLEWAT waktu untuk HEAD saat ini** — kode sengaja menghindar dari `file://` (lihat komentar di `renderer-protocol.ts:1-17`). |
| **Desktop packaged — build lama** (sebelum skema `oc://`) | `file://…/index.html` + `base: "./"` (`vite.renderer.config.ts:16`) | **Tidak** — halaman `file://` ber-origin opaque "null" | Bug 100% sejak pakai pertama: `new Worker()` throw `SecurityError`. |
| **Semua lingkungan (varian runtime)** | — | Worker sudah hidup lalu mati | `onerror`/`onmessageerror` → `fail()` → delta berikutnya: teks membeku, lalu boundary menggantinya; mount berikutnya mati total (terbukti di test REPRO 3-4). |

Sisa kegagalan yang realistis pada packaged build kode sekarang:
(i) skrip worker/chunk tidak ter-load (aset hilang di asar, salah path) → event
`error` worker secara asinkron → `fail()` → mati di delta pertama;
(ii) error top-level di modul worker yang tidak tercakup handler try/catch
(`markdown.worker.ts` — handler `parse`/`runProject`/`highlight` sudah
mewrapp try/catch dan mem-post `{type:"error"}`, tapi kegagalan level modul/
import tidak) → hal yang sama.

---

## 3. (b) Error console yang tepat

**Penting: console bisa terlihat HAMPIR BERSIH** — semua jalur error di-catch:
- error konstruktor `Worker` di-catch di `markdown-worker.ts:121` (disimpan ke
  `disabled`, tidak di-log);
- `worker.onerror` → `fail()` — sunyi (`markdown-worker.ts:217-218`);
- `MarkdownWorkerUnavailableError` yang merambat **ditangkap ErrorBoundary**
  (`setErrored`) — bukan "Uncaught".

Yang justru terlihat:

1. **Sinyal paling andal di packaged (layout lama):** event **Sentry**
   `MarkdownWorkerUnavailableError` dengan pesan terbungkus
   (`ErrorPage` → `Sentry.captureException`, `packages/app/src/pages/error.tsx:315`).
   **Layout baru:** UI `SessionErrorFallback` (session.tsx:207-242) — seluruh
   isi session digantikan halaman error.
2. **Build lama `file://` / CSP yang memblokir worker** (hanya jika terbukti di
   console — sesuai keputusan proyek):
   - klasik: `SecurityError: Failed to construct 'Worker': Script at
     'file:///…/assets/markdown.worker-<hash>.js' cannot be loaded from an
     origin of 'null'.`
   - CSP: `Refused to create a worker from '…' because an attempted worker
     script violation of the following Content Security Policy directive was
     found: "script-src …"`.
3. **Aset worker tidak ter-load (packaged, skrip 404/hilang):**
   `Failed to load resource: …` untuk `…/assets/markdown.worker-<hash>.js`
   (di packaged berupa `oc://renderer/assets/…`), lalu perilaku sunyi
   (fallback muncul di delta berikutnya).
4. **Pesan `MarkdownWorkerUnavailableError`** (objek yang sampai ke boundary):
   - via `disabled`: pesan `fail()` — contoh `simulated worker crash: …`,
     `Markdown highlighting worker failed` (onerror tanpa message),
     `Markdown worker response failed` (onmessageerror), atau pesan respons
     `{type:"error"}` dari worker (mis. kegagalan highlighter);
   - via konstruktor: pesan error aslinya, contoh
     `Failed to construct 'Worker': …`.

**Untuk memastikan di lapangan** (langkah 3 diagnosis), tambahkan log sementara:

```ts
// packages/session-ui/src/components/markdown-worker.ts — SEMENTARA
// di dalam fail():
console.error("[md-worker] fail:", message, new Error().stack)
// di catch getWorker():
console.error("[md-worker] ctor failed:", error)
// di handler onmessage type "error":
console.error("[md-worker] worker error response:", event.data)
```

Interpretasi: `ctor failed` → masalah origin/CSP/aset; `fail: …` dengan pesan
onerror → worker mati saat runtime (tangkap juga DevTools tab yang error
dibuka saat crash — error di dalam worker tampil terpisah di console);
`worker error response` → handler worker menjalankan catch-nya (mis. WASM
shiki) — teks masih harusnya bisa fallback (periksa kenapa tidak).

---

## 4. (c) Titik kode persis di mana teks hilang

- **Throw awal:** `getWorker()` —
  `packages/session-ui/src/components/markdown-worker.ts:116-124`
  (L118 branch `disabled`; L120 `new Worker(MarkdownWorkerUrl, {type:"module"})`;
  L121-123 catch → `disabled = error` + throw `MarkdownWorkerUnavailableError`).
- **Penyakit propagasi (`disabled` persisten):** `fail()` —
  `markdown-worker.ts:200-215` (dipanggil dari `worker.onerror` L217 dan
  `worker.onmessageerror` L218).
- **Resource yang masuk error state:** `projection` —
  `packages/session-ui/src/components/markdown.tsx:380-389` (loader
  `projectMarkdown` — `markdown-worker.ts:68-75`).
- **Titik kehilangan teks (re-throw) — INI yang mematikan render:**
  - `markdown.tsx:393` — `currentProjection()` membaca `projection.latest`;
  - `markdown.tsx:406` — source resource `html` membaca `projection.latest`
    (mount fresh: throw saat setup, tidak ada DOM sama sekali);
  - `markdown.tsx:497-499` — render effect membaca `html.latest` dan
    `currentProjection()` (mid-stream: throw pada delta setelah crash).
- **Titik UI mati:** `packages/app/src/pages/session.tsx:168`
  (`<SessionRouteErrorBoundary>` membungkus seluruh route session) →
  `ErrorBoundary` (L185) → `ErrorPage` / `SessionErrorFallback`
  (Sentry di `packages/app/src/pages/error.tsx:315`).

Data TIDAK hilang di store: jalur server → sync → store teruji
(`streaming-answer.test.ts`), dan repro BASELINE membuktikan teks sampai ke
`Markdown` dan ter-render selama worker sehat.

---

## 5. Bukti runtime (repro)

- **File:** `packages/session-ui/src/components/markdown-worker-unavailable.repro.test.tsx`
- **Jalankan:** `cd packages/session-ui && bun test --conditions=browser src/components/markdown-worker-unavailable.repro.test.tsx`
- **Hasil: 7/7 lulus** (suite session-ui penuh: 90/90 lulus).

| # | Test | Membuktikan |
|---|---|---|
| 1 | BASELINE: teks streaming tampil dari delta pertama → `<p>` ter-parse | Perilaku sehat yang WAJIB dipertahankan fix |
| 2 | BASELINE: completion (streaming→false) mempertahankan teks penuh | Idem |
| 3 | REPRO: crash worker mid-stream → delta berikutnya melempar `MarkdownWorkerUnavailableError` (pesan `simulated worker crash: onig wasm failure`), DOM **membeku** di teks pra-crash | Mekanisme mid-stream, semua lingkungan |
| 4 | REPRO: setelah crash, mount streaming baru mati langsung (DOM kosong) | `disabled` persisten — tidak ada retry |
| 5 | REPRO: kegagalan konstruktor worker (simulasi CSP/`file://`) → throw saat mount, tidak ada DOM | Jalur constructor-throw |
| 6 | REPRO: dengan `ErrorBoundary` (mirip route session) → seluruh konten diganti fallback | Skenario user: teks tidak pernah tampil |
| 7 | CONTROL: Markdown non-streaming tetap tampil (teks escaped) saat worker mati | Asimetri — membuktikan titik kehilangan di jalur streaming (`.latest`) |

Harness memakai worker fake in-thread yang berbicara protokol asli
(`markdown-worker-protocol.ts`) sehingga `markdown-worker.ts`, resource Solid,
dan logika DOM berjalan sungguhan; Solid sendiri adalah build client asli
(`--conditions=browser`).

---

## 6. Perbaikan (TAHAP 2 — SUDAH diimplementasikan)

**Opsi 1 (fallback sinkron) sudah diterapkan** di
`packages/session-ui/src/components/markdown.tsx`:

- `currentProjection()` tidak lagi membaca `projection.latest`/accessor saat
  resource error — mengecek `projectionValue.error` dulu dan kembali
  `pendingProjection(local.text)` (proyeksi lokal, tanpa worker).
- Source resource `html` diperlakukan sama: saat resource error, source memakai
  `pendingProjection(local.text)` → loader html mencoba parse → worker mati →
  `parseMarkdown` reject → `.catch` loader yang SUDAH ADA menghasilkan
  RenderResult fallback (teks escaped penuh) — persis jalur statis.
- Satu `console.warn` sekali-per-process saat fallback aktif
  (`[markdown] worker unavailable, rendering plain-text fallback <error>`) —
  sinyal di console untuk debugging lapangan.
- Jalur sehat (worker normal) TIDAK berubah: tanpa error, `projectionValue()`
  identik dengan `projection.latest` yang lama; dua test BASELINE tetap lulus.

Hasil: worker mati (konstruktor ATAU mid-stream) → **teks tetap tampil sebagai
plain text** (tanpa highlight); tidak ada lagi ErrorBoundary yang mengganti
seluruh session. Uji: `markdown-worker-unavailable.repro.test.tsx` 7/7
(BASELINE 1-2 perilaku sehat; REGRESSION 3-6 teks tetap tampil saat streaming
DAN setelah completion + ErrorBoundary tidak aktif; CONTROL 7 jalur statis).
Suite session-ui 90/90, suite app 727/727, `tsgo --noEmit` bersih.

Sisa opsi (jika masih dibutuhkan setelah bukti lapangan):
2. **Recovery worker** (reset `disabled` / rebuild setelah kegagalan) — hanya
   berguna untuk kegagalan transien; tidak menyelesaikan masalah deterministik
   (CSP/aset hilang).
3. **Perbaikan aset worker di packaged** (verifikasi asar memuat
   `assets/markdown.worker-*.js` dan resolusi URL di bawah `oc://renderer`) —
   HANYA jika bukti console menunjuk kegagalan load aset.
4. **Perbaikan CSP** — HANYA jika console benar-benar menampilkan violation CSP
   (kesepakatan proyek).

---

## 7. Yang TIDAK bisa diverifikasi dari sandbox ini

- Console packaged desktop sungguhan (tidak ada Electron/Chromium di sandbox) →
  pakai log sementara di §3 + probe page berikut.
- **Probe page:** `diagnosis-probe/markdown-worker-file-probe.html` (+ file
  worker-nya). Buka dari disk (double-click) di Chrome: halaman `file://`
  dengan CSP yang sama persis dengan `packages/desktop/index.html` mencoba
  `new Worker(file://…)` dan menampilkan pesan error aslinya, lalu mensimulasikan
  kaskade modul (`fail()` → `disabled` → `MarkdownWorkerUnavailableError`) —
  untuk reproduksi visual jalur build lama / origin opaque.
