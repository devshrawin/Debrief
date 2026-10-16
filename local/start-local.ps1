<#
  Starts everything Debrief needs to run with no cloud service:
    1. Ollama (writes the minutes), allowed to talk to the Debrief extension and given room to read a whole meeting
    2. a local Whisper server (speech to text) on http://localhost:8000/v1
  then tells you what to set in Debrief. Nothing is downloaded unless you say yes.

  Run it by double-clicking start-local.bat, or:  powershell -ExecutionPolicy Bypass -File local\start-local.ps1
    -Model qwen2.5:7b   the Ollama model for the minutes (any model you have; see "ollama list")
    -RestartOllama      restart Ollama when it is already running without the settings Debrief needs
    -NoPull             do not offer to download the Ollama model
    -Stop               stop the Whisper server this script started
#>
param(
  [string]$Model = 'qwen2.5:7b',
  [int]$Port = 8000,
  [switch]$RestartOllama,
  [switch]$NoPull,
  [switch]$Stop
)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
function Say($text, $color = 'Gray') { Write-Host $text -ForegroundColor $color }
function Ok($text) { Write-Host "[ok]  $text" -ForegroundColor Green }
function Warn($text) { Write-Host "[!]   $text" -ForegroundColor Yellow }

if ($Stop) {
  $c = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($c) { Stop-Process -Id $c.OwningProcess -Force; Ok "Stopped the Whisper server on port $Port." } else { Say "Nothing is listening on port $Port." }
  return
}

# ---- 1. Python that has faster-whisper ----
function Test-Python($exe) {
  try { & $exe -c "import faster_whisper, fastapi, uvicorn, multipart" 2>$null; return ($LASTEXITCODE -eq 0) } catch { return $false }
}
$py = $null
foreach ($c in @("$here\.venv\Scripts\python.exe", "$env:USERPROFILE\Desktop\UR Files\Projects\MalayalamScribe\.venv\Scripts\python.exe", 'python')) {
  if ((Get-Command $c -ErrorAction SilentlyContinue) -and (Test-Python $c)) { $py = $c; break }
}
if (-not $py) {
  Warn 'No Python with faster-whisper was found.'
  Say '  Debrief can make one in local\.venv. This downloads about 150 MB of Python packages, and the first transcription'
  Say '  downloads the Whisper "small" model (about 460 MB).'
  $a = Read-Host '  Download and set it up now? (y/n)'
  if ($a -notmatch '^[yY]') { Say 'Stopped. Install faster-whisper, fastapi, uvicorn and python-multipart in any Python, then run this again.'; return }
  python -m venv "$here\.venv"
  & "$here\.venv\Scripts\python.exe" -m pip install --quiet faster-whisper fastapi "uvicorn[standard]" python-multipart
  $py = "$here\.venv\Scripts\python.exe"
}
Ok "Python with faster-whisper: $py"

