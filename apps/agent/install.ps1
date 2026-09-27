#Requires -RunAsAdministrator
param(
  [string]$ServerUrl = "http://localhost:4000",
  [string]$EnrollmentSecret = "change-me-enrollment-secret",
  [string]$InstallDir = "$env:ProgramFiles\PC Manager Agent"
)

$ErrorActionPreference = "Stop"
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

function Write-Utf8NoBom([string]$Path, [string]$Content) {
  $enc = New-Object System.Text.UTF8Encoding $false
  [System.IO.File]::WriteAllText($Path, $Content, $enc)
}

function Set-ServiceRecovery([string]$Name) {
  if (-not $Name) { return }
  try {
    & sc.exe failure $Name reset= 86400 actions= restart/5000/restart/30000/restart/60000 | Out-Null
    & sc.exe failureflag $Name 1 | Out-Null
  } catch {
    Write-Warning "Could not set SCM recovery on $Name : $_"
  }
}

$helperExeName = "pc-manager-helper.exe"
$exeName = "pc-manager-agent.exe"
$destHelper = Join-Path $InstallDir $helperExeName
$destAgent = Join-Path $InstallDir $exeName

# Official uninstall is helper-then-agent so the watchdog cannot bring the agent back.
if (Test-Path $destHelper) {
  try { & $destHelper stop | Out-Null } catch {}
  try { & $destHelper uninstall | Out-Null } catch {}
}
if (Test-Path $destAgent) {
  try { & $destAgent uninstall | Out-Null } catch {}
}

function Stop-InstalledServices {
  foreach ($name in @("PCManagerHelper", "PCManagerAgent")) {
    if (Get-Service -Name $name -ErrorAction SilentlyContinue) {
      try { Stop-Service -Name $name -Force -ErrorAction SilentlyContinue } catch {}
    }
  }
}
Stop-InstalledServices

# Helper first when its binary is present. Agent-only install is unchanged otherwise.
$helperInstalled = $false
$helperExe = $null
$helperSrc = Join-Path $PSScriptRoot $helperExeName
if (-not (Test-Path $helperSrc)) {
  $helperSrc = Join-Path $PSScriptRoot "dist\pc-manager-helper-windows-amd64.exe"
}
if (Test-Path $helperSrc) {
  Write-Host "Installing watchdog helper first..."
  try {
    Copy-Item $helperSrc $destHelper -Force
    $helperConfig = Join-Path $InstallDir "helper.yaml"
    if (-not (Test-Path $helperConfig)) {
      [System.IO.File]::WriteAllText($helperConfig, @"
agent_service_name: PCManagerAgent
status_port: 17890
backoff_sec: 30
"@, (New-Object System.Text.UTF8Encoding $false))
    }
    $helperExe = $destHelper
    & $helperExe install
    Set-ServiceRecovery "PCManagerHelper"
    $helperInstalled = $true
  } catch {
    Write-Warning "Helper install failed; continuing with agent-only. $_"
    $helperInstalled = $false
  }
} else {
  Write-Warning "pc-manager-helper.exe was not found next to install.ps1; installing the agent only (no watchdog)."
}

$src = Join-Path $PSScriptRoot $exeName
if (-not (Test-Path $src)) {
  $src = Join-Path $PSScriptRoot "dist\pc-manager-agent-windows-amd64.exe"
}
if (-not (Test-Path $src)) {
  throw "Agent binary not found next to install.ps1. Build with: make dist"
}

Stop-InstalledServices

Copy-Item $src $destAgent -Force

$configPath = Join-Path $InstallDir "config.yaml"
if (-not (Test-Path $configPath)) {
  Write-Utf8NoBom $configPath @"
server_url: $ServerUrl
fallback_urls: []
enrollment_secret: $EnrollmentSecret
heartbeat_interval_sec: 30
poll_interval_sec: 15
status_port: 17890
"@
}

$exe = $destAgent
& $exe install
Set-ServiceRecovery "PCManagerAgent"
if ($helperInstalled) {
  try { & $helperExe start } catch { Write-Warning "Helper start failed: $_" }
}
& $exe start

$peerPort = 17891
try {
  $existing = Get-NetFirewallRule -Name "PCManagerAgent-LANPeer" -ErrorAction SilentlyContinue
  if (-not $existing) {
    New-NetFirewallRule -DisplayName "PC Manager Agent LAN peer files" -Name "PCManagerAgent-LANPeer" -Direction Inbound -Protocol TCP -LocalPort $peerPort -Action Allow -Profile Private | Out-Null
  }
  $existingUdp = Get-NetFirewallRule -Name "PCManagerAgent-LANPeerUDP" -ErrorAction SilentlyContinue
  if (-not $existingUdp) {
    New-NetFirewallRule -DisplayName "PC Manager Agent LAN peer discovery" -Name "PCManagerAgent-LANPeerUDP" -Direction Inbound -Protocol UDP -LocalPort $peerPort -Action Allow -Profile Private | Out-Null
  }
} catch {
  Write-Warning "Could not add private-profile firewall rule for TCP $peerPort : $_"
}

Write-Host "Installed Mnag.pt Agent as a Windows service (LocalSystem)."
if ($helperInstalled) {
  Write-Host "Installed Mnag.pt Helper watchdog (PCManagerHelper)."
}
Write-Host "SCM restart on failure is set for both services (5s / 30s / 60s)."
Write-Host "To stop for real (helper then agent): & '$exe' stop"
Write-Host "Edit $configPath then: & '$exe' restart"
