<#
  dev-safe.ps1 - jalankan opencode di Windows dengan aman.

  Aturan yang dipegang script ini:
    1. Hanya bind ke 127.0.0.1 (tidak terlihat dari Wi-Fi/LAN) kecuali -AllowLan.
    2. Password server selalu diisi (OPENCODE_SERVER_PASSWORD), diminta lewat
       prompt sehingga tidak muncul di layar dan tidak masuk riwayat perintah.
    3. Password hanya hidup selama script ini berjalan, lalu dibersihkan lagi
       (kecuali -KeepPasswordEnv).

  Contoh:
    powershell -ExecutionPolicy Bypass -File .\script\dev-safe.ps1
    powershell -ExecutionPolicy Bypass -File .\script\dev-safe.ps1 -Mode serve -Port 4096
    powershell -ExecutionPolicy Bypass -File .\script\dev-safe.ps1 -WithDevUi
    powershell -ExecutionPolicy Bypass -File .\script\dev-safe.ps1 -FromSource -WithDevUi
    powershell -ExecutionPolicy Bypass -File .\script\dev-safe.ps1 -Verify
    powershell -ExecutionPolicy Bypass -File .\script\dev-safe.ps1 -AllowLan -Cors http://<IP-PC>:3000

  Atau klik dua kali: script\dev-safe.cmd
#>
param(
  # "web" = server + UI di satu port (paling simpel, tanpa urusan CORS).
  # "serve" = server headless saja (untuk dipakai bareng `bun run dev:web`).
  [ValidateSet("web", "serve")][string]$Mode = "web",
  [int]$Port = 4096,
  [string]$User = "opencode",
  # Nyalakan juga Vite dev server (UI dengan hot reload) di 127.0.0.1.
  # Otomatis memakai mode "serve", karena UI-nya dilayani Vite.
  [switch]$WithDevUi,
  [int]$DevUiPort = 3000,
  # Jalankan dari source checkout ini lewat bun, bukan binary yang terpasang.
  [switch]$FromSource,
  # Membuka ke seluruh jaringan. Berisiko: siapa pun di Wi-Fi yang sama bisa
  # memakai agent ini (bisa menjalankan perintah & mengedit file).
  [switch]$AllowLan,
  # Origin tambahan yang boleh dipakai UI browser, mis. http://<IP-PC>:3000
  [string[]]$Cors = @(),
  # Jangan jalankan server, hanya periksa server yang sedang berjalan.
  [switch]$Verify,
  # Jangan pernah bertanya; kalau password tidak ada, langsung gagal (untuk CI,
  # scheduled task, atau perintah otomatis lain yang tidak punya terminal).
  [switch]$NonInteractive,
  # Biarkan OPENCODE_SERVER_PASSWORD tetap ada setelah script selesai.
  [switch]$KeepPasswordEnv,
  # Path ke binary opencode kalau tidak ada di PATH.
  [string]$Opencode = "opencode"
)

$ErrorActionPreference = "Stop"

function Write-Head([string]$Text) {
  Write-Host ""
  Write-Host "== $Text" -ForegroundColor Cyan
}

function Write-Ok([string]$Text) {
  Write-Host "  [ok]     $Text" -ForegroundColor Green
}

function Write-Bad([string]$Text) {
  Write-Host "  [BAHAYA] $Text" -ForegroundColor Red
}

function Write-Note([string]$Text) {
  Write-Host "  -        $Text" -ForegroundColor DarkGray
}

