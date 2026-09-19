# Daftar Test Lengkap — PR #17 (perbaikan "teks balasan AI tidak tampil")

Branch: `arena/01a0b9f3-opencode` · Commit terakhir: `c7b03b8`
Semua angka di bawah adalah hasil run nyata di sandbox (bun 1.3.14) dan sebagian
di mesin Windows Anda (bun 1.4.2).

---

## A. Test inti PR ini (WAJIB lulus)

### A1. File regresi baru — 7 test
Perintah:

```bash
cd packages/session-ui
bun test --conditions=browser src/components/markdown-worker-unavailable.repro.test.tsx
```

| # | Nama test | Yang dibuktikan |
|---|---|---|
| 1 | `BASELINE: streamed text is visible from the first delta and settles to parsed HTML` | Jalur sehat: teks streaming muncul dari delta pertama → ter-parse jadi `<p>` |
| 2 | `BASELINE: completion (streaming -> false) keeps the full text` | Jalur sehat: saat streaming selesai, teks penuh tetap ada |
| 3 | `REGRESSION: worker crash mid-stream -> text keeps rendering (plain) during streaming and after completion` | **Inti fix**: worker mati di tengah stream → teks tetap tampil (plain) saat streaming lanjut **dan** setelah completion |
| 4 | `REGRESSION: after a crash, mounting another streaming part still renders the text (plain)` | Setelah crash (flag `disabled` persisten), part streaming baru tetap menampilkan teks |
| 5 | `REGRESSION: worker constructor failure -> fresh streaming mount still renders the text (plain)` | Konstruktor worker gagal (simulasi CSP/`file://`) → mount baru tetap render teks, container markdown ada |
| 6 | `REGRESSION: with an ErrorBoundary (like the session route), the content stays — no fallback needed` | ErrorBoundary ala route session **tidak** aktif — konten session utuh berisi teks |
| 7 | `CONTROL: non-streaming Markdown still renders (escaped plain text) when the worker is unavailable` | Kontrol: jalur statis tetap tampil (asimetri yang membuktikan titik kehilangan di jalur streaming) |

Status: **7 pass / 0 fail** (sandbox **dan** Windows Anda).

### A2. Suite paket `session-ui` — 15 file, 90 test
```bash
cd packages/session-ui
bun run test          # = bun test --conditions=browser src --only-failures
```

| File | Test |
|---|---|
| `src/components/apply-patch-file.test.ts` | 2 |
| `src/components/markdown-code-state.test.ts` | 2 |
| `src/components/markdown-inline-code-kind.test.ts` | 3 |
| `src/components/markdown-stream.test.ts` | 23 |
| `src/components/markdown-worker-protocol.test.ts` | 5 |
| `src/components/markdown-worker-queue.test.ts` | 2 |
| `src/components/markdown-worker-transport.test.ts` | 3 |
| **`src/components/markdown-worker-unavailable.repro.test.tsx`** | **7 (baru)** |
| `src/components/message-file.test.ts` | 4 |
| `src/components/message-part.test.ts` | 6 |
| `src/components/part-default-open.test.ts` | 5 |
| `src/components/session-diff.test.ts` | 10 |
| `src/v2/components/prompt-input/machine.test.ts` | 11 |
| `src/v2/components/prompt-input/store.test.ts` | 5 |
| `src/v2/components/session-review-file-preview-v2-virtualize.test.ts` | 2 |
| **Total** | **90** |

Status: **90 pass / 0 fail**. Tanpa `--conditions=browser`: **83 pass + 7 skip / 0 fail** (file regresi skip anggun dengan instruksi).

> Catatan: PR ini juga mengubah script `test` paket menjadi
> `bun test --conditions=browser src --only-failures`, supaya test regresi
> benar-benar dijalankan (tanpa kondisi itu `solid-js/web` = build server dan
> API client-only-nya melempar).

### A3. Konsumen: suite paket `app` (tempat `Markdown` dipakai)
```bash
cd packages/app
bun run test:unit      # 104 file, 727 test  -> 727 pass / 0 fail
bun run test:browser   # 15 file,  43 test  ->  43 pass / 0 fail
```

### A4. Typecheck & lint
```bash
cd packages/session-ui && bun run typecheck   # tsgo --noEmit -> bersih
cd packages/app        && bun run typecheck   # tsgo --noEmit -> bersih
bun run lint                                  # oxlint
```
- File yang diubah PR ini: **0 warning, 0 error**.
- `bun run lint` seluruh repo: 666 warning + **1 error pre-existing**
  (`packages/session-ui/src/v2/components/prompt-input/index.tsx` — octal
  literal, sudah ada di `main`, bukan dari PR ini).

---

## B. Suite paket `desktop` (lokasi bug terlihat) — 12 file, 114 test
```bash
cd packages/desktop
bun test src              # atau: bun run test
```

