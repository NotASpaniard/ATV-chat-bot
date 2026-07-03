# ============================================================
#  AVT Chat Bot - khoi dong (KHONG can Docker; DB nhung PGlite)
#  Tu bat: Ollama -> Web app. Ho tro ban portable (node/ollama di kem).
# ============================================================
$ErrorActionPreference = 'Continue'
$root = $PSScriptRoot
if (-not $root) { try { $root = Split-Path -Parent ([System.Diagnostics.Process]::GetCurrentProcess().MainModule.FileName) } catch {} }
if (-not $root) { $root = (Get-Location).Path }
Set-Location -Path $root
$AUTO = ($args -contains 'auto')

function Info($m) { Write-Host "[AVT] $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "[OK ] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "[!! ] $m" -ForegroundColor Yellow }
function Test-Ollama { try { Invoke-WebRequest -Uri 'http://localhost:11434' -TimeoutSec 3 -UseBasicParsing | Out-Null; return $true } catch { return $false } }

# Tim node/ollama theo duong dan tuyet doi (hoat dong ca khi chay duoi SYSTEM - khong co PATH cua user)
$nodeExe = Join-Path $root 'node\node.exe'
if (-not (Test-Path $nodeExe)) {
  $c = @('C:\Program Files\nodejs\node.exe', 'C:\Program Files (x86)\nodejs\node.exe') | Where-Object { Test-Path $_ } | Select-Object -First 1
  $nodeExe = if ($c) { $c } else { 'node' }
}
$ollamaExe = Join-Path $root 'ollama\ollama.exe'
if (Test-Path $ollamaExe) {
  $env:OLLAMA_MODELS = Join-Path $root 'models'   # ban portable: dung model di kem
} else {
  $c = @("$env:LOCALAPPDATA\Programs\Ollama\ollama.exe",
         'C:\Users\nguye\AppData\Local\Programs\Ollama\ollama.exe',
         "$env:ProgramFiles\Ollama\ollama.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
  $ollamaExe = if ($c) { $c } else { 'ollama' }
}
# Model that nam o D:\ollama-models (khi chay duoi SYSTEM khong co bien cua user)
if (-not $env:OLLAMA_MODELS -and (Test-Path 'D:\ollama-models')) { $env:OLLAMA_MODELS = 'D:\ollama-models' }

# ---------- 1) OLLAMA ----------
Info "Kiem tra Ollama..."
if (-not (Test-Ollama)) {
  Info "Ollama chua chay - dang bat..."
  try { Start-Process -FilePath $ollamaExe -ArgumentList 'serve' -WindowStyle Hidden } catch { Warn "Khong bat duoc Ollama." }
  for ($i = 0; $i -lt 20; $i++) { Start-Sleep -Seconds 2; if (Test-Ollama) { break } }
}
if (Test-Ollama) { Ok "Ollama san sang." } else { Warn "Ollama chua len - chat co the loi." }

# ---------- 2) WEB APP (DB PGlite tu tao, khong can Docker) ----------
Info "Khoi dong web app..."
if ($AUTO) { $node = Start-Process -FilePath $nodeExe -ArgumentList 'server.js' -PassThru -WindowStyle Hidden }
else       { $node = Start-Process -FilePath $nodeExe -ArgumentList 'server.js' -PassThru -NoNewWindow }
# cho web thuc su san sang roi moi mo trinh duyet -> mo ra la dung duoc ngay
$ready = $false
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Seconds 1
  try { Invoke-WebRequest 'http://localhost:3000/api/config' -TimeoutSec 3 -UseBasicParsing | Out-Null; $ready = $true; break } catch {}
}
if ($ready) {
  Ok "Web da san sang: http://localhost:3000"
  if (-not $AUTO) { Start-Process 'http://localhost:3000' }
} else {
  Warn "Web chua len sau 40s (co the cong 3000 dang bi chiem, hoac Ollama chua san sang)."
}
Write-Host "------------------------------------------------------------"
Write-Host "AVT Chat Bot dang chay. DONG cua so nay de TAT." -ForegroundColor Green
try { Wait-Process -Id $node.Id } finally { Stop-Process -Id $node.Id -ErrorAction SilentlyContinue }
