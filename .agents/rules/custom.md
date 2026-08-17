---
trigger: always_on
---

# Custom Project Rules

Apply every session, every file, every task. Load alongside ponytail.md, caveman.md, superpowers.md in `.agents/rules/`.

## 1. README — always up to date

On every change (new feature, edit, refactor, bugfix):
- Update `README.md` immediately, don't wait for task end.
- Plain, easy-to-follow language, no jargon dumps.
- Every documented feature gets a file + line reference entry:

| Feature | File | Lines |
|---|---|---|
| User login | `src/auth.py` | 12–48 |
| Rate limiter | `src/middleware.py` | 5–30 |

- Update table whenever feature location shifts (refactor, move, line change).
- Structure: Purpose → Setup → Usage → Feature Map (table) → Dependencies.

## 2. Environment setup — uv + venv + auto-activate terminal

Always use `uv`, not raw pip, unless uv unavailable.

Logic: check for `.venv` → if missing, `uv venv` → activate → every new terminal opened in project auto-activates `.venv` by default.

`.agents/scripts/bootstrap.ps1`:
```powershell
if (-not (Test-Path ".venv")) { uv venv }
.\.venv\Scripts\Activate.ps1
uv pip freeze > .agents\env\requirements.lock.txt
```

`.agents/scripts/bootstrap.sh`:
```bash
#!/bin/bash
if [ ! -d ".venv" ]; then uv venv; fi
source .venv/bin/activate
uv pip freeze > .agents/env/requirements.lock.txt
```

Run at start of every terminal session (triggered via GEMINI.md).

Library version record: `.agents/env/requirements.lock.txt`, regenerate on every install/uninstall — single source of truth for what's installed.

## 3. Universal logging

Every file, regardless of purpose, logs terminal output persistently.

Log dir: `logs/` (create if missing). Naming: `logs/<script_name>_<YYYY-MM-DD_HHMMSS>.log`. Content: full stdout/stderr, unfiltered.

Python:
```python
import sys, datetime, os
os.makedirs("logs", exist_ok=True)
log_path = f"logs/{os.path.basename(__file__)}_{datetime.datetime.now():%Y-%m-%d_%H%M%S}.log"
sys.stdout = open(log_path, "w")
```

Bash:
```bash
mkdir -p logs
LOGFILE="logs/$(basename "$0")_$(date +%Y-%m-%d_%H%M%S).log"
exec > >(tee -a "$LOGFILE") 2>&1
```

## 4. Relative wall-clock timer

Every long-running operation (training, generation, build, install) shows relative wall-clock timer.

```python
import time
start = time.time()
# work happens
elapsed = time.time() - start
print(f"[Elapsed: {elapsed:.1f}s]")
```

Iterative processes (training loops, batch jobs): print elapsed time per step/epoch, not just at end.

## 5. Comment style — newbie-readable, not verbose

One line of comment per logical block, plain language. Not zero comments, not paragraph-per-line.

```python
# Load the dataset from disk
data = load_data(path)
# Split into train/test sets (80/20)
train, test = split(data, ratio=0.8)
```

## 6. Global config — single source of truth for parameters

Never scatter constants across files. One central config file, everything else imports from it.

```
config/
└── settings.py
```

```python
# Central config — change once, applies everywhere
BATCH_SIZE = 32
LEARNING_RATE = 0.001
MODEL_NAME = "resnet50"
DATA_PATH = "data/raw"
```

```python
from config.settings import BATCH_SIZE, LEARNING_RATE
```

## 7. Directory structure

Add folders only as actually needed, don't scaffold empty ones prematurely.

```
project/
├── GEMINI.md
├── AGENTS.md
├── README.md
├── .agents/
│   ├── rules/
│   │   ├── custom.md
│   │   ├── ponytail.md
│   │   ├── caveman.md
│   │   └── superpowers.md
│   ├── scripts/
│   │   ├── bootstrap.ps1
│   │   └── bootstrap.sh
│   ├── env/
│   │   └── requirements.lock.txt
│   ├── mistakes.md
│   ├── workflows/
│   └── skills/
├── config/
│   └── settings.py
├── src/
├── scripts/
├── logs/
├── models/
├── data/
├── tests/
└── docs/
```

## 8. Mistake log — don't repeat errors

On every mistake caught (wrong output, failed run, bad assumption, bug introduced), log it before moving on.

Location: `.agents/mistakes.md`

Entry format:
```
## <date> — <short title>
Mistake: <what went wrong>
Cause: <why it happened>
Fix: <what remedy worked>
```

Before starting any new task, check `.agents/mistakes.md` for relevant past entries — apply the fix pattern instead of repeating the error. Append, never delete old entries — this file is the running memory of past errors and their remedies.

## Summary of enforcement

| Rule | Trigger |
|---|---|
| README update + feature map | Every code change |
| uv + venv auto-setup | Every new terminal/session |
| requirements.lock.txt | Every install/uninstall |
| Logging | Every script execution |
| Wall-clock timer | Every long-running operation |
| Comments | Every code file |
| Global config | Every param/constant |
| Mistake log | Every error caught |
| Directory structure | Project scaffolding |