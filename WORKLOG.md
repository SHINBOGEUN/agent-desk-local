
## Round 54 — Briefing polish after the first real MOYEOGO briefing

- The first briefing had the right shape (goal, next work, improvements with file:line and request sentences) but two flaws:
  - parts mixed 합니다 and 한다 styles, because three researchers' reports are assembled without another model call;
  - the improvements were theoretical (subset search for a friend group, Math.random idempotency keys, intermediate safe-integer overflow on KRW sums).
- LANGUAGE_NOTE (ko) now asks for the 합니다/습니다 style throughout.
- New researcher rule: report only problems that would really bite at the project's real inputs and scale, most harmful first; fewer findings is fine.
- The survey request asks for real-use problems in impact order and for documents that no longer match the code (the briefing itself found BUILD_PLAN.md out of date).

## Round 55 — Windows reading note fixed (from the MOYEOGO briefing events)

- The briefing run took 2 minutes; three researchers ran in parallel and all three reports were accepted (the Holder.turn fix holds).
- Tokens: about 665k in total over 27 model calls, but about 85% of input was cache reads; uncached input was about 95k and output about 8k.
- 14 of the researchers' commands were wasted: `rg -n "" file` exits 1 with no output, because Windows PowerShell drops an empty argument to a native program. Our own WINDOWS_NOTE recommended that form.
- Piping `rg ... | rg ...` in PowerShell turned Korean into `?` (settlement.ts messages), even though plain rg output was fine.
- WINDOWS_NOTE now says: read with rg alone, never piped; print a file with `rg -n . file`; use `rg -n -C 20 "word" file` for a part; never pass an empty pattern.

## Round 56 — Harness steps no longer pile up in the Codex app's thread list

- The user saw "Step: research. User request: ..." and "Step: classify ..." entries piling up in the Codex app's thread list, one per harness step.
- Threads already start with `ephemeral: true`, but this Codex build still lists them.
- CodexSession.close() now also calls `thread/archive` (5 s limit, errors ignored). It is skipped when AGENT_DESK_CODEX_KEEP_SESSIONS=1, the diagnostic mode that keeps sessions.
- New test: closing a session archives its thread (the fake app-server logs the archived id).
- Entries made before this change stay; archive or delete them in the Codex app.
