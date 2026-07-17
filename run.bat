@echo off
rem ============================================================
rem  ListAgent Test Suite launcher
rem  Runs the built release exe if present; otherwise falls back
rem  to dev mode (cargo tauri dev).
rem  NOTE: keep this file ASCII-only -- cmd.exe parses batch
rem  files in the OEM codepage and UTF-8 text breaks parsing.
rem ============================================================
setlocal
cd /d "%~dp0"

set "RELEASE_EXE=src-tauri\target\release\agent-tester.exe"

if exist "%RELEASE_EXE%" (
    echo [run.bat] Launching release build: %RELEASE_EXE%
    start "" "%RELEASE_EXE%"
    goto :eof
)

echo [run.bat] Release build not found, starting dev mode. First compile takes a few minutes...
where cargo >nul 2>nul
if errorlevel 1 (
    echo [run.bat] ERROR: cargo not found. Install the Rust toolchain first: https://rustup.rs
    pause
    exit /b 1
)

cargo tauri dev
if errorlevel 1 (
    echo.
    echo [run.bat] cargo tauri dev failed. If tauri-cli is missing, run: cargo install tauri-cli
    pause
    exit /b 1
)
