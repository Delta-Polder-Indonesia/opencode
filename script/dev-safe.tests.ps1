<#
  dev-safe.tests.ps1 - uji perilaku script/dev-safe.ps1 tanpa perlu server sungguhan.

  Yang diuji:
    1. dev-safe.ps1 bisa di-parse (sintaks PowerShell valid).
    2. -Verify pada port kosong tidak salah lapor.
    3. -Verify mendeteksi bind 0.0.0.0 sebagai BAHAYA.
    4. -Verify menilai bind 127.0.0.1 sebagai aman.
    5. -Verify mengenali server yang minta login (401) sebagai aman.
    6. -Verify mengenali server tanpa autentikasi (200) sebagai BAHAYA.
    7. -NonInteractive tanpa OPENCODE_SERVER_PASSWORD -> gagal (exit 1).
    8. opencode lama (tanpa perintah web/serve) ditolak sebelum tahap password.
    9. Server yang langsung berhenti: URL "siap" tidak tampil, kode keluar
      proses diteruskan.
   10. (opsional, -IncludeE2E) server opencode sungguhan: bind hanya 127.0.0.1,
      401 tanpa kredensial, 200 dengan kredensial, tanpa peringatan "unsecured".
   11. -WithDevUi menunggu server siap sebelum menjalankan Vite (--host
      127.0.0.1) dan merapikan proses setelahnya.

  Pemakaian:
    pwsh -NoProfile -File script/dev-safe.tests.ps1              # uji 1-7
    pwsh -NoProfile -File script/dev-safe.tests.ps1 -IncludeE2E  # + uji 8

  Keluar dengan kode 1 kalau ada uji yang gagal. Kalau $env:GITHUB_STEP_SUMMARY
  ada, hasilnya juga ditulis sebagai tabel Markdown di halaman run GitHub.
#>
param(
  [string]$Target = (Join-Path $PSScriptRoot "dev-safe.ps1"),
  [switch]$IncludeE2E,
  [int]$E2EPort = 42999,
  [string]$Opencode = "opencode"
)

$ErrorActionPreference = "Stop"
$script:results = @()

function Write-Head([string]$Text) {
  Write-Host ""
  Write-Host "== $Text" -ForegroundColor Cyan
}

# Start-Process menggabungkan argumen jadi satu baris perintah, jadi argumen
# yang mengandung spasi harus dikutip manual.
function Quote-Arg([string]$Value) {
  if ($Value -match '\s') { return '"' + $Value + '"' }
  return $Value
}

function Get-ShellExe {
  $pwsh = Get-Command pwsh -ErrorAction SilentlyContinue
  if ($pwsh) { return $pwsh.Source }
  $windowsPowerShell = Get-Command powershell.exe -ErrorAction SilentlyContinue
  if ($windowsPowerShell) { return $windowsPowerShell.Source }
  throw "Tidak menemukan pwsh / powershell.exe"
}

function Get-FreePort {
  $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
  $listener.Start()
  try {
    return $listener.LocalEndpoint.Port
  } finally {
    $listener.Stop()
  }
}

# Jalankan dev-safe.ps1 sebagai proses terpisah, tangkap output + exit code.
function Invoke-DevSafe([string[]]$Arguments, [string]$Password) {
  $shell = Get-ShellExe
  $outFile = [System.IO.Path]::GetTempFileName()
  $errFile = [System.IO.Path]::GetTempFileName()
  $previousPassword = $env:OPENCODE_SERVER_PASSWORD
  $forward = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $Target)
  # Selalu diteruskan supaya uji bisa mengganti binary lewat $script:Opencode,
  # baik saat runner memakai -Opencode maupun tidak.
  if ($Opencode) {
    $forward += @("-Opencode", $Opencode)
  }
  $line = (($forward + $Arguments) | ForEach-Object { Quote-Arg $_ }) -join " "

  try {
    if ($Password) {
      $env:OPENCODE_SERVER_PASSWORD = $Password
    } else {
      Remove-Item Env:OPENCODE_SERVER_PASSWORD -ErrorAction SilentlyContinue
    }
    $process = Start-Process -FilePath $shell -ArgumentList $line -NoNewWindow -Wait -PassThru `
      -RedirectStandardOutput $outFile -RedirectStandardError $errFile
    return @{
      ExitCode = $process.ExitCode
      Output   = ((Get-Content $outFile -Raw -ErrorAction SilentlyContinue) + "`n" + (Get-Content $errFile -Raw -ErrorAction SilentlyContinue))
    }
  } finally {
    Remove-Item -LiteralPath $outFile, $errFile -ErrorAction SilentlyContinue
    if ($null -eq $previousPassword) {
      Remove-Item Env:OPENCODE_SERVER_PASSWORD -ErrorAction SilentlyContinue
    } else {
      $env:OPENCODE_SERVER_PASSWORD = $previousPassword
    }
  }
}

