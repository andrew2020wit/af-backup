@echo off
rem Starts af-backup for the destination folder this file lies in, in its own console window,
rem and waits for a key before the window closes, so that the result stays readable.
rem Copy this file into the destination folder next to af-backup-task.json and double-click it.
rem If Ctrl+C asks "Terminate batch job (Y/N)?", answer N to see the result.

cd /d "%~dp0"
call af-backup
set "AF_BACKUP_EXIT_CODE=%ERRORLEVEL%"
echo.
echo af-backup finished with exit code %AF_BACKUP_EXIT_CODE% (0 - success; see the lines above).
pause
exit /b %AF_BACKUP_EXIT_CODE%
