# Mistake Log

On every mistake caught (wrong output, failed run, bad assumption, bug introduced), log it here.

## 2026-07-09 — Windows Terminal Unicode Encode Error
Mistake: Running `schema.py` threw `UnicodeEncodeError` on printing left arrows (←) and box-drawing lines (──).
Cause: Windows command prompt/powershell under cp1252 encoding cannot print standard unicode symbols.
Fix: Replaced arrow character with standard ASCII (`<-`) and box-drawing symbols with hyphens (`--`).

