$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
try {
    $python = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
    if (-not (Test-Path $python)) {
        $basePython = Join-Path $env:LOCALAPPDATA 'Programs\Python\Python311\python.exe'
        $launcher = Get-Command py -ErrorAction SilentlyContinue
        if ($launcher) {
            $found = & $launcher.Source -3.11 -c 'import sys; print(sys.executable)' 2>$null
            if ($LASTEXITCODE -eq 0) { $basePython = "$found".Trim() }
        }
        if (-not (Test-Path $basePython)) {
            Write-Host 'Installing Python 3.11 (first run only)...'
            [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
            $installer = Join-Path $env:TEMP 'azmoon-python-3.11.9.exe'
            Invoke-WebRequest 'https://www.python.org/ftp/python/3.11.9/python-3.11.9-amd64.exe' -OutFile $installer
            $signature = Get-AuthenticodeSignature $installer
            if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'Python Software Foundation') {
                throw 'Python installer signature verification failed.'
            }
            $proc = Start-Process $installer -ArgumentList '/quiet InstallAllUsers=0 PrependPath=0 Include_launcher=0 Include_test=0' -Wait -PassThru
            if ($proc.ExitCode -notin @(0, 3010)) { throw "Python installation failed: $($proc.ExitCode)" }
            if (-not (Test-Path $basePython)) { throw 'Python was not found after installation.' }
        }
        & $basePython -m venv .venv
        if ($LASTEXITCODE -ne 0) { throw 'Could not create Python environment.' }
    }
    $requirements = Join-Path $PSScriptRoot 'requirements.txt'
    $fingerprint = (Get-FileHash $requirements -Algorithm SHA256).Hash
    $marker = Join-Path $PSScriptRoot '.venv\azmoon-requirements.sha256'
    if (-not (Test-Path $marker) -or (Get-Content $marker -Raw).Trim() -ne $fingerprint) {
        Write-Host 'Installing dependencies (first run or after an update)...'
        & $python -m pip install -r $requirements
        if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed. Check internet access and retry.' }
        Set-Content $marker $fingerprint -Encoding ASCII
    }
    $configFile = Join-Path $PSScriptRoot 'windows-local.json'
    if (-not (Test-Path $configFile)) {
        $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
        $bytes = New-Object byte[] 32
        $rng.GetBytes($bytes)
        $secret = [Convert]::ToBase64String($bytes)
        $rng.GetBytes($bytes)
        $password = ([BitConverter]::ToString($bytes)).Replace('-', '').Substring(0, 16)
        $rng.Dispose()
        @{ SECRET_KEY = $secret; STAFF_PASSWORD = $password; PORT = 5001 } |
            ConvertTo-Json | Set-Content $configFile -Encoding UTF8
    }
    $config = Get-Content $configFile -Raw | ConvertFrom-Json
    if (-not $config.SECRET_KEY -or -not $config.STAFF_PASSWORD) { throw 'Invalid windows-local.json. Restore your configuration backup.' }
    $env:SECRET_KEY = $config.SECRET_KEY
    $env:STAFF_PASSWORD = $config.STAFF_PASSWORD
    $env:PORT = [string]$config.PORT
    $env:DATA_DIR = Join-Path $PSScriptRoot 'data'
    Write-Host ''
    Write-Host "Open: http://localhost:$($env:PORT)"
    Write-Host "Staff password: $($env:STAFF_PASSWORD)"
    Write-Host 'Settings: windows-local.json | Records: data'
    Write-Host 'Keep this window open. Press Ctrl+C to stop.'
    & $python app.py
    if ($LASTEXITCODE -ne 0) { throw 'Server stopped with an error.' }
} catch {
    Write-Host "ERROR: $_" -ForegroundColor Red
    exit 1
}
