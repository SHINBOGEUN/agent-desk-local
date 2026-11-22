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
- 추가: 역할 파일 점검(내장 지침과 겹치는 섹션, 40줄 초과, 이유 없는 절대 규칙 → 정보), UI+API 프로젝트용 `boundary-check` 스킬 초안(경계면 7패턴). 세션 시작 지침: AGENTS.md가 HANDOFF·목표를 가리키고 CLAUDE.md가 `@AGENTS.md`로 가져옴.

## 29차 — 보고 접수 후 턴 종료 (ADR 0013)
- 실행 #39 사용량 분석: 단계당 모델 호출 3번 중 마지막은 보고 접수 뒤 마무리 말. 접수 즉시 하네스가 턴을 끝내도록 변경(세션 유지, completed 처리, 반려 시에는 유지).
- 대시보드 역할별 표: 모델 호출 수, 새 입력, 캐시 입력, 출력.
- 스킬 탭: 스킬이 없으면 설명과 "초안 만들기" 버튼(전에는 설정·역할 파일이 없을 때만 보였음).
- 테스트 209개 통과.
- PC 확인(#40): 턴 종료 동작, 호출 1번. Codex가 중단 시 사용량 알림을 반복해 이중 집계되던 것을 스레드 누적 합계로 걸러냄.
- 원인 확인(실행 #45, `AGENT_DESK_CODEX_KEEP_SESSIONS=1`로 Codex 세션 저장): Codex는 도구를 `exec`(자바스크립트 실행기) 안에서 부르고, lead가 첫 호출에서 `ALL_TOOLS`로 submit_report 정의를 찾아본 뒤 두 번째 호출에서 제출했다. 공통 지침에 "보고서 객체를 그대로 인자로, 정의를 찾지 말고 바로 호출"을 추가. 호출당 약 13k 중 우리 지침은 약 7.7k자(2k토큰 안팎), 나머지는 Codex 기본 지침·도구 목록.

## 31차 — 프로젝트 기억 (ADR 0014)
- 누적 요약: 최근 실행 요약을 모아(최근 2개 전체, 이전은 한 줄, 2,000자) lead·builder 지침에 넣음. 직전 1개만 넘기던 방식 대체.
- `read_history` 도구(실행 번호/검색어, 같은 프로젝트, 4,000자): 요구사항·작업 요약·명령·리뷰 지적까지. Codex·Claude 모두 MCP로 사용.
- 테스트 212개 통과.
- REDO가 있으면 시도별로 한 일과 되돌려진 이유를 결과(`attempts`)와 대시보드에 표시, 실행 요약에 "재작업 이유" 줄 추가. 마지막 시도 요약만 보여 "수정하지 않았다"로 읽히던 문제(mecro 실행).

## 32차 — 결정 기억, 기록 검색 보강, 문서 동기화
- 메모 제안이 사실뿐 아니라 사용자가 말한 결정과 이유도 다룸. 질문(answer)으로 분류된 "앞으로 X로 하자"도 lead가 제안.
- `read_history`: 보고서 본문까지 검색, 전부 일치 없으면 일부 일치로 대체, 한·영 동시 입력 안내.
- Claude 런타임 점검: 사용량은 메시지 id와 최종 결과 차이로 세어 반복 알림에 안전, 중단 후 같은 프로세스가 다음 턴을 받는지 테스트 추가. 주의: 중단 요청에 10초 안에 답하지 않으면 프로세스를 끝내므로 그 세션은 재사용할 수 없다.
- 설계서 개정 8(ADR 0013·0014 반영), 로드맵·프로젝트 기록·이력서 문서 갱신. 테스트 214개 통과.

## 33차 — 게이트 이름, 한국어 계획 질문, 역할별 모델 선택
- 대시보드 게이트를 이름으로(변경 파일 확인, 테스트, 독립 리뷰, 예산, 보고서 형식), G 번호와 설명은 툴팁. 계획 확인을 한국어 라벨·진행/중지로.
- 실제로 쓰인 모델 기록: Codex는 thread/settings/updated, Claude는 init 메시지에서 `session_info` 이벤트 → `RunResult.modelsUsed`.
- `/api/models`: Codex는 계정의 `model/list`(10분 캐시, 실패는 이유와 함께), Claude는 opus/sonnet/haiku. 기본값 표시는 계정 기본 → 최근 실행에서 본 모델.
- 역할 탭: 추론 강도, Codex일 때 모델, Claude일 때 모델을 선택 상자로. 고르면 역할 파일의 해당 키만 바꿔 저장. 지금 이 역할을 맡은 런타임 줄을 강조.
- PC 확인 필요: Codex `model/list` 응답 형태(실패하면 목록 대신 이유가 보임), 첫 실행 뒤 기본값 옆에 모델 이름이 나오는지. 테스트 219개 통과.
- harness-test 마감일 실행: 테스트는 통과했지만 화면·README 한글이 `???`로 깨진 것을 독립 리뷰가 잡아 재작업(1회)으로 고침. 이후 보강: builder 보고 때 새로 쓴 줄의 `???`(3개 이상)·`\uFFFD`를 코드로 검사해 같은 턴에 반려(`encodingDamageErrors`, 리뷰 한 바퀴 절약), builder 지침에 UTF-8로 쓰기 한 줄, 테스트 파일 변경 경고 한국어화.


## 34차 — 규칙 선언은 질문으로, lead 메모 제안은 항상
- harness-test 3번("앞으로 날짜는 YYYY-MM-DD로 통일하자")이 build로 분류돼 날짜 입력을 바꿔 버렸고 메모 제안도 없었다. 원인: lead의 메모 제안은 answer일 때만 받았고, builder는 규칙을 제안하지 않음.
- lead 지침: 앞으로의 규칙만 말하고 지금 코드 변경을 요청하지 않으면 answer — 규칙을 메모 제안에 넣고 "기존 코드에도 적용할까요?"를 답변에서 묻는다. 지금 바꾸라는 말이 함께 있으면 build.
- lead의 메모 제안을 분류와 상관없이 받아 builder 제안과 합침(중복 제거, 최대 5개). 테스트 222개 통과.
- PC 확인(#53): 규칙 선언이 answer로 분류되고 메모 제안·적용 여부 질문이 나옴. 다만 lead가 기존 날짜 형식을 확인하려 명령을 1번 실행해 호출 3번, 40k. 규칙 선언에는 파일을 읽지 말고 첫 단계에서 바로 보고하도록 지침 추가. 메모 제안 제목에서 "빌더가" 제거(lead도 제안).
- PC 확인(#54, "앞으로 버튼 문구는 존댓말로 하자"): 명령 0개인데도 호출 3번(13.0k → 13.2k → 13.5k). 이벤트에 보이는 도구 호출은 submit_report 하나뿐이고, 세 번째 호출의 입력이 약 300토큰 늘었다. submit_report 스키마(914자) 크기와 맞아서, Codex가 MCP 도구를 도구 검색(deferred) 뒤에 숨겨 두고 모델이 먼저 찾아 불러온 것으로 판단(추정, 세션 파일로 미확인). Codex 설정 `mcp_servers.agentdesk.omit_tools_from = ["deferred", "code_mode"]`로 우리 도구 4개를 모델에게 바로 보이게 함. 이 키를 모르는 이전 Codex가 thread/start를 거부하면 그 키 없이 다시 시작. 테스트 223개 통과.
- PC 확인(#55, "앞으로 에러 메시지는 존댓말로 하자"): 호출 1번, 14k, 4초(#54: 3번, 40k, 10초). 도구 검색 뒤에 숨은 도구를 찾느라 생긴 호출이라는 판단이 맞았음. 이전 "정의를 찾지 말라" 지침으로는 못 막던 부분(도구가 모델에게 안 보였음).
- PC 확인(#56): 메모에 넣은 규칙("에러 메시지는 존댓말")을 build가 따름 — 서버 400 메시지 "할 일 제목을 입력해 주세요.". 한 번에 통과, 165k(새 63k, 캐시 99k). 리뷰 제안: input `required` 때문에 완전히 빈 값은 브라우저 말풍선이 먼저 뜸, 빈/공백 제목 테스트 없음, PATCH는 범위 밖. 역할 탭 모델 선택 상자도 정상(사용자 확인).
- #56 역할별 표: lead 1회 14k, builder 7회 120k(새 38k·캐시 80k), verifier 4회 32k. builder 시간이 0초로 나오는 표시 버그 발견: 리뷰가 build 단계 안에서 돌기 때문에 "build 끝남" 이벤트가 열린 마지막 단계(리뷰)에 덮어써짐. 같은 이름의 열린 단계를 닫도록 고치고, 역할별 시간에서 안쪽 단계 시간은 빼서 중복 계산을 막음. 테스트 224개.

## 35차 — 주간 한도에서도 Claude로 전환
- Codex 사용량이 바닥났는데(사용자) 자동 전환은 5시간 창만 봤다. 5시간·주간 중 기준을 넘은 창이 있으면 Claude가 Codex 역할을 맡도록 수정, 안내 문구에 어느 창인지 표시(대시보드는 한국어로). 테스트 225개.

## 36차 — 메모 관리, 리뷰 제안 이어서 요청하기
- 메모 탭(프로젝트 설정): 항목 보기·고치기·삭제·추가, 글자 수(2,000자 한도) 표시. 틀린 규칙이 매 실행 지침에 남는 것을 막기 위함. 서버 `POST /api/project/memory`에 `facts`(전체 목록)를 보내면 항목마다 기존 검사(빈 값, 240자, 비밀값 모양, 중복)를 하고 하나라도 실패하면 아무것도 쓰지 않음(`replaceMemory`). 조회 `GET /api/project/memory`. 쓰기는 POST로 둬서 기존 CSRF 토큰 검사를 그대로 받음.
- 리뷰 제안 체크 → "선택한 N개로 다음 요청 쓰기": 입력창에 "실행 #N의 리뷰 제안 중 아래를 반영해줘." 초안을 채움(실행 번호를 넣어 lead가 read_history로 찾을 수 있게). 바로 실행하지 않고 사용자가 보냄.
- 미리보기로 화면 확인. 테스트 227개.

## 37차 — 실행 도중 사용량 한도
- 실행 시작 전에만 사용량을 봐서, 도중에 한도에 걸리면 영어 오류로 실패하고 "rate limit" 문구 때문에 일시 오류로 보고 한 번 더 재시도(같은 벽에 다시 부딪힘)했다.
- 실패 유형 `limit` 추가: Codex "You've hit your usage limit" / `codexErrorInfo: usageLimitExceeded`(런타임이 메시지 뒤에 붙임), Claude "You've hit your session/weekly/Opus/Sonnet limit · resets …" + stream-json `rate_limit_event`의 `status: "rejected"`(런타임이 창 이름과 재설정 시각을 붙임). "not your usage limit"(서버 일시 제한)은 일시 오류로 유지.
- `limit`이면 재시도 없이 `interrupted`로 끝나고 이어하기 정보(`resume.step`)를 남김. 안내: 한도가 풀린 뒤 이어하거나, 팀 선택에서 다른 런타임을 골라 지금 이어하기. Codex 한도면 이어하기 시작 때 자동 전환(35차)도 작동.
- 실제 한도 오류 모양은 공식 문서·공개 사례 기준이며 PC에서 아직 보지 못함. 처음 걸리면 이벤트 기록으로 확인. 테스트 231개.

## 38차 — 화면의 영어 서버 문구 한국어화
- 서버가 보내는 설정 파일 검사(config·역할 파일), 스킬 점검, 메모 검사 문구 약 70개를 대시보드에서 한국어로 표시(`web/src/server-text.ts`). "builder-skill: …", ".agent-desk/agents/lead.md: …", "2번 항목: …"처럼 앞의 위치는 그대로 두고 뒤 문장만 바꿈. 모르는 문구는 영어 그대로. 기존 HTTP 오류 표(`koApiErrors`)에 이어 붙여 `errorText`·저장 결과·프로젝트 경고 모두 같은 경로로.
- 메모 탭 전용 오류 변환(36차 직후 추가)은 이 경로로 합쳐 제거. 서버(에이전트용) 문구는 영어 유지. 테스트 231개.

## 39차 — 프로젝트 노트 볼트와 노트 화면 (ADR 0015)
- 헤르메스·옵시디언 검토 결과: 오케스트레이션은 Agent Desk에 두고(검증이 같은 대화 안에서 이뤄지므로), 옵시디언 볼트를 지식 저장소로 붙임. 헤르메스는 나중에 벤치마크 비교 대상.
- `config.vault`(기본 `.agent-desk/notes`), 폴더 specs·decisions·inbox·runs. 실행마다 `runs/` 노트(모델 호출 0), 메모 제안은 `inbox/` → 옵시디언에서 `status: approved`면 다음 실행 전에 memory.md + `decisions/`로.
- `read_notes` 도구(lead·builder, 제목 목록만 지침에, 내용은 필요할 때, runs·inbox 제외). 요구사항 `source`: 기획 노트를 인용하면 그 노트에 있는지 대조.
- 프로젝트 안의 볼트는 변경 감지·보호 경로에서 제외(실행 중 옵시디언 편집 허용).
- 대시보드 "노트" 화면: 링크 그래프, 폴더 목록, 편집기(링크 넣기, 새 노트, 이름 바꾸기, 휴지통, 승인), 나가는·들어오는 링크, 동시 편집 충돌 시 덮어쓰지 않음. 미리보기로 확인. 테스트 245개.

## 40차 — team 노트, 실행 → 역할 → 스킬 연결, 기존 기록 가져오기
- `team/roles/*`, `team/skills/*` 자동 생성 노트(읽기 전용, `generated: true`): 역할 → 스킬, 스킬 → 역할, 스킬을 실제로 읽은 실행과 횟수. 실행 기록 노트에 참여한 역할과 읽은 스킬 링크.
- 노트 화면: 팀 폴더, 생성 노트는 읽기 전용 + "설정에서 편집"(설정 창을 바로 엶), "기존 기록 가져오기" 버튼(지난 실행 노트, 기존 메모의 결정 노트, 모델 호출 0).
- 그래프 배치 개선: 경계에 붙던 노드 → 제한 없이 계산 후 상자에 맞춤, 거리 비례 중력, 링크 없는 노드는 맞춤 계산에서 제외. 테스트 247개.
- PC 확인(team 노트만 있을 때): 노드 6개가 이름 없이 양 끝으로 늘어남 → 작은 그래프(40개 이하)는 이름을 모두 표시, 가로·세로를 같은 비율로 맞추고 확대하지 않게(떨어진 묶음이 화면 끝으로 가지 않음).
- 3D 보기(기본, 2D 전환 가능, 선택 기억): 3차원 힘 배치 + 원근 투영, 천천히 자동 회전(동작 줄이기 설정이면 멈춤, 노트를 고르거나 올려두면 멈춤), 끌어서 돌리기, 휠 확대, 먼 노드는 작고 흐리게·이름 숨김. 외부 라이브러리 없음. 테스트 248개.
- 직접 쓴 결정 노트: `status: approved`면 다음 실행 전에 메모에 한 번 들어가고 `in-memory: true` 표시(메모 탭에서 지운 건 되살리지 않음). 테스트 249개.

## 41차 — 대시보드 재디자인 "관제실 + 에이전트 장면" (2026-11-21)
- 사용자가 시안 B(관제실 + 채팅 + 장면)를 골라 구현. 어두운 그래파이트 고정 테마, Noto Sans KR·JetBrains Mono.
- 위쪽 막대: 프로젝트 선택 상자(벤치 작업공간 묶음, "+ 프로젝트 열기", × 목록에서 빼기 확인), 탭(실행·노트·품질 기록·벤치마크), Codex 사용량 한 줄(가장 많이 쓴 창, 누르면 전체 게이지), 언어. 왼쪽 사이드바와 오른쪽 팀 레일은 없앰.
- 실행 화면: 왼쪽은 고른 실행(요청, 팀·스킬 칩, 장면/타임라인 전환과 기억, 질문, 결과 카드와 게이트·메모 제안·되돌리기·이어하기·평가, 단계 상세 접기), 오른쪽은 대화(요청 말풍선 + 누르면 왼쪽에 뜨는 짧은 답 카드, 진행 중 질문, 입력창과 팀·리뷰 선택). 새 실행이 시작되면 왼쪽이 자동으로 그 실행으로 바뀜.
- 장면(`agent-scene.tsx`, `scene.ts`): 아이소메트릭 방, 역할별 책상과 로봇(Codex 청록·Claude 보라 바이저, 상태 고리), 가운데 하네스 기둥과 G2·G3·G4 램프, 최근 말풍선 2개와 전달 경로 애니메이션(동작 줄이기 설정이면 멈춤). 말풍선은 하네스가 넘긴 내용뿐, 에이전트끼리 대화하지 않음. 같은 역할이 다시 시작하면(되돌려 보냄) 자기 자신에게 넘기는 말풍선 대신 REDO 말풍선만.
- 타임라인 보기: 역할별 줄에 단계 막대(런타임 색, 실행 중 깜빡임, 실패 테두리), 아래 줄에 하네스 검사 위치.
- 좁은 화면(1100px 이하)에서는 실행 → 대화 순으로 세로 배치. 미리보기(가짜 서버, 실행 중·완료·타임라인·좁은 화면·노트·설정)로 확인. 테스트 251개.

## 42차 — 에이전트 장면을 진짜 3D로 (2026-11-21)
- 사용자 피드백: 평면 그림(오뚜기)으로는 "AI가 일하는 모습"이 안 보임 → 역할별 3D AI 캐릭터로 다시 만듦.
- npm 설치가 막혀 있어(샌드박스·장치) Three.js 대신 의존성 없는 작은 WebGL 렌더러를 직접 작성(`gl3d.ts`: 행렬, 기본 도형, 노드 트리, 해·점광원·반구광·림광, 캔버스 텍스처, 투명 패스). 설치 없이 동작하고 헤드리스 브라우저로 확인 가능.
- `crew3d.ts`: 역할마다 다른 캐릭터(lead 헤드셋·태블릿, builder 안전모·공구 벨트, verifier 외알 안경·돋보기, researcher 목도리·책), 바이저 눈 색 = 런타임(Codex 청록, Claude 보라), 눈 깜빡임, 떠 있는 받침.
  - 상태별 동작: 일하는 중(builder 빠른 타이핑, lead 태블릿에 적기, verifier 돋보기로 훑기, researcher 책장 넘기기, 홀로그램 키보드), 쉬는 중(고개 숙이고 눈 어둡게, z z), 끝남(바뀐 순간 만세·한 바퀴, 방을 열 때 이미 끝난 상태면 재생 안 함), 실패(축 처지고 빨간 눈, 고개 흔들기), 질문(손 흔들기, 노란 눈).
  - 가운데 하네스 코어: 회전 링, 검사 램프 3개(변경 파일·테스트·리뷰), 작업물 상자가 보낸 역할 → 코어(스캔 번쩍) → 받는 역할로 날아감.
  - 역할 옆 화면: `stationOf`로 기록된 사실만 표시(현재 단계, 걸린 시간, 명령·파일 수, 되돌려 보낸 이유나 결과 문장, 검사 결과). 움직이는 막대는 "일하는 중" 표시일 뿐 내용 없음.
  - 말풍선은 코어 위(모든 전달은 하네스를 거침), 이름표는 머리 위. 끌어서 방 돌리기, 두 번 눌러 원래대로. 동작 줄이기 설정이면 멈춘 화면. WebGL이 없으면 타임라인으로 대체.
- 미리보기(실행 중·완료·실패·좁은 화면)로 확인. 테스트 252개.

## 43차 — Three.js 3D 사무실과 애니메이션 로봇 (2026-11-21)
- 사용자 피드백 "이게 최선이야?" → 도형 조립 캐릭터의 한계를 인정하고, 사용자가 PC에서 `three`, `@types/three` 설치와 CC0 로봇 모델(`web/public/models/RobotExpressive.glb`, Tomás Laulhé, three.js 예제) 내려받기를 해 줌.
- `office3d.ts`(Three.js): 역할마다 몸 색이 다른 로봇(lead 노랑+헤드셋, builder 주황+노란 안전모, verifier 보라+돋보기·외알 안경, researcher 초록+책·목도리), 서서 일하는 책상(키보드 빛, 가장자리 줄 = 런타임 색), 뒤쪽 벽 화면(기록된 사실만, `stationOf`), 가운데 하네스 검사 게이트(스캔 아치, 수정, 램프 3개 + 점광원).
  - 진짜 그림자, 환경광(RoomEnvironment), 빛 번짐(UnrealBloom), ACES 톤 매핑.
  - 동작: 모델 애니메이션(Idle, Walking, Wave, ThumbsUp, Yes, No) + 일할 때 팔을 키보드로 뻗는 2관절 IK(타이핑 손 높이 변화), 역할별 손 위치(verifier 돋보기로 훑기, lead 태블릿, researcher 책), 표정(실패 Sad, 질문 Surprised).
  - 전달: 실행 중 새 전달이 생기면 보낸 역할이 서류를 들고 게이트까지 걸어가고, 게이트가 스캔하며 빛나고, 서류가 받는 역할 책상으로 날아감. 하네스가 되돌려 보낸 경우는 게이트에서 바로 출발.
  - 끝난 일의 책상에는 서류가 놓임. 방을 열 때는 지난 동작을 다시 재생하지 않음.
- Three.js는 장면을 열 때만 동적으로 불러옴(대시보드 첫 로딩에 영향 없음). 모델이 없거나 WebGL이 없으면 타임라인으로 대체. 서버 MIME에 `.glb` 추가. 이전 자체 렌더러(`gl3d.ts`, `crew3d.ts`) 삭제.
- 미리보기(소프트웨어 렌더링이라 1.5fps)로 배치·동작 확인. 실제 속도는 PC GPU에서 확인 필요. 테스트 252개.

## 44차 — 자유롭게 움직이는 사무실 (2026-11-21)
- 사용자 피드백: 세 에이전트 움직임이 똑같음 → 자유롭게 걸어 다니는 개발 사무실로.
- `office-life.ts`(순수 로직, 테스트 4개): 사무실 자리(커피 바 2, 화이트보드 2, 라운지 2, 서버 랙, 책장, 창가), 가구·게이트를 원으로 두고 돌아가는 경로(`route`), 로봇별 시드 난수(`seeded`), 다음 할 일(`nextPlan`). 실제 상태가 먼저: 일하는 중·실패면 책상, 질문이면 앞으로 나와 손 흔들기, 쉬는 중·끝남이면 역할 취향대로 자리 고르기, 다른 쉬는 로봇과 대화, 책상에서 쉬기.
- `office3d.ts`: 소품(커피 바와 머신·컵, 화이트보드, 빈백·테이블, 깜빡이는 서버 랙, 책장, 밤 도시 창, 화분), 로봇마다 애니메이션 속도·시작 시점·걷는 속도가 다름, 자리별 자세(커피 마시기, 화이트보드에 쓰기, 라운지에서 머리 뒤로 손, 창가에서 뒷짐, 책 읽기, 랙 가리키기, 대화 중 끄덕이기), 책상에서도 타이핑·생각(턱 괴기)·기지개가 번갈아. 이름표는 로봇을 따라다님. 카메라는 사무실 전체를 봄.
- 테스트 256개.

## 45차 — 실제 사용 첫 문제: 로그인 페이지 실행 (2026-11-22)
- 사용자 실행(빈 폴더 "login TEST", HTML 로그인 페이지)을 이벤트 기록으로 분석. 전체 2분 6초: 분류 5초, 구현 1분 59초(파일 작성 37초, 스스로 만든 PowerShell 검사 3번 30초, 보고 거부 2번 20초), 리뷰 2초에 Claude 로그인 만료로 끝남.
- 고친 것:
  - 로그인 만료를 `auth` 실패로 분류(OAuth 만료, Not logged in, Invalid API key). 리뷰 결과 없음(needs_review) 대신 이어할 수 있는 중단 + 다시 로그인하는 방법(Claude `/login`, Codex `codex login`) 안내.
  - 화면 타임라인 축이 "47419s"로 보이던 문제: 리뷰가 실패해 닫히지 않은 build 단계가 "지금"까지 늘어남 → 실행이 끝나면 열린 단계를 실행 종료 시각에 닫음. 막대 안 단계 이름이 세로로 한 글자씩 쪼개지던 것도 말줄임으로.
  - 검증 명령이 없어 G3가 건너뛰어졌는데 "테스트 통과"로 보이던 것 → "테스트 건너뜀"(회색). 실제로 하지 않은 검사를 통과로 보이지 않게.
  - 보고 거부 사유를 이벤트에 남김(지금까지는 "3 problem(s)"만 남아 원인 추적 불가).
  - builder 지침: Windows PowerShell에서 파일을 읽어 확인할 때 `-Encoding UTF8`(안 하면 한국어 비교가 실패해 검사를 고치느라 시간을 씀), 테스트가 없는 프로젝트는 짧게 확인하고 자체 확인이라고 보고, 틀린 검사는 조건을 빼지 말고 고치고 알릴 것.
- 테스트 257개.