# Password dibaca tanpa ditampilkan, lalu diubah ke teks biasa karena opencode
# membacanya dari environment variable.
function Read-PlainPassword([string]$Prompt) {
  $secure = Read-Host $Prompt -AsSecureString
  $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {
    return [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  } finally {
    [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  }
}

# Start-Process menggabungkan argumen jadi satu baris perintah, jadi argumen
# yang mengandung spasi (mis. path repo "C:\My Projects\opencode") harus
# dikutip manual.
function Quote-Arg([string]$Value) {
  if ($Value -match '\s') { return '"' + $Value + '"' }
  return $Value
}

# Alamat mana saja yang saat ini mendengarkan port tersebut.
function Get-ListenerAddress([int]$ProbePort) {
  $found = @()
  $pattern = "^\s*TCP\s+(\S+):" + $ProbePort + "\s+\S+\s+LISTENING"
  foreach ($line in (netstat -ano)) {
    if ($line -match $pattern) {
      if ($found -notcontains $Matches[1]) { $found += $Matches[1] }
    }
  }
  return $found
}

function Get-HttpStatus([string]$Url, [string]$BasicAuth) {
  # Invoke-WebRequest dipakai lebih dulu karena berjalan di dalam proses ini:
  # password tidak muncul di command line proses lain (beda dengan curl -u user:pass).
  $headers = @{}
  if ($BasicAuth) {
    $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($BasicAuth))
    $headers["Authorization"] = "Basic $b64"
  }
  try {
    $response = Invoke-WebRequest -Uri $Url -Headers $headers -UseBasicParsing -TimeoutSec 5
    return [string][int]$response.StatusCode
  } catch {
    if ($_.Exception.Response) { return [string][int]$_.Exception.Response.StatusCode }
  }

  # Cadangan: curl.exe, dengan batas waktu supaya tidak menggantung.
  $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
  if ($curl) {
    $code = ""
    if ($BasicAuth) {
      $code = (& curl.exe -s --max-time 5 -o NUL -w "%{http_code}" -u $BasicAuth $Url).Trim()
    } else {
      $code = (& curl.exe -s --max-time 5 -o NUL -w "%{http_code}" $Url).Trim()
    }
    if ($code -and $code -ne "000") { return $code }
  }
  return "tidak-ada-jawaban"
}

function Show-ExposureReport([int]$ProbePort) {
  Write-Head "Cek siapa yang bisa mengakses port $ProbePort"
  $addresses = Get-ListenerAddress $ProbePort
  if ($addresses.Count -eq 0) {
    Write-Note "Tidak ada proses yang mendengarkan di port $ProbePort."
    return
  }

  $exposed = @()
  foreach ($address in $addresses) {
    if ($address -eq "0.0.0.0" -or $address -eq "[::]" -or $address -eq "*") {
      $exposed += $address
      Write-Bad "Mendengarkan di $address - terbuka untuk SEMUA perangkat di jaringan."
    } elseif ($address -eq "127.0.0.1" -or $address -eq "[::1]") {
      Write-Ok "Mendengarkan di $address - hanya bisa diakses dari PC ini."
    } else {
      $exposed += $address
      Write-Bad "Mendengarkan di $address - bisa diakses dari jaringan lokal."
    }
  }

  if ($exposed.Count -gt 0) {
    Write-Note "Perbaikan: hentikan server, lalu jalankan ulang tanpa --hostname 0.0.0.0 / --mdns."
    Write-Note "Uji dari HP: buka http://<IP-PC>:$ProbePort - kalau terbuka, port itu terbuka."
  }

  Write-Head "Cek autentikasi"
  $url = "http://127.0.0.1:$ProbePort/global/health"
  $anonymous = Get-HttpStatus $url ""
  if ($anonymous -eq "200") {
    Write-Bad "Tanpa password pun dijawab 200 - server ini TIDAK punya autentikasi."
  } elseif ($anonymous -eq "401") {
    Write-Ok "Tanpa kredensial dijawab 401 (meminta login) - autentikasi aktif."
  } else {
    Write-Note "Jawaban tanpa kredensial: $anonymous"
  }
}

# Tunggu sampai server benar-benar siap sebelum UI dijalankan.
function Wait-ForHealth([int]$ProbePort, [string]$BasicAuth, [int]$TimeoutSeconds = 20) {
  $url = "http://127.0.0.1:$ProbePort/global/health"
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if ((Get-HttpStatus $url $BasicAuth) -eq "200") { return $true }
    Start-Sleep -Milliseconds 500
  }
  return $false
}

