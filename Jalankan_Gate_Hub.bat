@echo off
chcp 65001 >nul
set PYTHONIOENCODING=utf-8
title AmbilTiketnya - Local Gate Hub
cd /d "%~dp0"
echo =======================================================
echo    AMBILTIKETNYA - LOCAL GATE HUB (POSKO GERBANG LOKAL)
echo =======================================================
echo Memulai server posko lokal...
start "" "http://localhost:8080"
python gate_hub.py
pause
