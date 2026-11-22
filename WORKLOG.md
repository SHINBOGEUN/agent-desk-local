
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