# Cari cara menjalankan Vite: shim di node_modules\.bin (bun/npm membuat
# vite.cmd atau vite.exe di Windows), kalau tidak ada pakai `bun x vite`.
# Mengembalikan objek { File, Args } — objek dipakai supaya PowerShell tidak
# meratakan array satu elemen menjadi string (kalau itu terjadi, Index [0] akan
# mengambil huruf pertama path, mis. "D" dari "D:\...").
function Resolve-ViteCommand([string]$RepoRoot) {
  $binNames = @("vite.cmd", "vite.exe", "vite.ps1", "vite")
  $binDirs = @(
    (Join-Path $RepoRoot "node_modules\.bin"),
    (Join-Path $RepoRoot "packages\app\node_modules\.bin")
  )
  foreach ($dir in $binDirs) {
    foreach ($name in $binNames) {
      $candidate = Join-Path $dir $name
      if (Test-Path $candidate) { return [pscustomobject]@{ File = $candidate; Args = @() } }
    }
  }
  if (Get-Command bun -ErrorAction SilentlyContinue) {
    return [pscustomobject]@{ File = "bun"; Args = @("x", "vite") }
  }
  return [pscustomobject]@{ File = $null; Args = @() }
}

if ($Verify) {
  Write-Host ""
  Write-Host "Mode periksa saja (tidak menjalankan server)." -ForegroundColor Yellow
  Show-ExposureReport $Port
  if ($WithDevUi -and $DevUiPort -ne $Port) {
    Show-ExposureReport $DevUiPort
  }
  Write-Head "Kalau password aktif, uji dengan kredensial"
  Write-Note "curl.exe -s -o NUL -w `"%{http_code}`" -u ${User}:PASSWORD http://127.0.0.1:$Port/global/health"
  Write-Note "Harapannya 200. Kalau 401, password atau username salah."
  Write-Host ""
  exit 0
}

if ($WithDevUi -and $Mode -ne "serve") {
  Write-Host ""
  Write-Note "Mode dipaksa jadi `"serve`" karena UI-nya dilayani Vite dev server."
  $Mode = "serve"
}

