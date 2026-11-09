@echo off
rem =====================================================================
rem  Tianji Archive - client-lite configurator launcher
rem
rem  What this does
rem    Sets the console to UTF-8, locates the PowerShell script that
rem    ships next to this file, and runs it in wizard mode:
rem    write config.json, create a desktop shortcut, run the 3 checks.
rem
rem  WHY THIS FILE IS PURE ASCII (important, do not "fix" it)
rem    cmd.exe mis-computes line offsets when a batch file contains
rem    multi-byte UTF-8 characters: lines after a Chinese text line get
rem    parsed from the wrong byte offset and their fragments are executed
rem    as commands ("'xxx' is not recognized"). Reproduced on Windows 11
rem    with three variants: UTF-8 without BOM + chcp, UTF-8 with BOM, and
rem    a self-restarting launcher. All of them corrupt at least one line.
rem    Therefore ALL Chinese UI lives in the sibling .ps1 (UTF-8+BOM), which
rem    PowerShell parses correctly, and this launcher only forwards to it.
rem    chcp 65001 is still set here so the console decodes CJK output
rem    correctly regardless of the machine default code page.
rem
rem  Exit codes (propagated from the PowerShell script)
rem    0 ok    1 config write failed    2 self check failed
rem =====================================================================

chcp 65001 >nul 2>&1
setlocal EnableExtensions

set "BASE_DIR=%~dp0"
set "PS1="
for %%F in ("%BASE_DIR%*.ps1") do if not defined PS1 set "PS1=%%~fF"
if not defined PS1 set "PS1="
if not exist "%PS1%" (
    echo [FAIL] PowerShell script not found next to this file.
    echo        Expected one .ps1 file in the same folder as this .bat
    echo        Folder: %BASE_DIR%
    pause
    exit /b 1
)

where powershell >nul 2>&1
if errorlevel 1 (
    echo [FAIL] Windows PowerShell not found.
    echo        Windows 10 and 11 ship it by default. Use the manual steps
    echo        described in the txt file instead.
    pause
    exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" -Configure
set "RC=%ERRORLEVEL%"

echo.
pause
exit /b %RC%
