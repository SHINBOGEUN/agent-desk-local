# 작업 기록

v2 재설계 진행 기록입니다. 최신 항목이 위에 옵니다. 단계와 체크리스트는 [개발 로드맵](https://claude.ai/artifact/YJkaS7TK9NDkcNdCEecBb6#bc614b39-fee4)을 보세요.

## 2026-11-15 · 4단계 진행(스킬 런타임 배치)

| 항목 | 내용 |
|---|---|
| 스킬 전달 | `project.skillsByRole()`: 역할 파일의 `skills`(+ `config.skills` 필터)로 역할별 `SkillRef` 목록, 없는·오류 스킬은 제외하고 이유 안내. `RunConfig.skills` → `SessionOptions.skills`, `instructionsFor`에 id·설명·SKILL.md 경로 목록과 사용 규칙(`skillsText`). 파일은 복사하지 않음(ADR 0008, 설계서 사본 수정). 테스트 2개 추가(전체 149개) |

## 2026-11-16 · 첫 실제 Claude 스모크와 수정

| 항목 | 내용 |
|---|---|
| 결과 | `claude` 스모크: 실행·사용량·메시지·파일 변경·명령·중단·두 번째 턴 통과(Claude Code 2.1.322). 실패: 보고 제출(두 번)과 builder 보고 |
| 원인 | `submit_report` MCP 입력 스키마가 비어(`properties: {}`) Claude Code가 목록 필드를 JSON 문자열로 보냄 → "expected array, got string". 스모크 스크립트도 `classify` 수집기에 answer 필드를 요구해 모순이었음 |
| 수정 | 도구 스키마에 필드별 타입 선언, `ReportCollector`가 첫 검증 실패 시에만 JSON 문자열을 값으로 되돌려 재검증(정상 보고의 문자열은 건드리지 않음), 스모크는 answer 수집기·정확한 필드 지시, 실행 파일은 탐색 로직 사용(Windows `codex.cmd`) |
| 재실행 | claude 전부 통과. codex(0.167.2) 통과, 단 `file_change` 이벤트 0건: Codex가 PowerShell 명령으로 파일을 써서 patch 이벤트가 없음. G2는 스냅샷 비교라 영향 없음 → 점검을 "file_change 또는 command"로 완화. Codex는 이 스모크에서 승인 질문 0건(approvalPolicy never), 한 보고에 약 38k 토큰 |
| 관찰 | Claude Bash 승인: `node -e`는 정책대로 거부, `echo`는 허용. 승인 질문이 Read·Write·Bash 모두 `approve`로 들어옴(가정한 형식 동작). 이 스모크에서 한 번의 보고 시도당 약 6~10k 토큰 |

## 2026-11-13 · 4단계 진행(4-3)

| 항목 | 내용 |
|---|---|
| 4-3 5시간 한도 | `service/usage-limits.ts`: v1의 `normalizeRateLimits`·창 식별(리셋 시각 5분 미만 흔들림 무시)·`usageSince`를 타입 붙여 이식, `startUsageGuard`(주기 조회, 시작 대비 증가분이 한도 이상이면 중단, 창이 넘어가면 0부터 다시 셈). 한도를 못 읽으면 중단(시작 때 즉시, 실행 중에는 연속 3회 실패). `CodexRuntime.readRateLimits()`(짧게 뜨는 app-server로 `account/rateLimits/read`). 설정은 `limits.codexUsagePercent` 또는 `--max-usage-percent`, 중단되면 status `interrupted`와 사유. 다른 Codex 작업의 사용도 포함되므로 정지 조건일 뿐 정확한 회계가 아님 |

## 2026-11-13 · 4단계 진행(4-1)

| 항목 | 내용 |
|---|---|
| 서비스 분리 | `packages/service`: CLI의 run 오케스트레이션(프로젝트 로드, 런타임 배정·탐색, 저장소, RunConfig 조립, 복원 지점 정리)을 `executeRun`으로 추출. CLI와 서버가 공유. 실행 파일 탐색·데이터 폴더도 여기로 이동 |
| 4-1 서버 | `packages/server`: `127.0.0.1`만 바인드, Host·Origin 검사, 시작마다 새 CSRF 토큰(POST는 `X-Agent-Desk-Token` 필수, 상수 시간 비교), CSP·nosniff·no-referrer, 요청 본문 256KB 상한, 질문·요청·메모의 비밀값 마스킹. 한 번에 한 실행. 경로: `GET /api/health·state·runs·runs/:id·runs/:id/events(SSE, afterSeq/Last-Event-ID)·project`, `POST /api/runs·runs/active/cancel·runs/active/answer·runs/:id/revert`. CLI `agent-desk serve [--port]` |

## 2026-11-13 · 4단계 시작(4-2, 4-6, 4-7)

| 항목 | 내용 |
|---|---|
| 4-2 설정 | `packages/project`: `config.json` 스키마(`runtimes.primary/review`, `roles.<role>.runtime`, `skills`, `verify`, `review`, `limits`), 알 수 없는 키는 오류. v1식 `runtime`·역할별 맵 형식은 폐기 |
| 4-6 역할 파일 | `.agent-desk/agents/<role>.md`(프론트매터 access·effort·model·skills·description + 본문은 프로젝트 지침으로 내장 지침에 추가). 읽기 전용 역할에 쓰기 권한 부여 시도는 오류, builder는 제한만 가능. 파일이 없으면 기본값 + `doctor` FAIL로 알림 |
| 4-7 `init` | 프로젝트 검사(스택, verify 후보, 기존 에이전트 파일, 테스트·CI·커밋 수, AGENTS/CLAUDE 불일치) → 초안과 근거 출력, `--yes`로만 작성, 기존 파일은 덮어쓰지 않음 |

## 2026-11-13 · 4단계 진행(4-8, 4-9)

| 항목 | 내용 |
|---|---|
| 4-8 `skills check` | `.agent-desk/skills/<id>/SKILL.md` 구조(폴더명=name, 프론트매터, 본문, 참조 파일 존재·고아 파일), description 점검(동사·트리거·제외 조건, 길이), 중복 설명, `config.skills`·역할 파일의 존재하지 않는 스킬 참조. 트리거·with/without 검증은 6단계(모델 필요) |
| 4-9 프로젝트 메모 | `.agent-desk/memory.md`(2,000자 상한, 항목 240자, 비밀값처럼 보이면 거부). builder가 `memorySuggestions`(선택, 최대 3개)로 제안만 하고, CLI에서 `memory add` 또는 대화형 승인으로만 기록. 모든 역할 지침에 포함 |

## 2026-11-13 · 4단계 시작(4-2, 4-6, 4-7)

| 항목 | 내용 |
|---|---|
| 3-1 `runtime-claude` | stream-json 어댑터, 가짜 claude 테스트 9개. 실제 Claude Code 확인은 사용자 PC |
| 3-2 승인 정책 | 허용 목록 + 나머지 거부 [ADR 0007](adr/0007-claude-permissions.md), 승인 결과 이벤트 기록 |
| 3-3 워크플로 | `plan-build`(plan 단계 → 계획을 builder 프롬프트에 포함, `confirmPlan`으로 사용자 확인) · `investigate`(researcher 병렬 최대 3, 모델 호출 없이 코드로 조립) |
| CLI | `--runtime claude`, `config.runtimes`(역할별 혼합), `allowCommands`, Claude 실행 파일 탐색 |

## 2026-11-13 · 2단계 진행(2-4~2-9)

| 항목 | 내용 |
|---|---|
| 2-4 게이트 | `41e79c8`. 스냅샷 기반 G2, harness가 직접 실행하는 G3, 예산 G5, REDO 최대 2회, 환경·일시 오류 분류 |
| 2-5 독립 리뷰 | `86f1058`. G4 verifier, 정책 always/auto/never, 실제 diff 기반 판정 |
| 2-6 저장소 | `d1e48a5`. SQLite 이벤트·토큰 저장, 비밀값 가리기, 비정상 종료 복구, Run Brief |
| 2-7 CLI | `bee340d`. `agent-desk run`·`doctor`, Codex 실행 파일 탐색, 프로젝트 설정 검증 |
| 2-8 실패 재현 | `17b6b10`. v1 실패 사례 7개(거짓 완료·환경 오류·REDO 초과·거짓 경보) 끝-대-끝 테스트 |
| 2-9 벤치 어댑터 | `25af4bc`. `bench/adapters/v2.mjs`, selftest 확장 |
| 2-11 복원 지점 | build 전 파일 복사, `agent-desk revert <id> [--yes]`, [ADR 0006](adr/0006-restore-points.md) |
| 남은 것 | 2-10 실제 Codex 측정(사용자 PC) |

## 2026-11-13 · 2단계 시작(2-1~2-3)과 설계 개정 3

| 항목 | 내용 |
|---|---|
| 2-1 `tools-mcp` | `5f270cd`. 도구 3개, stdio MCP 서버, 세션별 토큰 HTTP 브리지, 보고 검증 |
| 2-2 `runtime-codex` | `e2ce324`. app-server 어댑터, 가짜 서버 테스트. 실제 Codex 확인은 2-10 |
| 2-3 `orchestrator` | `88581cd`. answer 빠른 경로, build 워크플로, 요구사항 id 검사, 보고 재요청 1회 |
| 개정 3 | Notion 책 정리 노트 반영. 팀 구조 선택 기준(6패턴 대응), 스킬 점진적 공개 3층과 검증 절차, 역할 정의 md 분리, `init`·`skills check`, 개선 루프, 독립 리뷰 근거 가설. [ADR 0004](adr/0004-book-notes-revision.md) |
| 정책 결정 | `unverified`·G2 불일치·G5 기준 [ADR 0005](adr/0005-gate-policies.md). REDO 초과는 `needs_review` 유지(책의 '경고 PASS' 미채택) |
| 로드맵 탭 | 2-1~2-3 체크, 2-10 리뷰 정책 비교·2-11 스냅샷, 3-5 독립 리뷰 비교·3-6 분류 정확도, 4-6~4-9(역할 파일, init, skills check, 프로젝트 메모), 6-4~6-5(스킬 트리거 검증, 실패 분석 보고서) 추가 |

## 2026-11-13 · 기준선 측정 완료, 어려운 과제, 1단계 프로토타입

| 항목 | 내용 |
|---|---|
| 0-5 `v1-13` | 과제 10개 x 2회 완료. 실제 성공 20/20, 거짓 완료 0, 거짓 경보 9, 평균 61.1만 토큰. 에이전트 4개를 쓴 6건은 평균 105.8만 토큰, 검토 필요 4건 |
| v1 서버 | 20분 안팎에서 메모리 4GB를 넘어 두 번 종료. 메모리 한도를 올리고 재시작 반복문으로 측정을 이어 감. v1 결함으로 기록 |
| 어려운 과제 | H01~H05 추가(`--set hard`). 원본에서 실패, 모범 답안에서 통과 검증 완료 |
| `v1-13-hard` | 5개 × 3회 완료. 실제 성공 15/15, 거짓 완료 0, '검토 필요' 9건(전부 마지막 검증 판정 NOT_VERIFIED), 평균 114만 토큰, 평균 8.3분. H03 숨은 테스트가 프롬프트에 없는 DB 함수 이름을 써서 잘못 채점됨 → 테스트 수정 후 `bench/regrade.mjs`로 재채점(이전 판정은 결과 파일의 `regrade`에 보존) |
| 기준선 종합 | 35회 모두 실제 성공, 거짓 완료 0, '검토 필요'로 잘못 보고 18/35(51%). 평균 토큰: 기존 과제 61.1만, 어려운 과제 114.1만. 성공률로는 구성을 구분할 수 없어 토큰·시간·판정 정확도로 비교 |
| 1-4~1-6 프로토타입 | P1·P2 실행. Codex MCP 도구 호출은 승인 설정이 필요함을 확인하고 `approve`로 결정, Claude는 전부 통과. [ADR 0003](adr/0003-phase1-prototype-results.md) |

## 2026-11-13 · 0단계 (0-1 ~ 0-4)

| 커밋 | 내용 |
|---|---|
| `99a232a` | 벤치마크 러너를 공통부(`bench/run.mjs`)와 v1 어댑터(`bench/adapters/v1.mjs`)로 분리. 사용률 한도 중단 경로를 셀프테스트에 추가 |
| `8a002b2` | v1을 `legacy/`로 이동(이력 보존). 기본 프로젝트 경로 보정, 루트 README·package.json 신규 |
| `a25158d` (태그 `v1-legacy`) | 벤치마크, v1 실행 기록 분석, 설계 ADR 커밋 |

확인한 것
- `legacy/`에서 `npm run check` 통과, `npm test` 64/66 (기존과 동일: Linux 전용 실패 1, Windows 전용 생략 1)
- `legacy/server.mjs`가 새 위치에서 기동, `/api/health`·대시보드 응답, 기본 프로젝트가 저장소 상위 폴더로 유지
- `bench`: 과제 10개 공정성 검증 통과, 셀프테스트 통과

남은 것
- 0-5 `v1-13` 기준선 실행 (사용자 PC, Codex 사용량 필요)
- 0-6 `v1-3`: v1 배정 규칙이 꺼진 필수 담당자의 대체를 금지해 측정이 왜곡됨. 실행 방법 결정 필요
- GitHub push: 이 작업 환경에서는 GitHub 접속이 막혀 있어 사용자 PC에서 `git push --follow-tags` 필요

## 2026-11-16 5-2 dashboard (first cut)
- `web/` Vite + React 19: console form (project, request, runtime, review), run list, run detail with live timeline (SSE), gate chips, REDO reasons, pending-question card, stop, revert preview/apply.
- State logic is pure TS in `web/src/model.ts` (tested); React files are thin. Server serves `web/dist` via `agent-desk serve`.
- Not yet built in the sandbox (no npm): the user must run `npm run web:install`, `npm run web:typecheck`, `npm run web:build`.
- Remaining: settings/skills/usage panel (5-3), benchmark comparison screen (5-4).

## 2026-11-16 5-3 start: result report in the dashboard
- Found: finished runs kept only a one-line brief, so the answer text was not visible in the UI. The store now saves the submitted reports per run (`runs.report`, schema v2; answer, builder summary, changed files, commands, requirements, plan, research, review, warnings, unverified). Older runs have no report (shown as such).
- Dashboard: result card on finished runs; folder picker uses the OS dialog; English/Korean switch.
- 5-3 rest: `/api/usage` (Codex limits via a short-lived app-server, cached 20 s), `/api/project` now lists skills and skill findings; UI: usage gauge, project settings panel (read-only), per-role time/tokens table. Real Codex rate-limit response shape still unverified on a real account (gauge shows "not available" if it differs).
- 5-4: `/api/bench` (summaries of `bench/results/runs`, same numbers as `bench/report.mjs`) and a Benchmark tab: v1 vs v2 per task set (standard / hard) with change %, bars for tokens and minutes, per-task table, and the caveat that agent count and harness design changed together.
- 5-5 (first cut): agent scene on the run screen. Round SVG robots per role (lead, builder, verifier, researcher when used), mood from the timeline (waiting/working/done/failed/asking), speech bubbles = hand-offs and REDO reasons passed by the harness (not agent-to-agent chat), a Harness strip with gate chips, a chat log, and a Replay button that replays a finished run. Logic is pure TS in `web/src/scene.ts` (tested). Not yet done: v1 vs v2 side-by-side scene (needs v1 run data in the same event form).
- 5-5: the 2D robot scene was removed from the UI (quality; the user wants 3D later). `scene.ts` and its tests stay for reuse.
- Language: `RunConfig.language` ('en' | 'ko'; option > `config.language` > en). 'ko' adds a Korean-output note to every role's instructions and localizes the harness's own result/warning messages (`ctx.say`). Dashboard sends the UI language with each run; CLI has `--language`. Not localized: gate problem texts, runtime/tool error messages, and the plan-confirm question text.
- Language (cont.): gates G2/G3/G5 messages, protected-path warning and the plan-confirm question follow `language`. Agent-facing texts (report validation errors, tool approval denials) stay English on purpose.

## 24차 — 4-5 범용성 검증 구현
- 샘플 2종 추가(`bench/samples/python-inventory`, `web-notes`)와 과제 6개(P01–P03, W01–W03: 버그/기능/읽기 전용 질문).
- 러너 일반화: `task.json`의 `sample`, `SAMPLES`(런타임·verify·touch), Python unittest 채점, `--set python|web|general|all`, v2 어댑터가 샘플별 verify 사용.
- `validate-tasks`·`selftest`·`npm test`(172) 통과. 실측(v2 + Codex)은 사용자 PC에서: `node bench/run.mjs --adapter v2 --label v2-general --set general`.

## 24차 — 다듬기
- 대시보드: 서버 오류 메시지(영어, API는 그대로)를 UI가 한국어일 때 한국어로 표시(`apiErrorText`).
- `package-lock.json` 커밋(devDependencies 고정), `h04-r*.txt` 임시 파일은 .gitignore.
- `legacy/agents/*.md` 변경분은 v1 실행이 덮어쓴 것이라 커밋하지 않고 보류(사용자 판단).

## 25차 — 런타임 모드, 채팅형 대시보드, 디자인 개편
- 런타임 모드 4종(`codex`, `claude`, `codex+claude` 기본, `claude+codex`): `config.mode`, `--mode`, 대시보드 선택. Claude 미설치 시 기본값만 Codex로 대체. 역할 파일 `model-codex`/`model-claude`. `run_started`에 역할별 런타임 기록. [ADR 0009](adr/0009-runtime-modes.md)
- 대시보드를 v1처럼 채팅형으로: 왼쪽 프로젝트 목록(연 폴더 + 실행 기록), 가운데 대화(요청 말풍선, 팀 응답에 진행 상황·질문·결과), 아래 입력창(Enter 전송, 질문 대기 중이면 답변으로 전송), 오른쪽 팀 패널(역할별 런타임·상태, 사용량).
- 디자인 개편: 차가운 회색 바탕 + 잉크색 사이드바, Codex=청록·Claude=보라로 모델 정체성 표시, 상태색은 게이트·결과에만. 다크 모드 지원. 목업 데이터로 헤드리스 Chrome에서 화면을 확인함(실제 서버 확인은 PC에서).
- 벤치: `--mode` 옵션, 대시보드 벤치 탭에 `-general` 세트 추가, 서버가 P/W 결과 파일도 읽음.
- 테스트 178개 통과, web 타입 검사 통과.
- 실행 기록 삭제: 사이드바에서 프로젝트별 기록 삭제(× → 확인), 벤치마크 작업 폴더(`agent-desk-bench`)는 접힌 그룹으로 모으고 한 번에 삭제. `POST /api/history/delete`, `RunStore.deleteRuns`. 대시보드 기록(DB)과 복원 지점만 지우고 프로젝트 파일과 `bench/results`는 그대로.
- 설계서 개정 4: Claude 문서(원본)와 `docs/design-v2.md`에 런타임 모드, 채팅형 대시보드, API 표, 범용성 세트 반영.

## 26차 — 빈 곳 채우기, 편집 화면, 검증 도구
- 하네스(`1ccfb55`): 실행 설정 기록(스키마 v3), 이어하기, 이미지 첨부(Codex·Claude), 메모 제안 저장, 자체 점검 리뷰 `self`, Codex 한도 95% 이상이면 Claude로 대체, 프로젝트 파일 편집 API(같은 검사로 검증 후 저장), `init` 스킬 초안 2개와 Python·웹 감지, `--dry-run`·`--no-skills`·`skills trigger-test`, 벤치 분류 정확도·`bench/failures.mjs`, web-notes 샘플 스킬과 트리거 사례 16개. [ADR 0010](adr/0010-run-settings-resume-self-check.md)
- 대시보드(`a58f975`): 팀 설정 편집(팀 구성·역할·스킬 탭, 역할 요약에 런타임·권한·모델·스킬 설명), 초안 만들기, 이미지 첨부(버튼·붙여넣기), 이어서 하기, 메모 추가, 응답에 사용한 팀 표시, Claude 사용량, 질문 대기 알림과 탭 제목 표시.
- 원클릭 실행: `Start-AgentDesk.cmd`/`Stop-AgentDesk.cmd`(필요하면 설치·빌드 후 서버를 백그라운드로 켜고 브라우저 열기). PowerShell이라 이 환경에서는 실행해 보지 못함.
- 3D 장면 컨셉 시안: `docs/concepts/agent-scene-concept.png`(SVG로 그린 시안, 확정 전).
- legacy/agents 변경분 폐기(사용자 결정). 테스트 193개 통과.
- 3D 장면 컨셉 2차: 역할별로 다른 캐릭터(lead 헤드셋·태블릿, builder 안전모·무한궤도, verifier 부엉이·모노클, researcher 드론), 22초 애니메이션(각자 작업 → 하네스 중계대를 거친 계획 전달 → 구현·게이트 → 독립 리뷰 → 완료 보고). `docs/concepts/agent-scene-concept.html`·`.mp4`. SVG 2.5D 시안이며 실제 구현은 승인 후 React Three Fiber.
- 3D 장면 컨셉 3차: 애니메이션 원칙 적용(예비 동작, 찌그러짐·늘어남, 스프링 착지, 따라오는 움직임, 숨쉬기·눈 깜빡임, 말하는 쪽으로 고개 돌리기, 걷기 흔들림·기울기, 말풍선 튀어나오기). 실제 구현에서도 같은 원칙을 쓸 것.

## 27차 — 할루시네이션 감소 검사 (ADR 0011)
- 목표를 HANDOFF 맨 앞에 명시: 할루시네이션 감소, 사용량 감소, 결과물 생성.
- 실행한 명령 대조, 근거 파일 존재 확인, 요구사항 원문 인용(`quote`), 범위 제한 지침(builder·verifier·planner), 계획 밖 파일 변경 알림, 스킬 사용 기록(`skill_read`, 대시보드 표시), 벤치 스킬 선택 정확도·불필요한 스킬 읽기 수, `init` 트리거 사례 초안.
- 테스트 197개 통과.

## 28차 — 책 예제 대조 후 반영 (ADR 0012)
- 책 예제 저장소 md 128개와 Notion "하네스" 노트를 우리 코드와 대조. 이미 있는 것/가져올 것/버릴 것을 ADR 0012에 정리.
- 리뷰 지적 위치 검사(파일·행 실재, 파일 없는 REDO는 요구사항 근거 필수), REDO 후 재검토는 이전 지적 + 그 뒤 diff만, 바뀌지 않은 파일의 새 지적 반려.
- 스킬 점검: 이유 없는 절대 규칙 경고, 분기 많은 본문의 references 분리 권고, 트리거 사례 수·언어 편향 알림, Claude 전용 키 정보 처리. `init` 초안에 정상·에러 예시, 트리거 사례 8개씩, 리뷰 체크리스트와 verifier 규칙 일치(요청 없는 변경은 차단).
- 벤치: `--adapter bare`(맨몸 Codex 기준선), 과제 변별력, 근거 검사 반려 수, 1차 대 재검토 리뷰 토큰.
- 품질 기록: 실행별 👍/👎 + 고칠 곳·파일·메모(스키마 v4), 파일 바로 열기, 품질 기록 탭(집계, CSV/JSON 내보내기).
- 테스트 205개 + 벤치 selftest 통과.

