@echo off
rem Computes the size of the backup (af-backup --compute-size) for the destination folder this file lies in,
rem without making the backup, in its own console window, and waits for a key before the window closes.
rem Copy this file into the destination folder next to af-backup-task.json and double-click it.
rem If Ctrl+C asks "Terminate batch job (Y/N)?", answer N to see the result.

cd /d "%~dp0"
call af-backup --compute-size
set "AF_BACKUP_EXIT_CODE=%ERRORLEVEL%"
echo.
echo af-backup --compute-size finished with exit code %AF_BACKUP_EXIT_CODE% (0 - no errors; see the lines above).
pause
exit /b %AF_BACKUP_EXIT_CODE%
