
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

## Round 59 — Investigation conclusion, readable answer, design-first to-do list

User feedback: investigation answers were hard to take in.
- They were three researchers' reports pasted together, so the same facts appeared in every section.
- The conclusion was buried, and file:line citations broke every sentence.
- The user also asked for design first: the harness should draft the plan as a to-do list, keep done and not done with checkboxes while developing, and show it on a page or popup.

**A. Conclusion step**
- After the researchers, one short lead turn (step "report", effort low) writes a `synthesis` report: `headline` (two or three sentences) and `next` (up to 5 `{title, request}`).
- It works only from the reports: it is told not to open files and to say each fact once.
- New report kind `synthesis`; AnswerReport gains optional `headline` and `next`.
- If the conclusion fails, the assembled reports stand and the run still completes.

**B. Investigation view**
- The result shows "한눈에 보기" (headline) and "다음에 할 일" (next steps).
- Each next step has "요청하기" (fills the composer) and "할 일에 추가" (adds it to the to-do list).
- "관점별 상세" (claims, with evidence in small mono) and "근거 파일" are folded.
- Research left the 계획·리뷰 tab (no duplicate).

**Design and to-do list**
- Storage: `packages/project/src/todo.ts` keeps `.agent-desk/todo.json`: goal, and items with id, title, detail (acceptance), request, phase, status todo/doing/done, runs and evidence.
- Operations:
  - add (skips duplicate titles), edit, remove;
  - replace (a re-design keeps status and runs for items with the same title, and keeps started items it dropped);
  - linkTodoRun (doing);
  - finishTodoRun (done only for a completed run; anything else stays doing).
- A copy is written to the vault as `specs/개발 계획.md` with checkboxes by phase, so the lead and builder see the plan in their notes list.
- Design: `packages/service/src/design.ts` runs one read-only lead session (effort medium).
  - It reads the goal and planning docs, the notes and the code, and replies with JSON phases and items (at most 6 phases and 40 items).
  - Each item is one buildable request with an acceptance condition. Items already built come back done with evidence.
  - It stays within the stated goal; a missing decision becomes its own item.
- Server:
  - GET/POST /api/project/todo (add, replace, edit) and POST /api/project/todo/design;
  - POST /api/runs accepts `todoId`: start links the run, and a completed finish checks the item off;
  - the note is rewritten on each change.
- UI:
  - a "할 일 n/m" button in the conversation header opens the 개발 계획 popup: goal, progress bar, next up, items by phase with a checkbox, a 진행 중 #run badge and 시작 (starts the item's request as a run);
  - expanding an item shows its request, evidence, runs and 삭제;
  - items can be added by hand;
  - "AI로 설계하기" / "다시 설계하기" takes an optional brief, then shows the draft to save or discard;
  - the start card gets a "설계부터 하기" block.
- Tests: 274 passing.
  - Conclusion: workflow test.
  - to-do: project tests.
  - design: service tests.
  - Server: a run from an item ends done, the note is written, edit and errors.
