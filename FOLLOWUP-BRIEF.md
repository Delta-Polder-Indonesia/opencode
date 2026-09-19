# Brief untuk sesi baru (copy-paste)

Dua item lanjutan dari sesi diagnostik PR #17. **Jangan menyentuh PR #17**
(branch `arena/01a0b9f3-opencode`) — PR itu fokus fix markdown worker dan
sudah teruji; kerjakan dua hal di bawah di branch/sesi baru.

---

## Item 1 — Server balas 500 untuk `directory` yang tidak bisa di-resolve

**Gejala:** desktop dev dibanjiri
`GET /api/reference?directory=E:\ProjeckWebCatur\WebCatur → 500`,
diulang oleh retry (tanpa henti selama workspace itu aktif).

**Reproduksi (terbukti dari source, bukan binary):**
```bash
cd packages/opencode && bun run ./src/index.ts serve --port 4396
curl -s -o /dev/null -w "%{http_code}\n" \
  "http://127.0.0.1:4396/api/reference?directory=E%3A%5CProjeckWebCatur%5CWebCatur"
# → 500   (path valid, mis. /tmp → 200 {"data":[]})
```

**Log server** (`~/.local/share/opencode/log/opencode.log`):
```
level=ERROR message=failed ref=err_...
error="PlatformError: NotFound: FileSystem.realPath (E:\ProjeckWebCatur\WebCatur)
       (cause: Error: ENOENT: no such file or directory, lstat ...)"
level=WARN  message="failed to initialize fff" error="Failed to init file picker: Invalid path ..."
```

**Jalur kode:** `packages/server/src/handlers/reference.ts` →
`Reference.Service.list` (`packages/core/src/reference.ts`, `realPath` di
`finalize`) → error PlatformError keluar sebagai 500 `UnknownError`.

**Yang diinginkan:**
- directory tidak valid → respons tenang (404 atau `data: []`), bukan 500;
- `fff` (file picker) tidak perlu WARN untuk workspace yang tak ada;
- pastikan endpoint lain dengan pola `location.directory` sama tidak mengulang
  pola ini (cek `/api/path`, `/api/fs/*`, `/api/pty`).

**Konteks penting (jangan salah paham sebagai blocker):** klien SUDAH
menangkap error ini — `packages/app/src/context/global-sync/bootstrap.ts:323-330`
memakai `.catch(() => [])`. Jadi dampaknya: console kotor + retry berulang,
bukan UI rusak. Prioritasnya robustness, bukan hotfix.

**Test yang diharapkan:** handler test yang mengirim directory tak ada dan
memastikan status bukan 500 (mis. 404 / `data: []`), plus satu test bahwa
directory valid tetap 200.

---

## Item 2 — Warning Solid "created outside a createRoot"

**Gejala di console desktop dev:**
```
toast.tsx:46 computations created outside a `createRoot` or `render` will never be disposed
refcount.ts:13 cleanups created outside a `createRoot` or `render` will never be run
```

**Lokasi:**
- `packages/ui/src/components/toast.tsx:46` (`resolveIcon`, dipanggil dari
  `packages/app/src/components/dialog-connect-provider.tsx:723`);
- `packages/app/src/utils/refcount.ts:13` (`onCleanup`), dipicu
  `packages/app/src/context/notification.tsx:319` / `:340`
  (`handleSessionIdle`).

**Yang diinginkan:** komputasi/cleanup dibungkus `createRoot` atau dipindah ke
scope reaktif pemiliknya; periksa juga apakah ada kebocoran nyata (cleanup tak
pernah jalan). Keduanya pre-existing (dari commit #16), bukan regresi PR #17.

**Test yang diharapkan:** unit test yang memastikan tidak ada warning
`created outside a createRoot` pada jalur tersebut (mis. spy console.warn).

---

## Referensi bukti
- `catatan.md` — entri "reference 500 di desktop user (2026-09-19)".
- `DIAGNOSIS-markdown-worker.md` — diagnosis PR #17 (konteks, jangan diubah).
- `TEST-LIST.md` — daftar test PR #17 (jangan diubah).
