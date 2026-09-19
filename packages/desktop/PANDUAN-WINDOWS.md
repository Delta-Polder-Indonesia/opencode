# Panduan menjalankan Desktop OpenCode di Windows (Tahap 1A + 1B)

Panduan langkah demi langkah untuk menarik branch kerja dan menjalankan aplikasi
Electron di mesin Windows Anda sendiri.

Semua verifikasi di branch ini dilakukan tanpa Electron runtime (binary Electron
tidak bisa diunduh di lingkungan build). Jadi **jendela aplikasi belum pernah
benar-benar terbuka**. Menjalankan Bagian 3 di bawah adalah yang memvalidasi hal
itu untuk pertama kalinya.

---

## Bagian 0 — Prasyarat

| Kebutuhan                         | Keterangan                                      |
| --------------------------------- | ----------------------------------------------- |
| Windows 10/11 x64                 | Target build saat ini                           |
| Git                               | Untuk menarik branch                            |
| Bun **1.3.14**                    | Versi di `packageManager` root; pakai versi ini |
| Koneksi internet lancar ke GitHub | Instalasi mengunduh Electron (~100 MB)          |
| Ruang disk ~3 GB                  | `node_modules` + Electron + binary backend      |

Pasang Bun di PowerShell bila belum ada:

```powershell
powershell -c "irm bun.sh/install.ps1 | iex"
```

Lalu tutup dan buka lagi terminalnya, dan pastikan versinya:

```powershell
bun --version
```

> Kalau angkanya bukan `1.3.14`, jalankan `bun upgrade --stable` atau pasang
> versi persisnya. Perbedaan versi kecil biasanya aman, tetapi bila nanti muncul
> error aneh saat install, inilah tersangka pertama.

---

## Bagian 1 — Ambil branch-nya

Branch: **`arena/01a0b6f2-opencode`** (sesi kerja Tahap 1D).

### Kalau Anda BELUM punya repo-nya di mesin ini

```powershell
git clone https://github.com/Delta-Polder-Indonesia/opencode.git
cd opencode
git checkout arena/01a0b6f2-opencode
```

### Kalau Anda SUDAH punya repo-nya

```powershell
cd path\ke\opencode

# simpan dulu pekerjaan lokal yang belum di-commit, kalau ada
git status

git fetch origin
git checkout arena/01a0b6f2-opencode
git pull origin arena/01a0b6f2-opencode
```

Pastikan Anda berada di commit yang benar:

```powershell
git log --oneline -3
```

Commit teratas harusnya berisi Tahap 1D (script `packages/desktop/script/package.ts`,
ikon `packages/desktop/build/`, dan perubahan `electron-builder.yml`). Kalau tidak
ada, `git pull` dulu sampai ulang.

---

## Bagian 2 — Pasang dependensi

Dari **root repo** (bukan dari `packages/desktop`), karena ini monorepo Bun
workspaces:

```powershell
bun install
```

Langkah ini juga mengunduh binary Electron 44.4.0. Ini bagian paling lama dan
paling rawan gagal kalau jaringan Anda memblokir GitHub release.

<details>
<summary>Kalau unduhan Electron gagal / timeout</summary>

Pakai mirror, lalu install ulang:

```powershell
$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
bun install
```

</details>

---

## Bagian 3 — Jalankan dalam mode dev (paling cepat untuk melihat hasilnya)

Ada **dua cara**. Cara A jauh lebih cepat untuk percobaan pertama.

### Cara A — pakai backend yang Anda jalankan sendiri (disarankan lebih dulu)

Cara ini **melewati kompilasi backend** yang makan waktu lama, sehingga Anda bisa
langsung melihat jendela aplikasinya. Aplikasi akan menyambung ke server Anda dan
tidak akan pernah mematikannya.

**Terminal 1** — jalankan backend:

```powershell
cd packages\opencode
bun run .\src\index.ts serve --port 4096
```

Biarkan terminal ini terbuka. Tunggu sampai muncul baris seperti
`opencode server listening on http://127.0.0.1:4096`.

**Terminal 2** — jalankan shell desktop:

```powershell
cd packages\desktop
$env:OPENCODE_DESKTOP_SERVER_URL="http://127.0.0.1:4096"
bun run dev
```

Jendela Electron akan terbuka. Yang terjadi di balik layar: Vite menyala di
`127.0.0.1:4455`, bundle main/preload dibangun, lalu Electron dijalankan.

> Catatan: server yang dijalankan begini tidak memakai password, dan itu tidak
> apa-apa karena ia hanya mendengarkan di loopback. Perlindungan password ada di
> Cara B, yaitu jalur yang dipakai aplikasi asli.

### Cara B — backend otomatis (jalur yang sesungguhnya, seperti produk jadi)

Ini yang memvalidasi kerja Tahap 1B: aplikasi men-spawn backend-nya sendiri,
memberinya password acak, menunggu sehat, lalu mematikannya saat keluar.

