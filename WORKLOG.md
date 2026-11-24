
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

## Round 57 — check/verify scripts count as verify commands; AI team draft

- The user asked whether "초안 만들기" in the team settings reads the project and writes role rules and skills. It did not: it is a rule-based starter (no model call). Role files come out as empty templates. MOYEOGO's `npm run check` was not detected as a verify command, so no verify skill was made either.
- Detection:
  - init now lists `check` and `verify` scripts.
  - When a `check` or `verify` script exists, the draft uses it alone (it usually runs types and tests together).
  - `detectVerify` (used when no verify command is configured) falls back to `npm run check` / `npm run verify` after `npm test`.
- AI team draft (`packages/service/src/team-draft.ts`):
  - One read-only lead session (the project's lead runtime, effort medium) reads the instruction files, docs, task notes and code.
  - It replies with JSON: up to 8 rules per role, up to 3 project skills (description with when / when not, a "Why:" line, steps, examples, trigger cases), and the sources it used.
  - It is told not to repeat AGENTS.md / CLAUDE.md (both runtimes read those already), not to invent policies, and to write Korean in the 합니다 style when the UI is Korean.
  - `parseTeamDraft` drops malformed entries.
  - `applyTeamDraft` writes only what the user picked:
    - skills first, through saveProjectFile (skill checks), with triggers.json;
    - then role files: rules go under "## Project rules", new skills are added to the frontmatter list, and a rule already in the file is not added twice.
  - Server endpoints: POST /api/project/team-draft and POST /api/project/team-draft/apply (refused while a run is active).
- UI: the Roles and Skills tabs of the team settings get an "AI 초안 만들기" bar.
  - The review list shows rules per role and skills with checkboxes; a skill can be expanded to its body; the sources are listed.
  - A skill that would replace an existing one starts unchecked. "선택한 항목 적용 (n)" writes the checked items.
  - The old button is renamed "기본 틀 만들기".
- Tests: 266 passing.
  - New service tests: parse, run without writing, apply passes the project checks, no duplicate rules, template fill.
  - A detectVerify `check` case.

## Round 58 — AI team draft knows what each role can do

- The first real draft (MOYEOGO) was grounded in the right files, but some rules did not fit the harness:
  - the lead was asked to route requests by docs/AI_WORKFLOW.md, split work across roles with a separate review, and write to PRODUCT_HISTORY.md and DECISIONS.md (the lead is read-only and picks only answer, build or investigate);
  - the verifier was told not to edit files (it is read-only already).
- The draft instructions now state each role's limits.
- They also list what the harness already does (verify after every build, an independent review, a restore point, run records), so no rules are written for those.
- A project's own agent roles and workflow are translated only where they fit the four roles.
