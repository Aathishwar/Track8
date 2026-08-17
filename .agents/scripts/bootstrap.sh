#!/bin/bash
if [ ! -d ".venv" ]; then uv venv; fi
source .venv/bin/activate
uv pip freeze > .agents/env/requirements.lock.txt
