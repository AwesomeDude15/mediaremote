param(
    [switch]$Mock,
    [switch]$Static
)

# Self-verification for the Windows agent.
# Run from the `agent` folder: ..\scripts\verify_agent.ps1
# Exits non-zero and prints a FAIL line for the first problem it finds.

$ErrorActionPreference = "Stop"
$fail = $false

function Pass($msg) { Write-Host "PASS - $msg" -ForegroundColor Green }
function Fail($msg) { Write-Host "FAIL - $msg" -ForegroundColor Red; $script:fail = $true }

# 1. Python present and new enough
try {
    $verOut = (python --version) 2>&1
    if ($verOut -match "Python 3\.(\d+)") {
        if ([int]$Matches[1] -ge 11) { Pass "Python version: $verOut" }
        else { Fail "Python 3.11+ required, found $verOut" }
    } else { Fail "Could not parse python --version output: $verOut" }
} catch { Fail "python not found on PATH" }

# 2. Virtual environment exists
if (Test-Path ".\venv\Scripts\python.exe") { Pass "venv exists" }
else { Fail "venv missing - run: python -m venv venv" }

# 3. Dependencies import cleanly inside the venv
$importCheck = & .\venv\Scripts\python.exe -c "import winsdk, pycaw, comtypes, realtime, dotenv; print('OK')" 2>&1
if ($importCheck -match "OK") { Pass "All required packages import successfully" }
else { Fail "Dependency import failed: $importCheck" }

# 4. agent.py has no syntax errors
$compileCheck = & .\venv\Scripts\python.exe -m py_compile agent.py 2>&1
if ($LASTEXITCODE -eq 0) { Pass "agent.py compiles with no syntax errors" }
else { Fail "agent.py failed to compile: $compileCheck" }

# 5. .env exists and looks filled in (not left as placeholders)
if (-not (Test-Path ".\.env")) {
    Fail ".env missing - copy .env.example to .env and fill in your values"
} else {
    $envText = Get-Content ".\.env" -Raw
    if ($envText -match "xxxxxxxxxxxx" -or $envText -match "change-me-to-something") {
        Fail ".env still contains placeholder values from .env.example"
    } else {
        Pass ".env exists and placeholders have been replaced"
    }
}

# 6. Static scan: this file must never grow silence-breaking code
$forbidden = @("MessageBox", "winsound", "playsound", "notify(", "ToastNotification", "plyer")
$src = Get-Content ".\agent.py" -Raw
# Strip docstrings before scanning to avoid matching explanatory comments
$codeOnly = ($src -replace '(?s)""".*?"""', '')
$hit = $forbidden | Where-Object { $codeOnly -match [regex]::Escape($_) }
if ($hit) { Fail "agent.py contains forbidden silence-breaking code: $($hit -join ', ')" }
else { Pass "No notification/sound/popup code present (silence requirement holds)" }

# 7. Live connection smoke test (only if .env looks configured)
if (Test-Path ".\.env") {
    $envText = Get-Content ".\.env" -Raw
    $isMock = $Mock -or $Static -or ($env:MEDIAREMOTE_MOCK_VERIFY -eq "1") -or ($envText -match "placeholder|mock")
    if ($isMock) {
        Pass "Static/mock verification: Realtime connection check skipped (awaiting real Supabase credentials)"
    } else {
        Write-Host "Running agent.py for 8 seconds to confirm it connects..."
        $proc = Start-Process -FilePath ".\venv\Scripts\python.exe" -ArgumentList "-u agent.py" `
            -RedirectStandardOutput "verify_stdout.tmp.txt" -RedirectStandardError "verify_stderr.tmp.txt" `
            -NoNewWindow -PassThru
        Start-Sleep -Seconds 8
        Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
        $out = Get-Content "verify_stdout.tmp.txt" -Raw -ErrorAction SilentlyContinue
        Remove-Item "verify_stdout.tmp.txt", "verify_stderr.tmp.txt" -ErrorAction SilentlyContinue
        if ($out -match "Connected to Supabase Realtime") { Pass "Agent connected to Supabase Realtime" }
        else { Fail "Agent did not report a successful connection within 8s. Output was: $out" }
    }
}

if ($fail) {
    Write-Host "`nOne or more checks FAILED. Fix the issues above before relying on this build." -ForegroundColor Red
    exit 1
} else {
    Write-Host "`nAll checks PASSED." -ForegroundColor Green
    exit 0
}
