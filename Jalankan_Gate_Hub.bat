@echo off
title AmbilTiketnya - Local Gate Hub
cd /d "%~dp0"
echo =======================================================
echo    AMBILTIKETNYA - LOCAL GATE HUB (POSKO GERBANG LOKAL)
echo =======================================================
echo Memulai server posko lokal...
echo Membuka browser Dashboard Posko Gerbang...
start http://localhost:8080
python gate_hub.py
pause