# Server HTTP palsu yang meniru perilaku opencode: menjawab 401 kalau tidak ada
# header Authorization, 200 kalau ada. Dipakai untuk menguji deteksi dev-safe.ps1
# tanpa perlu mengunduh opencode.
function Start-FakeServer([string]$BindAddress, [int]$Port, [int]$AnonymousStatus) {
  $job = Start-Job -ArgumentList $BindAddress, $Port, $AnonymousStatus -ScriptBlock {
    param($BindAddress, $Port, $AnonymousStatus)
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Parse($BindAddress), $Port)
    $listener.Start()
    Write-Output "READY"
    while ($true) {
      $client = $listener.AcceptTcpClient()
      try {
        $stream = $client.GetStream()
        $buffer = New-Object byte[] 4096
        $read = $stream.Read($buffer, 0, $buffer.Length)
        $request = [System.Text.Encoding]::ASCII.GetString($buffer, 0, [Math]::Max($read, 0))
        $status = if ($request -match "(?im)^Authorization:\s*Basic\s+\S+" -and $AnonymousStatus -ne 200) { 200 } else { $AnonymousStatus }
        $reason = if ($status -eq 401) { "Unauthorized" } else { "OK" }
        $body = '{"healthy":true}'
        $response = "HTTP/1.1 $status $reason`r`nContent-Type: application/json`r`nContent-Length: $($body.Length)`r`nConnection: close`r`n`r`n$body"
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($response)
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush()
      } catch {
        # klien memutus koneksi lebih dulu; abaikan
      } finally {
        $client.Close()
      }
    }
  }

  $deadline = (Get-Date).AddSeconds(30)
  while ((Get-Date) -lt $deadline) {
    if ((Receive-Job -Job $job -Keep -ErrorAction SilentlyContinue) -match "READY") { return $job }
    Start-Sleep -Milliseconds 200
  }
  Stop-Job -Job $job -ErrorAction SilentlyContinue
  Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
  throw "Server palsu tidak siap dalam 30 detik"
}

function Stop-FakeServer($Job) {
  if (-not $Job) { return }
  Stop-Job -Job $Job -ErrorAction SilentlyContinue
  Remove-Job -Job $Job -Force -ErrorAction SilentlyContinue
}

# Sama seperti pengecekan di dev-safe.ps1: alamat yang mendengarkan port itu.
function Get-ListenerAddresses([int]$Port) {
  $found = @()
  $pattern = "^\s*TCP\s+(\S+):" + $Port + "\s+\S+\s+LISTENING"
  foreach ($line in (netstat -ano)) {
    if ($line -match $pattern -and $found -notcontains $Matches[1]) { $found += $Matches[1] }
  }
  return $found
}

function Get-HttpStatus([int]$Port, [string]$BasicAuth) {
  $headers = @{}
  if ($BasicAuth) {
    $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($BasicAuth))
    $headers["Authorization"] = "Basic $b64"
  }
  try {
    $response = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/global/health" -Headers $headers -UseBasicParsing -TimeoutSec 5
    return [int]$response.StatusCode
  } catch {
    if ($_.Exception.Response) { return [int]$_.Exception.Response.StatusCode }
    return 0
  }
}

function Assert-True([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw $Message }
}

function Add-Result([string]$Name, [string]$Status, [string]$Detail) {
  $script:results += [pscustomobject]@{ Name = $Name; Status = $Status; Detail = $Detail }
}

