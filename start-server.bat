@echo off
echo Starting Track Your Fitness...
echo.

REM Try Python 3 first
python --version >nul 2>&1
if %errorlevel% == 0 (
    echo Server running at http://localhost:8080
    echo Open your browser and go to: http://localhost:8080
    echo Press Ctrl+C to stop.
    echo.
    start "" "http://localhost:8080"
    python -m http.server 8080
    goto end
)

REM Try Python 3 (py launcher)
py --version >nul 2>&1
if %errorlevel% == 0 (
    echo Server running at http://localhost:8080
    start "" "http://localhost:8080"
    py -m http.server 8080
    goto end
)

REM Try Node.js npx serve
npx --version >nul 2>&1
if %errorlevel% == 0 (
    echo Server running at http://localhost:8080
    start "" "http://localhost:8080"
    npx serve -l 8080 .
    goto end
)

REM Nothing found
echo ERROR: Python or Node.js not found.
echo Please install Python from https://python.org
echo Then double-click this file again.
pause

:end
