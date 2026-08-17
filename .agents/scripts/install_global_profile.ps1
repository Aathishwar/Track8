# This script configures the global PowerShell profile to auto-setup workspaces
$profilePath = $PROFILE
$profileDir = Split-Path $profilePath

# Create profile directory if it does not exist
if (-not (Test-Path $profileDir)) {
    New-Item -ItemType Directory -Force $profileDir | Out-Null
}

$profileCode = @'

# --- Codex Workspace Auto-Setup Start ---
function Setup-Workspace {
    $currentPath = Get-Location
    $venvPath = Join-Path $currentPath.Path ".venv"
    $agentsPath = Join-Path $currentPath.Path ".agents"
    $vscodePath = Join-Path $currentPath.Path ".vscode"
    $templateAgents = "C:\Users\VigneshVijayaAnandan\Downloads\syn_gen_tscript\.agents"
    
    Write-Host "Setting up Codex workspace in $($currentPath.Path)..." -ForegroundColor Cyan
    
    if (-not (Test-Path $agentsPath) -and (Test-Path $templateAgents)) {
        Copy-Item -Recurse -Force $templateAgents $agentsPath
    }
    
    if (-not (Test-Path $venvPath)) {
        if (Get-Command uv -ErrorAction SilentlyContinue) {
            uv venv | Out-Null
        } else {
            python -m venv .venv | Out-Null
        }
    }
    
    $activateScript = Join-Path $venvPath "Scripts\Activate.ps1"
    if (Test-Path $activateScript) {
        . $activateScript
    }
    
    $settingsJson = Join-Path $vscodePath "settings.json"
    if (-not (Test-Path $settingsJson)) {
        New-Item -ItemType Directory -Force $vscodePath | Out-Null
        $settingsContent = @{
            "python.defaultInterpreterPath" = ".venv/Scripts/python.exe"
            "python.terminal.activateEnvInTriggerTerminal" = $true
        } | ConvertTo-Json
        $settingsContent | Out-File -Encoding utf8 $settingsJson
    }
    Write-Host "Setup complete!" -ForegroundColor Green
}

function Initialize-CodexWorkspace {
    $currentPath = Get-Location
    # Don't run in system paths
    if ($currentPath.Path -like "C:\Windows*" -or $currentPath.Path -eq $env:USERPROFILE) {
        return
    }
    
    # Auto-activate if .venv exists
    $venvPath = Join-Path $currentPath.Path ".venv"
    if (Test-Path $venvPath) {
        $activateScript = Join-Path $venvPath "Scripts\Activate.ps1"
        if (Test-Path $activateScript) {
            . $activateScript
            return
        }
    }
    
    # Auto-initialize if it looks like a project folder (contains .git, .agents, GEMINI.md, requirements.txt, pyproject.toml)
    $projectIndicators = @(".git", ".agents", "GEMINI.md", "requirements.txt", "pyproject.toml")
    $isProject = $false
    foreach ($indicator in $projectIndicators) {
        if (Test-Path (Join-Path $currentPath.Path $indicator)) {
            $isProject = $true
            break
        }
    }
    
    if ($isProject) {
        Setup-Workspace
    }
}

# Run on startup
Initialize-CodexWorkspace
# --- Codex Workspace Auto-Setup End ---
'@

# Append or create profile file
if (Test-Path $profilePath) {
    $content = Get-Content $profilePath -Raw
    if ($content -notlike "*# --- Codex Workspace Auto-Setup Start ---*") {
        Add-Content -Path $profilePath -Value $profileCode
        Write-Host "Appended auto-setup logic to existing PowerShell profile." -ForegroundColor Green
    } else {
        Write-Host "PowerShell profile already contains auto-setup logic." -ForegroundColor Yellow
    }
} else {
    New-Item -ItemType File -Path $profilePath -Force | Out-Null
    Set-Content -Path $profilePath -Value $profileCode
    Write-Host "Created new PowerShell profile with auto-setup logic." -ForegroundColor Green
}
