@echo off
rem ============================================================
rem  Agent Test Suite - release build
rem  Builds the release exe (and installers) via cargo tauri build.
rem  NOTE: keep this file ASCII-only -- cmd.exe parses batch
rem  files in the OEM codepage and UTF-8 text breaks parsing.
rem ============================================================
setlocal
cd /d "%~dp0"

where cargo >nul 2>nul
if errorlevel 1 (
    echo [build_exe.bat] ERROR: cargo not found. Install the Rust toolchain first: https://rustup.rs
    pause
    exit /b 1
)

echo [build_exe.bat] Building release exe via "cargo tauri build" (this can take a few minutes)...
cd src-tauri
cargo tauri build
set "BUILD_RESULT=%errorlevel%"
cd ..

if not "%BUILD_RESULT%"=="0" (
    echo.
    echo [build_exe.bat] Build failed. If tauri-cli is missing, run: cargo install tauri-cli
    pause
    exit /b 1
)

echo.
echo [build_exe.bat] Build succeeded. Copying exe to project root...
copy /y "src-tauri\target\release\agent-tester.exe" "agent-tester.exe" >nul
if errorlevel 1 (
    echo [build_exe.bat] ERROR: could not copy exe to %~dp0
    pause
    exit /b 1
)

echo   exe:      %~dp0agent-tester.exe
echo   bundles:  src-tauri\target\release\bundle\ (msi / nsis)
pause