**Langkah B1 — kompilasi executable backend** (sekali saja, butuh beberapa menit):

```powershell
cd packages\desktop
bun run build:backend
```

Butuh koneksi internet: build mengunduh snapshot `models.dev` dan beberapa
dependensi. Bila jaringan Anda memblokirnya, unduh `https://models.dev/api.json`
secara manual lalu tunjuk ke berkasnya:

```powershell
$env:MODELS_DEV_API_JSON="C:\path\ke\api.json"
bun run build:backend
```

Ini memanggil `bun build --compile` pada CLI opencode dan menaruh hasilnya di
`packages\desktop\resources\backend\opencode.exe`. Pastikan file itu ada:

```powershell
dir resources\backend
```

**Langkah B2 — jalankan:**

```powershell
bun run dev
```

Pastikan `OPENCODE_DESKTOP_SERVER_URL` **tidak** diset kali ini (kalau terminal
sebelumnya masih dipakai, tutup saja dan buka yang baru), supaya aplikasi memakai
backend sendiri.

Yang perlu Anda perhatikan:

1. Layar loading sebentar sementara backend dinyalakan.
2. UI muncul setelah backend sehat.
3. Tutup jendela → cek Task Manager, **tidak boleh ada `opencode.exe` yang
   tertinggal**. Ini hal paling penting untuk dicek di tahap ini.

---

## Bagian 4 — Yang perlu diuji

Tahap 1B belum pernah divalidasi di dalam Electron. Uji ini yang paling berguna:

| Uji              | Cara                                                   | Harapan                                                     |
| ---------------- | ------------------------------------------------------ | ----------------------------------------------------------- |
| Startup normal   | `bun run dev` (Cara B)                                 | Loading → UI muncul                                         |
| Pemilihan folder | Buka folder proyek dari UI                             | Dialog native Windows terbuka                               |
| Chat             | Kirim satu pesan                                       | Balasan mengalir normal                                     |
| Terminal         | Buka terminal di dalam app                             | Shell jalan                                                 |
| Shutdown bersih  | Tutup jendela, cek Task Manager                        | Tidak ada `opencode.exe` tersisa                            |
| Port bentrok     | Jalankan app dua kali                                  | Instance kedua dapat port lain, tetap jalan                 |
| Layar error      | Rename `resources\backend\opencode.exe` lalu jalankan  | Muncul pesan error + tombol coba lagi, bukan jendela kosong |
| Pemulihan        | Dari layar error, kembalikan nama file, klik coba lagi | Aplikasi pulih tanpa restart                                |

Dua baris terakhir menguji jalur yang sengaja dibuat di Tahap 1B tetapi **belum
pernah dijalankan sungguhan** — di situlah bug paling mungkin muncul.

---

## Bagian 5 — Membuat installer (Tahap 1D)

```powershell
cd packages\desktop
bun run package:win
```

