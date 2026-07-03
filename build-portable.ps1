# ============================================================
#  Gom AVT Chat Bot thanh bundle portable (giai nen la chay).
#  Copy: app + node_modules + node.exe + Ollama + model (chi model can) -> zip.
#  Chay: powershell -ExecutionPolicy Bypass -File build-portable.ps1
# ============================================================
$ErrorActionPreference = 'Stop'
$src = $PSScriptRoot
$stageRoot = 'd:\avt-portable'
$stage = Join-Path $stageRoot 'AVT-ChatBot'
$zip = 'd:\AVT-ChatBot-portable.zip'
$models = @('qwen2.5:3b', 'bge-m3')   # chi goi model can thiet cho gon

function Info($m) { Write-Host "[BUILD] $m" -ForegroundColor Cyan }

if (Test-Path $stageRoot) { Remove-Item $stageRoot -Recurse -Force }
New-Item -ItemType Directory -Path $stage -Force | Out-Null

# ---- 1) App code + node_modules ----
Info "Copy code + node_modules..."
$items = @('server.js','db.js','parse.js','env.js','package.json','package-lock.json','.env.example','public','node_modules','start.ps1','Chatbot.bat','CaiTuKhoiDong.bat','GoTuKhoiDong.bat')
foreach ($it in $items) {
  $p = Join-Path $src $it
  if (Test-Path $p) { Copy-Item $p -Destination $stage -Recurse -Force }
}

# ---- 2) Node portable ----
Info "Copy Node..."
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if ($node) { New-Item -ItemType Directory -Path (Join-Path $stage 'node') -Force | Out-Null; Copy-Item $node -Destination (Join-Path $stage 'node\node.exe') -Force }
else { Write-Warning "Khong tim thay node.exe" }

# ---- 3) Ollama (toan bo thu muc chuong trinh) ----
Info "Copy Ollama..."
$ollama = (Get-Command ollama -ErrorAction SilentlyContinue).Source
if ($ollama) {
  $ollamaDir = Split-Path -Parent $ollama
  Copy-Item $ollamaDir -Destination (Join-Path $stage 'ollama') -Recurse -Force
} else { Write-Warning "Khong tim thay ollama" }

# ---- 4) Model (chi copy model can: manifest + blob lien quan) ----
Info "Copy model: $($models -join ', ')..."
$mroot = if ($env:OLLAMA_MODELS) { $env:OLLAMA_MODELS } else { Join-Path $env:USERPROFILE '.ollama\models' }
Info "Thu muc model nguon: $mroot"
$destM = Join-Path $stage 'models'
foreach ($m in $models) {
  $name, $tag = $m.Split(':'); if (-not $tag) { $tag = 'latest' }
  $man = Join-Path $mroot "manifests\registry.ollama.ai\library\$name\$tag"
  if (-not (Test-Path $man)) { Write-Warning "Khong thay manifest $m"; continue }
  $destMan = Join-Path $destM "manifests\registry.ollama.ai\library\$name\$tag"
  New-Item -ItemType Directory -Path (Split-Path $destMan) -Force | Out-Null
  Copy-Item $man -Destination $destMan -Force
  $j = Get-Content $man -Raw | ConvertFrom-Json
  $digests = @($j.config.digest) + ($j.layers | ForEach-Object { $_.digest })
  New-Item -ItemType Directory -Path (Join-Path $destM 'blobs') -Force | Out-Null
  foreach ($d in $digests) {
    $blob = 'sha256-' + $d.Split(':')[1]
    $bp = Join-Path $mroot "blobs\$blob"
    if (Test-Path $bp) { Copy-Item $bp -Destination (Join-Path $destM "blobs\$blob") -Force }
  }
}

# ---- 5) Huong dan + don pgdata (DB tao moi khi chay) ----
Remove-Item (Join-Path $stage 'pgdata') -Recurse -Force -ErrorAction SilentlyContinue
Set-Content -Path (Join-Path $stage 'DOC-README.txt') -Encoding UTF8 -Value @"
AVT Chat Bot - ban portable (khong can cai Node/Docker/Ollama)

CHAY:
  - Bam dup Chatbot.bat  -> tu bat Ollama + web, mo trinh duyet.
  - May co GPU NVIDIA se tu chay nhanh hon.

TU KHOI DONG KHI MO MAY (tuy chon, lam 1 lan):
  - Chuot phai CaiTuKhoiDong.bat -> Run as administrator.
  - Tu do may bat len la chatbot tu chay (khong can dang nhap).
  - Go bo: chuot phai GoTuKhoiDong.bat -> Run as administrator.

CAI THANH APP (tuy chon):
  - Mo http://localhost:3000 bang Edge/Chrome -> bam nut Install tren thanh dia chi.

Du lieu nam trong thu muc 'pgdata' (tu tao lan dau).
"@

Info "Nen zip (co the mat vai phut)..."
if (Test-Path $zip) { Remove-Item $zip -Force }
$tar = Join-Path $env:SystemRoot 'System32\tar.exe'
& $tar -a -c -f $zip -C $stageRoot 'AVT-ChatBot'

$sz = [math]::Round((Get-Item $zip).Length / 1GB, 2)
Info "XONG: $zip  ($sz GB)"
