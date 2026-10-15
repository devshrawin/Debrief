@echo off
rem Starts Ollama and the local Whisper server for Debrief. Extra options are passed on, for example: start-local.bat -Model gemma3:4b
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-local.ps1" %*
pause
