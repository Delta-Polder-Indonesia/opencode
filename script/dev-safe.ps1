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
    powershell -ExecutionPolicy Bypass -File .\script\dev-safe.ps1 -FromSource
    powershell -ExecutionPolicy Bypass -File .\script\dev-safe.ps1 -Verify
    powershell -ExecutionPolicy Bypass -File .\script\dev-safe.ps1 -AllowLan -Cors http://<IP-PC>:3000
#>
param(
  # "web" = server + UI di satu port (paling simpel, tanpa urusan CORS).
  # "serve" = server headless saja (untuk dipakai bareng `bun run dev:web`).
  [ValidateSet("web", "serve")][string]$Mode = "web",
  [int]$Port = 4096,
  [string]$User = "opencode",
  # Jalankan dari source checkout ini lewat bun, bukan binary yang terpasang.
  [switch]$FromSource,
  # Membuka ke seluruh jaringan. Berisiko: siapa pun di Wi-Fi yang sama bisa
  # memakai agent ini (bisa menjalankan perintah & mengedit file).
  [switch]$AllowLan,
  # Origin tambahan yang boleh dipakai UI browser, mis. http://<IP-PC>:3000
  [string[]]$Cors = @(),
  # Jangan jalankan server, hanya periksa server yang sedang berjalan.
  [switch]$Verify,
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
  $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
  if ($curl) {
    if ($BasicAuth) {
      return (& curl.exe -s -o NUL -w "%{http_code}" -u $BasicAuth $Url).Trim()
    }
    return (& curl.exe -s -o NUL -w "%{http_code}" $Url).Trim()
  }
  # Cadangan kalau curl.exe tidak tersedia.
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
    return "tidak-ada-jawaban"
  }
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

if ($Verify) {
  Write-Host ""
  Write-Host "Mode periksa saja (tidak menjalankan server)." -ForegroundColor Yellow
  Show-ExposureReport $Port
  Write-Head "Kalau password aktif, uji dengan kredensial"
  Write-Note "curl.exe -s -o NUL -w `"%{http_code}`" -u $User:PASSWORD http://127.0.0.1:$Port/global/health"
  Write-Note "Harapannya 200. Kalau 401, password atau username salah."
  Write-Host ""
  exit 0
}

# --- Susun perintah -------------------------------------------------------
$arguments = @($Mode, "--port", "$Port", "--hostname", $(if ($AllowLan) { "0.0.0.0" } else { "127.0.0.1" }))
foreach ($origin in $Cors) {
  if ($origin) { $arguments += @("--cors", $origin) }
}

if ($FromSource) {
  $bun = Get-Command bun -ErrorAction SilentlyContinue
  if (-not $bun) {
    Write-Head "bun tidak ditemukan di PATH"
    Write-Note "Jalankan tanpa -FromSource untuk memakai binary opencode yang terpasang."
    exit 1
  }
  $repoRoot = Split-Path -Parent $PSScriptRoot
  $arguments = @("run", "--cwd", (Join-Path $repoRoot "packages\opencode"), "src\index.ts") + $arguments
  $Opencode = "bun"
}

$binary = Get-Command $Opencode -ErrorAction SilentlyContinue
if (-not $binary) {
  Write-Head "opencode tidak ditemukan di PATH"
  Write-Note "Pasang dulu:  npm i -g opencode-ai@latest   (atau scoop install opencode)"
  Write-Note "Kalau menjalankan dari checkout ini, pakai -FromSource."
  Write-Note "Atau tunjuk langsung: -Opencode `"C:\path\ke\opencode.exe`""
  exit 1
}

Write-Host ""
Write-Host "  opencode - jalan aman di Windows" -ForegroundColor White
$bind = if ($AllowLan) { "0.0.0.0 (JARINGAN)" } else { "127.0.0.1 (PC ini saja)" }
Write-Host "  mode: $Mode   port: $Port   bind: $bind" -ForegroundColor White

# --- Password -------------------------------------------------------------
$password = $env:OPENCODE_SERVER_PASSWORD
$passwordFromEnv = $false
if ($password) {
  Write-Head "Password"
  Write-Note "Memakai OPENCODE_SERVER_PASSWORD yang sudah ada di sesi ini."
  $passwordFromEnv = $true
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
$env:OPENCODE_SERVER_PASSWORD = $password

Write-Head "Menjalankan"
if ($AllowLan) {
  Write-Note "URL dari perangkat lain : http://<IP-PC>:$Port"
} elseif ($Mode -eq "web") {
  Write-Note "Buka di browser         : http://localhost:$Port"
} else {
  Write-Note "API                     : http://localhost:$Port  (UI dev Vite menyasar port ini otomatis)"
}
Write-Note "Username                : $User"
Write-Note "Password                : (yang baru kamu isi)"
Write-Note "Perintah                : $Opencode $($arguments -join ' ')"
Write-Note "Berhenti                : Ctrl+C"
Write-Host ""

try {
  & $Opencode @arguments
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