# --- Susun perintah -------------------------------------------------------
$serverArgs = @($Mode, "--port", "$Port", "--hostname", $(if ($AllowLan) { "0.0.0.0" } else { "127.0.0.1" }))
foreach ($origin in $Cors) {
  if ($origin) { $serverArgs += @("--cors", $origin) }
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$prefix = @()
$launcher = $Opencode

if ($FromSource) {
  $bun = Get-Command bun -ErrorAction SilentlyContinue
  if (-not $bun) {
    Write-Head "bun tidak ditemukan di PATH"
    Write-Note "Jalankan tanpa -FromSource untuk memakai binary opencode yang terpasang."
    exit 1
  }
  $launcher = "bun"
  $prefix = @("run", "--cwd", (Join-Path $repoRoot "packages\opencode"), "src\index.ts")
}

$candidates = @(Get-Command $launcher -All -ErrorAction SilentlyContinue)
if ($candidates.Count -eq 0) {
  Write-Head "$launcher tidak ditemukan di PATH"
  Write-Note "Pasang dulu:  npm i -g opencode-ai@latest   (atau scoop install opencode)"
  Write-Note "Kalau menjalankan dari checkout ini, pakai -FromSource."
  Write-Note "Atau tunjuk langsung: -Opencode `"C:\path\ke\opencode.exe`""
  exit 1
}
# npm memasang beberapa shim di Windows (.cmd, .ps1, dan kadang .exe). Shim .ps1
# berjalan di dalam sesi PowerShell ini dan diakhiri `exit`, sehingga bisa
# mematikan skrip ini sebelum server sempat hidup. Jadi utamakan .exe/.cmd.
$preferred = $candidates | Where-Object { $_.Source -match '\.(exe|cmd|bat)$' } | Select-Object -First 1
$binary = if ($preferred) { $preferred } else { $candidates[0] }
if ($binary.Source -match '\.ps1$') {
  Write-Note "Catatan: '$launcher' hanya tersedia sebagai shim .ps1; kalau server langsung berhenti,"
  Write-Note "jalankan lewat opencode.cmd atau tunjuk binary-nya dengan -Opencode <path>."
}
# Start-Process butuh path lengkap; nama telanjang tidak selalu bisa ditemukan.
$launcherPath = if ($binary.Source) { $binary.Source } else { $launcher }

$viteCommand = $null
if ($WithDevUi) {
  $viteCommand = Resolve-ViteCommand $repoRoot
  if (-not $viteCommand.File) {
    Write-Head "Dependensi belum terpasang (Vite tidak ditemukan)"
    Write-Note "Jalankan dulu di root repo:  bun install"
    Write-Note "Lalu ulangi perintah ini."
    exit 1
  }
}

Write-Host ""
Write-Host "  opencode - jalan aman di Windows" -ForegroundColor White
$modeLabel = if ($WithDevUi) { "serve + Vite dev UI" } else { $Mode }
$bind = if ($AllowLan) { "0.0.0.0 (JARINGAN)" } else { "127.0.0.1 (PC ini saja)" }
Write-Host "  mode: $modeLabel   API: $Port   bind: $bind" -ForegroundColor White

# --- Password -------------------------------------------------------------
$password = $env:OPENCODE_SERVER_PASSWORD
$passwordFromEnv = $false
if ($password) {
  Write-Head "Password"
  Write-Note "Memakai OPENCODE_SERVER_PASSWORD yang sudah ada di sesi ini."
  $passwordFromEnv = $true
} elseif ($NonInteractive) {
  Write-Bad "OPENCODE_SERVER_PASSWORD tidak diset dan -NonInteractive aktif."
  Write-Note "Set password-nya dulu, contoh: `$env:OPENCODE_SERVER_PASSWORD = 'rahasia'"
  exit 1
} else {
  Write-Head "Password (tidak terlihat saat diketik)"
  Write-Note "Password ini melindungi API opencode. Tanpanya, siapa pun yang bisa"
  Write-Note "menjangkau port ini bisa menjalankan perintah di PC ini."
  $first = Read-PlainPassword "  Password"
  if (-not $first) {
    Write-Bad "Password kosong. Script berhenti supaya server tidak jalan tanpa proteksi."
    exit 1
  }
  $second = Read-PlainPassword "  Ulangi password"
  if ($first -ne $second) {
    Write-Bad "Dua isian tidak sama. Coba lagi."
    exit 1
  }
  $password = $first
}

if ($AllowLan) {
  Write-Head "PERINGATAN"
  Write-Bad "Mode -AllowLan membuka port $Port ke seluruh jaringan."
  Write-Note "Perangkat lain, termasuk tamu di Wi-Fi yang sama, bisa memakai agent ini"
  Write-Note "untuk menjalankan perintah dan mengubah file di PC ini."
  Write-Note "Pilihan lebih aman kalau butuh dari HP/laptop lain: SSH tunnel"
  Write-Note "  ssh -N -L $Port`:127.0.0.1:$Port user@PC-INI"
  Write-Note "atau VPN seperti Tailscale, daripada membuka LAN."
}

# --- Jalankan -------------------------------------------------------------
# Password hanya ada di environment proses ini; proses anak (server) mewarisinya.
$env:OPENCODE_SERVER_PASSWORD = $password
$basicAuth = "$User`:$password"

Write-Head "Menjalankan"
Write-Note "Perintah : $launcher $((($prefix + $serverArgs) -join ' '))"
Write-Note "Username : $User"
Write-Note "Password : (yang baru kamu isi)"
Write-Note "Berhenti : Ctrl+C"
Write-Host ""

if (-not $WithDevUi) {
  # Satu proses di foreground: Ctrl+C menghentikan server.
  if ($AllowLan) {
    Write-Note "URL dari perangkat lain : http://<IP-PC>:$Port"
  } elseif ($Mode -eq "web") {
    Write-Note "Buka di browser         : http://localhost:$Port"
  } else {
    Write-Note "API                     : http://localhost:$Port  (UI dev Vite menyasar port ini otomatis)"
  }
  Write-Host ""

  try {
    & $launcher @($prefix + $serverArgs)
  } finally {
    if (-not $passwordFromEnv -and -not $KeepPasswordEnv) {
      Remove-Item Env:OPENCODE_SERVER_PASSWORD -ErrorAction SilentlyContinue
      Write-Host ""
      Write-Note "OPENCODE_SERVER_PASSWORD sudah dibersihkan dari sesi ini."
    }
    Write-Head "Verifikasi (jalankan di PowerShell lain selagi server hidup)"
    Write-Note "powershell -ExecutionPolicy Bypass -File .\script\dev-safe.ps1 -Verify -Port $Port"
    Write-Note "Atau manual: netstat -ano | findstr :$Port"
    Write-Note "Harus muncul 127.0.0.1:$Port . Kalau muncul 0.0.0.0:$Port berarti terbuka ke jaringan."
  }
  exit 0
}

# --- Mode UI dev: server di belakang, Vite di depan ------------------------
$serverProcess = $null
try {
  $spawnArgs = (($prefix + $serverArgs) | ForEach-Object { Quote-Arg $_ }) -join " "
  $serverProcess = Start-Process -FilePath $launcherPath -ArgumentList $spawnArgs -PassThru -NoNewWindow
  Write-Note "Server berjalan sebagai proses PID $($serverProcess.Id)."

  if (-not (Wait-ForHealth $Port $basicAuth 25)) {
    Write-Bad "Server tidak menjawab di http://127.0.0.1:$Port dalam 25 detik."
    Write-Note "Kalau pakai -FromSource, pastikan `"bun install`" di root repo sudah dijalankan."
    exit 1
  }
  Write-Ok "Server siap di http://127.0.0.1:$Port (autentikasi aktif)."

  Write-Head "Vite dev UI"
  Write-Note "URL        : http://localhost:$DevUiPort"
  Write-Note "Bind       : 127.0.0.1 (menimpa host 0.0.0.0 di vite.config.ts)"
  Write-Note "Target API : http://localhost:$Port (otomatis dari packages/app/src/entry.tsx)"
  Write-Note "Login di UI: username $User + password yang baru kamu isi"
  Write-Note "Berhenti   : Ctrl+C (server ikut dimatikan)"
  Write-Note "Kalau port $DevUiPort sedang dipakai, pakai -DevUiPort <lain>, mis. -DevUiPort 3001"
  Write-Host ""

  $viteExe = $viteCommand.File
  $viteArgs = @($viteCommand.Args)

  Push-Location (Join-Path $repoRoot "packages\app")
  try {
    & $viteExe @($viteArgs + @("--host", "127.0.0.1", "--port", "$DevUiPort", "--strictPort"))
  } finally {
    Pop-Location
  }
} finally {
  if ($serverProcess) {
    $serverProcess.Refresh()
    if (-not $serverProcess.HasExited) {
      Write-Host ""
      Write-Note "Mematikan server opencode (PID $($serverProcess.Id))..."
      try {
        & taskkill /PID $serverProcess.Id /T /F 2>&1 | Out-Null
      } catch {
        Write-Note "Gagal mematikan otomatis; tutup manual PID $($serverProcess.Id) kalau perlu."
      }
    }
  }
  if (-not $passwordFromEnv -and -not $KeepPasswordEnv) {
    Remove-Item Env:OPENCODE_SERVER_PASSWORD -ErrorAction SilentlyContinue
    Write-Note "OPENCODE_SERVER_PASSWORD sudah dibersihkan dari sesi ini."
  }
  Write-Head "Verifikasi (jalankan di PowerShell lain selagi server hidup)"
  Write-Note "powershell -ExecutionPolicy Bypass -File .\script\dev-safe.ps1 -Verify -Port $Port -WithDevUi -DevUiPort $DevUiPort"
  Write-Note "Atau manual: netstat -ano | findstr `":$Port `""
  Write-Note "Harus muncul 127.0.0.1:$Port . Kalau muncul 0.0.0.0:$Port berarti terbuka ke jaringan."
}
