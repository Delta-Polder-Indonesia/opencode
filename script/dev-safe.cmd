@echo off
rem ---------------------------------------------------------------------------
rem  dev-safe.cmd - klik dua kali untuk menjalankan opencode dengan aman.
rem
rem  Yang dijalankan: script\dev-safe.ps1 dengan mode paling aman:
rem    - bind 127.0.0.1 (hanya PC ini, tidak terlihat dari Wi-Fi/LAN)
rem    - password diminta lewat prompt (tidak terlihat saat diketik)
rem    - password dibersihkan lagi setelah server berhenti
rem
rem  Contoh pemakaian dari Command Prompt:
rem    dev-safe.cmd                          -> server + UI satu port
rem    dev-safe.cmd -WithDevUi               -> server + Vite dev UI (:3000)
rem    dev-safe.cmd -FromSource -WithDevUi   -> dari source checkout ini (butuh bun)
rem    dev-safe.cmd -Verify                  -> hanya periksa, tidak menjalankan server
rem
rem  Butuh PowerShell 5.1 (sudah ada di semua Windows 10/11).
rem ---------------------------------------------------------------------------
setlocal

rem Kerjakan dari root repo, supaya folder proyek defaultnya benar.
cd /d "%~dp0.."

set "PS=powershell"
where pwsh >nul 2>&1 && set "PS=pwsh"

"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0dev-safe.ps1" %*
set "EXITCODE=%ERRORLEVEL%"

echo.
if "%EXITCODE%"=="0" (
  echo Selesai.
) else (
  echo Selesai dengan kode keluar %EXITCODE%.
)
echo Tekan tombol apa saja untuk menutup jendela ini...
pause >nul