| File | Test |
|---|---|
| `src/main/backend-policy.test.ts` | 8 |
| `src/main/backend.test.ts` | 17 |
| `src/main/config.test.ts` | 7 |
| `src/main/index.test.ts` | 19 |
| `src/main/log.test.ts` | 4 |
| `src/main/menu.test.ts` | 6 |
| `src/main/paths.test.ts` | 12 |
| `src/main/renderer-protocol.test.ts` | 9 |
| `src/main/storage.test.ts` | 3 |
| `src/renderer/bootstrap.test.ts` | 10 |
| `src/renderer/fatal.test.ts` | 7 |
| `src/shared/ipc.test.ts` | 12 |
| **Total** | **114** |

Status: **114 pass / 0 fail**.

---

## C. Uji manual / live (tidak bisa dijalankan di sandbox)

### C1. Desktop dev — baseline (jalur sehat)
```powershell
cd packages\desktop
bun run dev     # (opsional: $env:OPENCODE_DESKTOP_DEVTOOLS="1" untuk DevTools)
```
- Kirim prompt → teks balasan streaming **dengan highlight** kode.
- Selesai → teks penuh tetap ada. Console bersih dari warn fallback.

### C2. Desktop dev — simulasi worker mati (membuktikan fix)
Tambah 1 baris sementara di `getWorker()`
(`packages\session-ui\src\components\markdown-worker.ts`, setelah
`if (disabled) throw new MarkdownWorkerUnavailableError(...)`):
```ts
if (import.meta.env.DEV) throw new MarkdownWorkerUnavailableError("simulated: worker unavailable (local test)")
```
Restart `bun run dev`, kirim prompt. Harus terlihat:
- teks tetap streaming & lengkap — **plain** (tanpa highlight);
- **bukan** halaman error / session digantikan fallback;
- 1 baris warn: `[markdown] worker unavailable, rendering plain-text fallback …`.
Hapus baris setelah uji.

### C3. Probe `file://` + CSP (build desktop lama)
`diagnosis-probe/markdown-worker-file-probe.html` (+ `.worker.js`) — buka dari
disk di Chrome (bukan dev server). Menampilkan pesan `SecurityError` verbatim
originn opaque + kaskade modul (`fail()` → `disabled` →
`MarkdownWorkerUnavailableError`).

### C4. Desktop packaged (jika menguji build hasil package)
Cari di console/`desktop.log`:
`[markdown] worker unavailable, rendering plain-text fallback <error>` — isi
`<error>` menunjuk mode kegagalan (constructor vs onerror vs onmessageerror).

---

## D. Matriks test seluruh repo (referensi)

| Paket | File test | Perintah | Hasil di sandbox |
|---|---|---|---|
| `packages/session-ui` | 15 | `bun run test` | 90 pass |
| `packages/app` | 104 (+15 browser, +12 e2e unit) | `bun run test` | 727 + 43 pass |
| `packages/desktop` | 12 | `bun test src` | 114 pass |
| `packages/ui` | 4 | `bun test src --only-failures` | (tidak dijalankan di sesi ini) |
| `packages/core` | 149 | `bun test --only-failures` | (tidak dijalankan) |
| `packages/opencode` | 219 | `bun test --timeout 30000 --only-failures` | (tidak dijalankan) |
| `packages/llm` | 30 | `bun test --timeout 30000 --only-failures` | (tidak dijalankan) |
| `packages/client` | 4 | `bun test --timeout 5000` | (tidak dijalankan) |
| `packages/codemode` | 7 | `bun test` | (tidak dijalankan) |
| `packages/httpapi-codegen` | 2 | `bun test --timeout 5000 --only-failures` | (tidak dijalankan) |
| `packages/effect-drizzle-sqlite` | 1 | `bun test --timeout 30000 --only-failures` | (tidak dijalankan) |
| `packages/http-recorder` | 1 | `bun test --timeout 30000 --only-failures` | (tidak dijalankan) |
| `packages/schema` | 6 | (tidak ada script test) | — |
| `packages/sdk` | 1 | `bun test` | — |
| `packages/protocol` | 1 | (tidak ada script) | — |
| **Total repo** | **583 file** | — | — |

E2E Playwright (`packages/app`): 62 file `.spec.ts`
(`bun run test:e2e`, `test:stability`, `test:bench`) — butuh browser, tidak
dijalankan di sesi ini.

> Catatan: `bun test` dari **root** sengaja dilarang
> (`"test": "echo 'do not run tests from root' && exit 1"`). Selalu dari folder
> paket.

---

## E. Checklist sebelum merge PR #17

- [x] File regresi 7/7 — sandbox & Windows
- [x] Suite `session-ui` 90/90 (dengan script `test` baru)
- [x] Suite `app` 727/727 + 43/43
- [x] Suite `desktop` 114/114
- [x] `tsgo --noEmit` bersih (session-ui + app)
- [x] oxlint bersih untuk file yang diubah
- [ ] **Uji live desktop (C1 + C2)** ← satu-satunya yang tersisa, di mesin Anda
- [ ] Jalur sehat tidak berubah: highlight normal, tanpa warn fallback (C1)
- [ ] Mode worker-mati: teks tetap tampil plain + 1 warn (C2)