function Test-Case([string]$Name, [scriptblock]$Body, [switch]$Skip) {
  if ($Skip) {
    Add-Result $Name "SKIP" "dilewati"
    Write-Host "  [SKIP] $Name" -ForegroundColor Yellow
    return
  }
  Write-Host ""
  Write-Host "  -- $Name" -ForegroundColor DarkGray
  $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
  try {
    & $Body
    Add-Result $Name "PASS" ("{0:N1} dtk" -f $stopwatch.Elapsed.TotalSeconds)
    Write-Host "  [PASS] $Name" -ForegroundColor Green
  } catch {
    Add-Result $Name "FAIL" $_.Exception.Message
    Write-Host "  [FAIL] $Name -> $($_.Exception.Message)" -ForegroundColor Red
  }
}

Write-Host ""
Write-Host "  Uji dev-safe.ps1" -ForegroundColor White
Write-Host "  target : $Target"
Write-Host "  shell  : $(Get-ShellExe)"

# --- 1. Sintaks ------------------------------------------------------------
Test-Case "Sintaks dev-safe.ps1 valid" {
  $parseErrors = $null
  $null = [System.Management.Automation.Language.Parser]::ParseFile($Target, [ref]$null, [ref]$parseErrors)
  if ($parseErrors.Count -gt 0) {
    $messages = ($parseErrors | ForEach-Object { "baris $($_.Extent.StartLineNumber): $($_.Message)" }) -join "; "
    throw $messages
  }
}

# --- 2. Port kosong --------------------------------------------------------
Test-Case "-Verify pada port kosong melaporkan 'tidak ada proses'" {
  $port = Get-FreePort
  $result = Invoke-DevSafe @("-Verify", "-Port", "$port") ""
  Assert-True ($result.ExitCode -eq 0) "exit code $($result.ExitCode), harusnya 0"
  Assert-True ($result.Output -match "Tidak ada proses yang mendengarkan di port $port") "output tidak memuat pesan port kosong"
}

# --- 3 & 5. Bind 0.0.0.0 + server minta login ------------------------------
Test-Case "-Verify menandai bind 0.0.0.0 sebagai BAHAYA, 401 sebagai aman" {
  $port = Get-FreePort
  $server = Start-FakeServer "0.0.0.0" $port 401
  try {
    $result = Invoke-DevSafe @("-Verify", "-Port", "$port") ""
    Assert-True ($result.ExitCode -eq 0) "exit code $($result.ExitCode), harusnya 0"
    Assert-True ($result.Output -match "\[BAHAYA\].*terbuka untuk SEMUA perangkat di jaringan") "0.0.0.0 tidak ditandai BAHAYA"
    Assert-True ($result.Output -match "autentikasi aktif") "401 tidak dikenali sebagai autentikasi aktif"
  } finally {
    Stop-FakeServer $server
  }
}

# --- 4 & 6. Bind 127.0.0.1 + server tanpa autentikasi ----------------------
Test-Case "-Verify menilai bind 127.0.0.1 aman, 200 sebagai BAHAYA" {
  $port = Get-FreePort
  $server = Start-FakeServer "127.0.0.1" $port 200
  try {
    $result = Invoke-DevSafe @("-Verify", "-Port", "$port") ""
    Assert-True ($result.ExitCode -eq 0) "exit code $($result.ExitCode), harusnya 0"
    Assert-True ($result.Output -match "\[ok\].*hanya bisa diakses dari PC ini") "127.0.0.1 tidak dinilai aman"
    Assert-True ($result.Output -match "TIDAK punya autentikasi") "jawaban 200 tanpa password tidak ditandai BAHAYA"
  } finally {
    Stop-FakeServer $server
  }
}

# --- 7. Non-interaktif tanpa password -------------------------------------
Test-Case "-NonInteractive tanpa password gagal (exit 1)" {
  $result = Invoke-DevSafe @("-NonInteractive", "-Mode", "serve", "-Port", "$(Get-FreePort)") ""
  Assert-True ($result.ExitCode -eq 1) "exit code $($result.ExitCode), harusnya 1"
  Assert-True ($result.Output -match "OPENCODE_SERVER_PASSWORD tidak diset") "pesan penyebab tidak muncul"
}