# ---- 2. Ollama ----
$env:OLLAMA_ORIGINS = 'chrome-extension://nckojmcchehoejdfklcmllhpekagiddo'
$env:OLLAMA_CONTEXT_LENGTH = '16384'
function Test-Ollama { try { Invoke-RestMethod http://localhost:11434/api/version -TimeoutSec 3 | Out-Null; return $true } catch { return $false } }
function Test-OllamaCors {
  try {
    $r = Invoke-WebRequest http://localhost:11434/v1/models -Headers @{ Origin = 'chrome-extension://nckojmcchehoejdfklcmllhpekagiddo' } -UseBasicParsing -TimeoutSec 5
    return [bool]$r.Headers['Access-Control-Allow-Origin']
  } catch { return $false }
}
function Start-OllamaServe {
  Start-Process -FilePath ollama -ArgumentList 'serve' -WindowStyle Hidden
  for ($i = 0; $i -lt 30 -and -not (Test-Ollama); $i++) { Start-Sleep -Seconds 1 }
}
if (-not (Get-Command ollama -ErrorAction SilentlyContinue)) {
  Warn 'Ollama is not installed. Install it from https://ollama.com and run this again.'
  return
}
if (-not (Test-Ollama)) {
  Say 'Starting Ollama...'
  Start-OllamaServe
} elseif (-not (Test-OllamaCors)) {
  if ($RestartOllama) {
    Say 'Restarting Ollama with the settings Debrief needs...'
    Get-Process -Name 'ollama*' -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Seconds 2
    Start-OllamaServe
  } else {
    Warn 'Ollama is already running, but it refuses requests from browser extensions (it was started without OLLAMA_ORIGINS).'
    Say '  Quit Ollama from the tray icon and run this again, or run it with -RestartOllama to let this script restart it.'
  }
}
if (Test-Ollama) {
  Ok 'Ollama is running'
  if (Test-OllamaCors) { Ok 'Ollama accepts the Debrief extension' } else { Warn 'Ollama still refuses the extension: the minutes will fail inside Chrome until it is restarted with OLLAMA_ORIGINS=chrome-extension://nckojmcchehoejdfklcmllhpekagiddo' }
  $have = (ollama list) -join "`n"
  if ($have -match [regex]::Escape($Model)) { Ok "Ollama model $Model is installed" }
  elseif ($NoPull) { Warn "Ollama model $Model is not installed: ollama pull $Model" }
  else {
    $a = Read-Host "  $Model is not installed. Download it now? It is several GB (y/n)"
    if ($a -match '^[yY]') { ollama pull $Model } else { Warn "Skipped. Pick an installed model in Debrief (Find my installed models) or run: ollama pull $Model" }
  }
} else { Warn 'Could not start Ollama.' }

# ---- 3. Whisper server ----
function Test-Whisper { try { (Invoke-RestMethod "http://127.0.0.1:$Port/health" -TimeoutSec 3).ok } catch { $false } }
if (Test-Whisper) { Ok "Whisper server already running on port $Port" }
else {
  Say 'Starting the Whisper server...'
  $env:PORT = "$Port"
  $small = Get-ChildItem "$env:USERPROFILE\.cache\huggingface\hub\models--Systran--faster-whisper-small" -ErrorAction SilentlyContinue
  if ($small) { $env:HF_HUB_OFFLINE = '1' }
  Start-Process -FilePath $py -ArgumentList "`"$here\whisper_server.py`"" -WindowStyle Minimized -RedirectStandardError "$env:TEMP\debrief-whisper.log"
  for ($i = 0; $i -lt 40 -and -not (Test-Whisper); $i++) { Start-Sleep -Seconds 1 }
  if (Test-Whisper) { Ok "Whisper server is running on port $Port" } else { Warn "The Whisper server did not start. Details: $env:TEMP\debrief-whisper.log" }
}
if (Test-Whisper) {
  $h = Invoke-RestMethod "http://127.0.0.1:$Port/health"
  $names = ($h.models.PSObject.Properties | Where-Object { $_.Value } | ForEach-Object { $_.Name }) -join ', '
  Ok "Whisper models available: $names"
}

# ---- 4. what to set in Debrief ----
Write-Host ''
Say 'In Debrief (Settings):' 'Cyan'
Say "  Speech to text:  provider Whisper-compatible, press 'Use a local Whisper server', model: auto   (Malayalam is picked automatically)"
Say "  Minutes:         provider OpenAI-compatible, press 'Use Ollama on this PC', 'Find my installed models', choose $Model"
Say "  Minutes mode:    Quick on a laptop without a graphics card (Thorough makes several model calls)"
Say "  General:         Languages spoken in meetings, for example English + Hindi"
Say "  Voices:          everything stays on this computer (voice recognition is always local)"
Write-Host ''
Say 'To test the whole chain from here:  node local\check-local.mjs "your-recording-16k.wav" --seconds 60' 'Cyan'
Say 'To stop the Whisper server later:    start-local.bat -Stop' 'Cyan'
