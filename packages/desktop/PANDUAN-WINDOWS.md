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

Branch: **`arena/01a0b5de-opencode`** (ini isi [PR #15](https://github.com/Delta-Polder-Indonesia/opencode/pull/15)).

### Kalau Anda BELUM punya repo-nya di mesin ini

```powershell
git clone https://github.com/Delta-Polder-Indonesia/opencode.git
cd opencode
git checkout arena/01a0b5de-opencode
```

### Kalau Anda SUDAH punya repo-nya

```powershell
cd path\ke\opencode

# simpan dulu pekerjaan lokal yang belum di-commit, kalau ada
git status

git fetch origin
git checkout arena/01a0b5de-opencode
git pull origin arena/01a0b5de-opencode
```

Pastikan Anda berada di commit yang benar:

```powershell
git log --oneline -3
```

Yang diharapkan muncul paling atas:

```
c5456dd feat(desktop): start and supervise the local backend (stage 1B)
6c3d1c2 feat(desktop): add Electron shell reusing the app UI (stage 1A)
abc2353 feat(app): browse project folders and collapse reasoning; plan desktop IDE (#14)
```

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

## Bagian 5 — Membuat installer (Tahap 1D, belum tervalidasi)

```powershell
cd packages\desktop
bun run package:win
```

Perintah ini menjalankan tiga hal berurutan: kompilasi backend, build bundle
desktop, lalu `electron-builder --win --x64`. Hasilnya ada di
`packages\desktop\release\` sebagai installer NSIS.

**Harap dibaca sebelum mencoba:**

- Ini **belum pernah dijalankan sekalipun**. Anggap sebagai percobaan pertama,
  bukan sebagai proses rilis yang sudah terbukti.
- Installer **tidak ditandatangani** (belum ada code signing). Windows SmartScreen
  akan memperingatkan saat dibuka. Jangan sebarkan ke orang lain dulu.
- Kalau gagal, kirimkan saya output error-nya — kemungkinan besar masalah
  konfigurasi `electron-builder`, dan itu memang pekerjaan Tahap 1D yang belum
  dimulai.

---

## Masalah yang mungkin muncul

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

Vite belum siap. Lihat output terminal; harusnya ada `127.0.0.1:4455`. Kalau port
4455 dipakai aplikasi lain, `strictPort` membuatnya gagal — tutup aplikasi
tersebut atau set `OPENCODE_DESKTOP_RENDERER_URL`.

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

# 4. installer (percobaan pertama, belum tervalidasi)
bun run package:win
```