# --- 8. Binary asing tanpa perintah 'serve' ---------------------------------
# Meniru jebakan nyata yang pernah dilaporkan user: opencode lama di PATH tidak
# mengenal perintah web/serve dan menganggap semua argumen nama folder
# ("Error: Failed to change directory to ..."). Script harus menolak SEBELUM
# tahap password, dengan petunjuk memperbarui binary.
Test-Case "opencode lama tanpa mode serve ditolak sebelum minta password" {
  $dir = Join-Path ([System.IO.Path]::GetTempPath()) ("opencode-lama-" + [guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $fake = Join-Path $dir "opencode.cmd"
  @("@echo off", "echo Error: Failed to change directory to %CD%\%*") | Set-Content -Path $fake -Encoding ASCII
  $previousOpencode = $script:Opencode
  $script:Opencode = $fake
  try {
    $result = Invoke-DevSafe @("-NonInteractive", "-Mode", "serve", "-Port", "$(Get-FreePort)") ""
    Assert-True ($result.ExitCode -eq 1) "exit code $($result.ExitCode), harusnya 1`n$($result.Output)"
    Assert-True ($result.Output -match "tidak mendukung mode") "pesan penolakan tidak muncul`n$($result.Output)"
    Assert-True ($result.Output -match "opencode-ai@latest") "petunjuk pembaruan tidak muncul`n$($result.Output)"
  } finally {
    $script:Opencode = $previousOpencode
    Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue
  }
}

# --- 9. Server yang gagal start ---------------------------------------------
# Binary-nya lolos pra-cek (mengenal perintahnya), tapi langsung mati saat
# diminta menjalankan server. Script tidak boleh menampilkan URL "siap",
# harus melaporkan kegagalan, dan meneruskan kode keluar prosesnya.
Test-Case "server yang langsung berhenti dilaporkan gagal (kode diteruskan)" {
  $dir = Join-Path ([System.IO.Path]::GetTempPath()) ("opencode-gagal-" + [guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $fake = Join-Path $dir "opencode.cmd"
  @(
    "@echo off",
    'echo %* | findstr /c:"--help" >nul && (echo Opsi: --port --hostname --cors & exit /b 0)',
    "echo Error: port tidak bisa dipakai",
    "exit /b 3"
  ) | Set-Content -Path $fake -Encoding ASCII
  $previousOpencode = $script:Opencode
  $script:Opencode = $fake
  try {
    $result = Invoke-DevSafe @("-NonInteractive", "-Mode", "serve", "-Port", "$(Get-FreePort)") "rahasia-uji"
    Assert-True ($result.ExitCode -eq 3) "exit code $($result.ExitCode), harusnya 3 (diteruskan dari proses server)`n$($result.Output)"
    Assert-True ($result.Output -match "langsung berhenti") "kegagalan start tidak dilaporkan`n$($result.Output)"
    Assert-True ($result.Output -notmatch "Server siap") "URL 'siap' tampil padahal server tidak pernah hidup`n$($result.Output)"
  } finally {
    $script:Opencode = $previousOpencode
    Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue
  }
}

# --- 10. Server opencode sungguhan (opsional) -------------------------------
# Sama seperti dev-safe.ps1: utamakan shim .exe/.cmd, jangan .ps1.
$e2eCandidates = @(Get-Command $Opencode -All -ErrorAction SilentlyContinue)
$e2eCommand = $e2eCandidates | Where-Object { $_.Source -match '\.(exe|cmd|bat)$' } | Select-Object -First 1
if (-not $e2eCommand) { $e2eCommand = $e2eCandidates | Select-Object -First 1 }
$e2eSkip = -not $IncludeE2E -or -not $e2eCommand
if ($e2eCommand) { $e2eTarget = $e2eCommand.Source } else { $e2eTarget = $Opencode }

Test-Case "Server nyata: hanya 127.0.0.1, 401 tanpa kredensial, 200 dengan kredensial" -Skip:$e2eSkip {
  $password = "ci-" + [guid]::NewGuid().ToString("N").Substring(0, 8)
  $shell = Get-ShellExe
  $outFile = [System.IO.Path]::GetTempFileName()
  $errFile = [System.IO.Path]::GetTempFileName()
  $previousPassword = $env:OPENCODE_SERVER_PASSWORD
  $arguments = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $Target, "-NonInteractive", "-Mode", "serve",
    "-Port", "$E2EPort", "-Opencode", $e2eTarget)
  $line = ($arguments | ForEach-Object { Quote-Arg $_ }) -join " "
  $process = $null
  $observed = @()
  $env:OPENCODE_SERVER_PASSWORD = $password

  # Diagnostik lengkap supaya kegagalan di runner bisa ditelusuri tanpa akses mesin.
  $diagnose = {
    $captured = ((Get-Content $outFile -Raw -ErrorAction SilentlyContinue) + "`n" + (Get-Content $errFile -Raw -ErrorAction SilentlyContinue))
    $exitState = if ($process) { if ($process.HasExited) { "keluar dengan kode $($process.ExitCode)" } else { "masih hidup" } } else { "tidak dijalankan" }
    $listeners = (Get-ListenerAddresses $E2EPort) -join ", "
    $version = ""
    try { $version = (& $e2eTarget --version 2>&1 | Out-String).Trim() } catch { $version = "gagal query versi: $($_.Exception.Message)" }
    $command = Get-Command $e2eTarget -ErrorAction SilentlyContinue
    $allCandidates = @(Get-Command $Opencode -All -ErrorAction SilentlyContinue | ForEach-Object { "$($_.CommandType):$($_.Source)" }) -join "; "
    @(
      "perintah   : $line"
      "opencode   : $e2eTarget (jenis: $($command.CommandType)) versi: $version"
      "kandidat   : $allCandidates"
      "proses     : $exitState"
      "status HTTP yang terlihat: $(if ($observed.Count) { $observed -join ', ' } else { 'tidak ada jawaban' })"
      "pendengar  : $(if ($listeners) { $listeners } else { 'tidak ada yang mendengarkan di port ' + $E2EPort })"
      "netstat    :"
      ((netstat -ano | Select-String ":$E2EPort" | ForEach-Object { "  $($_.Line.Trim())" }) -join "`n")
      "keluaran proses:"
      "---"
      $captured
      "---"
    ) -join "`n"
  }

  try {
    $process = Start-Process -FilePath $shell -ArgumentList $line -NoNewWindow -PassThru `
      -RedirectStandardOutput $outFile -RedirectStandardError $errFile
    Write-Host "  proses PID $($process.Id), menunggu server di http://127.0.0.1:$E2EPort ..."

    $deadline = (Get-Date).AddSeconds(120)
    $ready = $false
    $lastReport = (Get-Date)
    while ((Get-Date) -lt $deadline) {
      $status = Get-HttpStatus $E2EPort ""
      if ($status -gt 0) {
        $observed += $status
        $ready = $true
        break
      }
      $process.Refresh()
      if ($process.HasExited) {
        throw "proses dev-safe.ps1 berhenti lebih awal.`n$(& $diagnose)"
      }
      if (((Get-Date) - $lastReport).TotalSeconds -ge 5) {
        Write-Host "  ... masih menunggu (PID $($process.Id) hidup)"
        $lastReport = Get-Date
      }
      Start-Sleep -Milliseconds 500
    }
    if (-not $ready) {
      throw "server tidak menjawab dalam 120 detik.`n$(& $diagnose)"
    }

    $anonymous = Get-HttpStatus $E2EPort ""
    $authorized = Get-HttpStatus $E2EPort "opencode:$password"
    $addresses = Get-ListenerAddresses $E2EPort

    Assert-True ($anonymous -eq 401) "tanpa kredensial dijawab $anonymous, harusnya 401.`n$(& $diagnose)"
    Assert-True ($authorized -eq 200) "dengan kredensial dijawab $authorized, harusnya 200.`n$(& $diagnose)"
    Assert-True ($addresses -contains "127.0.0.1") "tidak mendengarkan di 127.0.0.1 (alamat: $($addresses -join ', '))"
    Assert-True (-not ($addresses -contains "0.0.0.0")) "mendengarkan di 0.0.0.0 (alamat: $($addresses -join ', '))"

    $captured = ((Get-Content $outFile -Raw -ErrorAction SilentlyContinue) + "`n" + (Get-Content $errFile -Raw -ErrorAction SilentlyContinue))
    Assert-True (-not ($captured -match "unsecured")) "masih ada peringatan 'unsecured' padahal password diset.`n$(& $diagnose)"
    Assert-True ($captured -match "http://localhost:$E2EPort") "banner dev-safe.ps1 tidak menampilkan URL localhost:$E2EPort.`n$(& $diagnose)"
  } finally {
    if ($process) {
      $process.Refresh()
      if (-not $process.HasExited) { & taskkill /PID $process.Id /T /F 2>&1 | Out-Null }
    }
    Remove-Item -LiteralPath $outFile, $errFile -ErrorAction SilentlyContinue
    if ($null -eq $previousPassword) {
      Remove-Item Env:OPENCODE_SERVER_PASSWORD -ErrorAction SilentlyContinue
    } else {
      $env:OPENCODE_SERVER_PASSWORD = $previousPassword
    }
  }
}

if ($IncludeE2E -and -not $e2eCommand) {
  Write-Host ""
  Write-Host "  [SKIP] Uji e2e: '$Opencode' tidak ada di PATH." -ForegroundColor Yellow
  Write-Host "         Pasang dulu: npm i -g opencode-ai@latest, atau pakai -Opencode <path>" -ForegroundColor DarkGray
}

# --- Ringkasan -------------------------------------------------------------
# --- 11. Mode -WithDevUi (Vite diganti shim palsu) --------------------------
# Yang diuji: script menunggu server benar-benar siap sebelum UI dijalankan,
# meneruskan --host 127.0.0.1 (menimpa host 0.0.0.0 di vite.config.ts), dan
# membiarkan hanya 127.0.0.1 yang mendengarkan. Vite asli diganti shim .cmd
# supaya tidak perlu `bun install`.
$repoRootForUi = Split-Path -Parent $PSScriptRoot
$viteShimCandidates = @(
  (Join-Path $repoRootForUi "node_modules\.bin\vite.cmd"),
  (Join-Path $repoRootForUi "packages\app\node_modules\.bin\vite.cmd")
)
$withDevUiSkip = $e2eSkip -or (($viteShimCandidates | Where-Object { Test-Path $_ }).Count -gt 0)

Test-Case "-WithDevUi: tunggu server siap, jalankan Vite dengan --host 127.0.0.1, lalu bereskan" -Skip:$withDevUiSkip {
  $shimDir = Join-Path $repoRootForUi "packages\app\node_modules\.bin"
  $shim = Join-Path $shimDir "vite.cmd"
  $marker = Join-Path ([System.IO.Path]::GetTempPath()) ("vite-stub-" + [guid]::NewGuid().ToString("N") + ".txt")
  $devUiPort = 3011
  $serverPort = $E2EPort + 1
  $password = "ci-" + [guid]::NewGuid().ToString("N").Substring(0, 8)
  $previousPassword = $env:OPENCODE_SERVER_PASSWORD
  $outFile = [System.IO.Path]::GetTempFileName()
  $errFile = [System.IO.Path]::GetTempFileName()
  $devSafe = $null

  New-Item -ItemType Directory -Force -Path $shimDir | Out-Null
  # Shim ini mencatat argumen yang diterimanya, lalu menggantung sampai dimatikan.
  @(
    "@echo off",
    "echo started args: %* > `"$marker`"",
    ":loop",
    "ping -n 2 127.0.0.1 >nul",
    "goto loop"
  ) | Set-Content -Path $shim -Encoding ASCII

  $arguments = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $Target, "-NonInteractive",
    "-WithDevUi", "-DevUiPort", "$devUiPort", "-Port", "$serverPort", "-Opencode", $e2eTarget)
  $line = ($arguments | ForEach-Object { Quote-Arg $_ }) -join " "

  try {
    $env:OPENCODE_SERVER_PASSWORD = $password
    $devSafe = Start-Process -FilePath (Get-ShellExe) -ArgumentList $line -NoNewWindow -PassThru `
      -RedirectStandardOutput $outFile -RedirectStandardError $errFile
    Write-Host "  proses dev-safe PID $($devSafe.Id), menunggu shim Vite dijalankan ..."

    $deadline = (Get-Date).AddSeconds(150)
    while ((Get-Date) -lt $deadline -and -not (Test-Path $marker)) {
      $devSafe.Refresh()
      if ($devSafe.HasExited) {
        $captured = ((Get-Content $outFile -Raw -ErrorAction SilentlyContinue) + "`n" + (Get-Content $errFile -Raw -ErrorAction SilentlyContinue))
        throw "dev-safe.ps1 berhenti sebelum menjalankan Vite (kode $($devSafe.ExitCode)).`n$captured"
      }
      Start-Sleep -Milliseconds 500
    }
    if (-not (Test-Path $marker)) {
      $captured = ((Get-Content $outFile -Raw -ErrorAction SilentlyContinue) + "`n" + (Get-Content $errFile -Raw -ErrorAction SilentlyContinue))

      # Uji shim-nya langsung: kalau pun dijalankan manual tidak menulis marker,
      # berarti masalahnya di shim, bukan di dev-safe.ps1.
      $stubProbe = "belum diuji"
      try {
        $probe = Start-Process -FilePath "cmd.exe" -PassThru -WindowStyle Hidden `
          -ArgumentList @("/c", (Quote-Arg $shim), "--host", "127.0.0.1", "--port", "$devUiPort")
        Start-Sleep -Seconds 3
        $madeMarker = Test-Path $marker
        & taskkill /PID $probe.Id /T /F 2>&1 | Out-Null
        Remove-Item -LiteralPath $marker -ErrorAction SilentlyContinue
        $stubProbe = if ($madeMarker) { "shim jalan sendiri dan MENULIS marker (berarti masalah di dev-safe.ps1)" } else { "shim TIDAK menulis marker walau dijalankan langsung (masalah di shim)" }
      } catch {
        $stubProbe = "gagal menguji shim langsung: $($_.Exception.Message)"
      }

      $tail = $captured
      if ($tail.Length -gt 1200) { $tail = "...(dipotong)...`n" + $tail.Substring($tail.Length - 1200) }
      throw "shim Vite tidak dijalankan setelah 150 detik.`nprobe shim: $stubProbe`nshim: $shim (ada: $(Test-Path $shim))`nmarker: $marker`nekor keluaran:`n$tail"
    }

    $markerText = (Get-Content $marker -Raw).Trim()
    $captured = ((Get-Content $outFile -Raw -ErrorAction SilentlyContinue) + "`n" + (Get-Content $errFile -Raw -ErrorAction SilentlyContinue))
    Write-Host "  shim Vite: $markerText"

    Assert-True ($markerText -match "--host 127\.0\.0\.1") "Vite dijalankan tanpa --host 127.0.0.1: $markerText"
    Assert-True ($markerText -match "--port $devUiPort") "Vite dijalankan tanpa --port ${devUiPort}: $markerText"
    Assert-True ($captured -match "Server siap di http://127\.0\.0\.1:$serverPort") "script tidak menunggu server siap sebelum UI"
    Assert-True ($captured -match "Mode dipaksa jadi") "mode tidak dipaksa ke serve"

    $addresses = Get-ListenerAddresses $serverPort
    Assert-True ($addresses -contains "127.0.0.1") "server tidak mendengarkan di 127.0.0.1 (alamat: $($addresses -join ', '))"
    Assert-True (-not ($addresses -contains "0.0.0.0")) "server mendengarkan di 0.0.0.0 (alamat: $($addresses -join ', '))"

    # Matikan seperti Ctrl+C, lalu pastikan anak-anaknya ikut mati.
    & taskkill /PID $devSafe.Id /T /F 2>&1 | Out-Null
    $devSafe.WaitForExit(15000) | Out-Null
    Start-Sleep -Seconds 2
    $leftover = Get-ListenerAddresses $serverPort
    Assert-True ($leftover.Count -eq 0) "masih ada yang mendengarkan di port $serverPort setelah proses dimatikan: $($leftover -join ', ')"
  } finally {
    if ($devSafe) {
      $devSafe.Refresh()
      if (-not $devSafe.HasExited) { & taskkill /PID $devSafe.Id /T /F 2>&1 | Out-Null }
    }
    Remove-Item -LiteralPath $shim, $marker, $outFile, $errFile -ErrorAction SilentlyContinue
    # Rapikan direktori yang kita buat sendiri, hanya kalau benar-benar kosong.
    foreach ($dir in @($shimDir, (Split-Path -Parent $shimDir))) {
      if ((Test-Path $dir) -and -not (Get-ChildItem $dir -Force -ErrorAction SilentlyContinue)) {
        Remove-Item -LiteralPath $dir -Force -ErrorAction SilentlyContinue
      }
    }
    if ($null -eq $previousPassword) {
      Remove-Item Env:OPENCODE_SERVER_PASSWORD -ErrorAction SilentlyContinue
    } else {
      $env:OPENCODE_SERVER_PASSWORD = $previousPassword
    }
  }
}

$passed = ($script:results | Where-Object Status -eq "PASS").Count
$failed = ($script:results | Where-Object Status -eq "FAIL").Count
$skipped = ($script:results | Where-Object Status -eq "SKIP").Count

Write-Head "Ringkasan: $passed lulus, $failed gagal, $skipped dilewati"
foreach ($item in $script:results) {
  $color = if ($item.Status -eq "PASS") { "Green" } elseif ($item.Status -eq "FAIL") { "Red" } else { "Yellow" }
  Write-Host ("  {0,-5} {1} {2}" -f $item.Status, $item.Name, $(if ($item.Detail) { "($($item.Detail))" } else { "" })) -ForegroundColor $color
}

$summaryLines = $null
if ($env:GITHUB_STEP_SUMMARY) {
  $lines = @()
  $lines += "## Uji dev-safe.ps1 (Windows)"
  $lines += ""
  $lines += "Runner: ``$([System.Environment]::OSVersion.VersionString)`` / PowerShell ``$($PSVersionTable.PSVersion)``"
  $lines += ""
  $lines += "| # | Uji | Hasil | Catatan |"
  $lines += "| --- | --- | --- | --- |"
  $index = 0
  foreach ($item in $script:results) {
    $index++
    $badge = if ($item.Status -eq "PASS") { "lulus" } elseif ($item.Status -eq "FAIL") { "GAGAL" } else { "dilewati" }
    # Baris baru akan merusak tabel Markdown, jadi diratakan dulu.
    $detail = (($item.Detail -replace "\r?\n", " ") -replace "\|", "\|").Trim()
    $lines += "| $index | $($item.Name) | $badge | $detail |"
  }
  $lines += ""
  $lines += "**$passed lulus, $failed gagal, $skipped dilewati.**"
  $summaryLines = $lines -join "`n"
  Add-Content -Path $env:GITHUB_STEP_SUMMARY -Value $summaryLines
}

# Ringkasan juga disimpan sebagai berkas supaya bisa diunduh/diarsipkan.
if ($summaryLines) {
  $summaryRoot = if ($env:GITHUB_WORKSPACE) { $env:GITHUB_WORKSPACE } else { [System.IO.Path]::GetTempPath() }
  $summaryFile = Join-Path $summaryRoot "dev-safe-summary.md"
  Set-Content -Path $summaryFile -Value $summaryLines -Encoding UTF8
  Write-Host ""
  Write-Host "Ringkasan ditulis ke: $summaryFile" -ForegroundColor DarkGray
}

Write-Host ""
if ($failed -gt 0) {
  $evidenceRoot = if ($env:GITHUB_WORKSPACE) { $env:GITHUB_WORKSPACE } else { [System.IO.Path]::GetTempPath() }
  $evidence = Join-Path $evidenceRoot "dev-safe-failures.txt"
  $blocks = foreach ($item in ($script:results | Where-Object Status -eq "FAIL")) {
    "### $($item.Name)`n$($item.Detail)`n"
  }
  Set-Content -Path $evidence -Value ($blocks -join "`n") -Encoding UTF8
  Write-Host "Detail kegagalan juga ditulis ke: $evidence" -ForegroundColor DarkGray

  if ($env:GITHUB_ACTIONS -eq "true") {
    foreach ($item in ($script:results | Where-Object Status -eq "FAIL")) {
      # Anotasi hanya satu baris dan ada batas panjang, jadi detail panjang
      # dipecah menjadi beberapa anotasi supaya semuanya terlihat di halaman run.
      $message = (($item.Name + " - " + $item.Detail) -replace "\r?\n", " | ").Trim()
      $size = 800
      $total = [Math]::Ceiling($message.Length / $size)
      if ($total -lt 1) { $total = 1 }
      if ($total -gt 6) { $total = 6 }
      for ($i = 0; $i -lt $total; $i++) {
        $start = $i * $size
        $length = [Math]::Min($size, $message.Length - $start)
        if ($length -le 0) { break }
        $part = $message.Substring($start, $length)
        Write-Host "::error title=dev-safe gagal ($($i + 1)/$total)::$part"
      }
    }
  }
  exit 1
}
exit 0