Satu perintah menjalankan tiga hal berurutan (script `script/package.ts`):
kompilasi backend, build bundel desktop, lalu `electron-builder --win --x64`.
Hasilnya ada di `packages\desktop\release\` sebagai installer NSIS
(`OpenCode-1.18.31-win-x64.exe`).

**Yang sudah divalidasi sebelum perintah ini dicoba** (2026-09-19, lihat
`catatan.md`): alur `script/package.ts` dijalankan utuh di sandbox Linux dengan
`--linux --dir` — konfigurasi electron-builder diterima, asar 36 MB berisi
`dist/` lengkap tanpa `node_modules`, backend masuk `resources/backend` di luar
asar, dan electron fuses diterapkan. Yang **belum** pernah terjadi: build NSIS
itu sendiri dan artefak `OpenCode-*.exe` — keduanya hanya bisa dibuat di
Windows (kompilasi backend lintas-platform tidak didukung).

**Opsi yang tersedia** (`bun run script/package.ts <opsi>`):

| Opsi             | Arti                                                       |
| ---------------- | ---------------------------------------------------------- |
| `--skip-backend` | pakai `resources\backend\opencode.exe` yang sudah ada      |
| `--skip-bundle`  | pakai `dist\` yang sudah ada                               |
| `--dir`          | tanpa installer NSIS — folder `release\win-unpacked\` saja |

Contoh cepat mencoba hasil akhir tanpa NSIS:
`bun run script/package.ts --dir` lalu jalankan
`release\win-unpacked\OpenCode.exe`.

**Harap dibaca sebelum mencoba:**

- Installer **tidak ditandatangani** (belum ada code signing). Windows
  SmartScreen akan memperingatkan saat dibuka: klik _More info_ → _Run anyway_.
  Jangan sebarkan ke orang lain dulu.
- Build pertama mengunduh Electron 44.4.0 untuk packaging dari GitHub release.
  Kalau jaringan memblokirnya:

  ```powershell
  $env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
  $env:ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"
  bun run package:win
  ```

- Script sengaja **menolak jalan di luar Windows** (diuji): installer yang
  membawa binary backend platform yang salah akan rusak secara diam-diam.

**Kalau gagal**, kirimkan output error-nya. Kemungkinan besar masalah
konfigurasi `electron-builder`, dan itu pekerjaan Tahap 1D yang memang baru
pertama kali dijalankan di Windows.

---

## Masalah yang mungkin muncul

**`ENOENT ... .github\TEAM_MEMBERS`**

Sudah diperbaiki — `git pull` lalu ulangi. Daftar itu hanya dipakai perkakas
rilis, tetapi dibaca saat import sehingga menggagalkan semua build. Sekarang
daftar yang tidak ada diperlakukan sebagai daftar kosong.

**`bun run build:backend` gagal mencari `dist\opencode-windows-x64\bin\opencode.exe`**

Kompilasi backend selalu membangun untuk platform yang sedang berjalan.
Artinya perintah ini **hanya bekerja saat dijalankan di Windows** — Anda tidak
bisa membuat binary Windows dari Linux atau macOS dengan script ini. Karena Anda
memang di Windows, seharusnya aman. Kalau tetap gagal, Anda bisa menunjuk ke
binary yang sudah ada:

```powershell
bun run script/backend.ts --from C:\path\ke\opencode.exe
```

**`Port 4455 is already in use`**

Ada sisa dev server dari percobaan sebelumnya yang masih memegang port itu.
Penyebabnya sudah diperbaiki (lihat catatan di bawah), tetapi untuk
membersihkan sisa yang terlanjur ada:

```powershell
# lihat siapa yang memegang port 4455
netstat -ano | findstr :4455
# matikan lewat PID di kolom terakhir
taskkill /PID <pid> /T /F
```

Atau pakai port lain sekali jalan:

```powershell
$env:OPENCODE_DESKTOP_RENDERER_URL="http://127.0.0.1:4466"
bun run dev
```

**Start pertama terasa sangat lama (Vite "ready in 139725 ms")**

Normal di Windows pada percobaan pertama: Vite melakukan dependency
pre-bundling untuk seluruh UI. Start berikutnya jauh lebih cepat karena hasilnya
di-cache. Batas tunggu launcher kini 5 menit agar tidak menyerah lebih dulu.

**Jendela terbuka tapi putih/kosong**

Sudah diperbaiki dua putaran — `git pull` lalu ulangi:

1. **Putaran pertama (mode dev)** — beberapa jalur kegagalan berakhir tanpa
   jejak. Sekarang jendela menampilkan panel diagnostik, error renderer masuk
   log main process, dan DevTools bisa dinyalakan dengan
   `OPENCODE_DESKTOP_DEVTOOLS=1`.
2. **Putaran kedua (aplikasi ter-install)** — di installer, renderer dimuat
   dari berkas lokal. Entry renderer adalah ES module, dan module script
   butuh CORS; `file://` ber-origin opaque sehingga script entry diblokir —
   jendela putih tanpa pesan, padahal mode dev hijau (renderer dari server
   Vite). Kini renderer dikemas dan dimuat lewat skema `oc://renderer`
   (standard + secure), origin yang memang sudah diizinkan backend. Uji
   regresinya: `bun test src` di `packages/desktop`.

Kalau masih putih setelah `git pull` dan build ulang:

```powershell
$env:OPENCODE_DESKTOP_DEVTOOLS="1"
bun run dev            # mode dev, atau jalankan OpenCode.exe ter-install dari terminal yang sama
```

DevTools akan terbuka; error merah di tab Console adalah penyebabnya. Kirim
juga isi berkas log (`%APPDATA%\OpenCode\desktop.log`) — baris berawalan
`[renderer]` adalah error dari dalam UI.

**Aplikasi menggantung di layar loading**

Backend tidak pernah sehat. Batas waktunya 60 detik, lalu akan muncul layar
error. Kalau justru menggantung selamanya, itu bug — tolong laporkan.

**`opencode.exe` tertinggal di Task Manager setelah menutup app**

Ini bug yang serius dan justru yang paling ingin saya ketahui. Kode shutdown
mematikan pohon proses, tetapi jalur Windows-nya belum pernah diuji sungguhan.

---

## Ringkasan perintah

```powershell
# 1. ambil branch
git fetch origin
git checkout arena/01a0b5de-opencode
git pull origin arena/01a0b5de-opencode

# 2. pasang dependensi (dari root repo)
bun install

# 3a. cara cepat: backend manual
cd packages\opencode
bun run .\src\index.ts serve --port 4096
# terminal lain:
cd packages\desktop
$env:OPENCODE_DESKTOP_SERVER_URL="http://127.0.0.1:4096"
bun run dev

# 3b. jalur sesungguhnya: backend otomatis
cd packages\desktop
bun run build:backend
bun run dev

# 4. installer (pipeline tervalidasi; artefak pertama di Windows)
cd packages\desktop
bun run package:win
```
