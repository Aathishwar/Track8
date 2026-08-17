if (-not (Test-Path ".venv")) { uv venv }
.\.venv\Scripts\Activate.ps1
uv pip freeze | Out-File -Encoding utf8 .agents\env\requirements.lock.txt
