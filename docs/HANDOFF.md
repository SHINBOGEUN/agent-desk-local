# 인수인계 (Claude ↔ Codex)

Claude와 Codex가 같은 저장소에서 번갈아 작업하기 위한 문서입니다. **세션을 시작하면 이 문서를 먼저 읽고, 끝내기 전에 맨 아래 "인수인계 기록"에 한 항목을 추가하세요.** 대화 내용은 서로 볼 수 없으니, 저장소에 남긴 파일만이 공유되는 정보입니다.

## 프로젝트 한 줄 요약

Agent Desk v2: 코드가 작업 순서와 완료 판정을 정하고, 모델(Codex·Claude)은 교체 가능한 런타임으로 작업만 하는 **로컬 하네스**(TypeScript, Node 22.18+). v1은 `legacy/`에 동결돼 있고, 목표는 "에이전트를 많이 쓸수록 좋은 게 아니다"를 실측 수치로 보이고 더 나은 구조로 개선하는 것입니다(이력서 근거 자료).

## 읽는 순서

| 순서 | 파일 | 읽는 이유 |
|---|---|---|
| 1 | `AGENTS.md` | 작업 규칙(v1에서 온 것, 검증·보고 원칙) |
| 2 | `docs/design-v2.md` | **전체 설계(개정 2)**. 특히 "실행 흐름", "런타임 어댑터 계약", "결정론적 게이트", "관측과 토큰", "개발 단계" |
| 3 | `docs/adr/0001~0003` | 결정과 근거. 0003은 Codex·Claude 연결 실험 결과 |
| 4 | `docs/WORKLOG.md` | 지금까지 한 일 |
| 5 | `bench/README.md`, `bench/results/benchmark-report.md` | 벤치마크 구성과 v1 기준선 결과 |
| 6 | `packages/core/src/*.ts`, `packages/runtime-fake/src/index.ts` | 이미 있는 코드(타입, 보고 검증, 토큰 원장, 가짜 런타임) |
| 7 | `scripts/proto/p1-codex.mjs`, `p2-claude.mjs` | 실제로 동작을 확인한 Codex App Server·Claude CLI 호출 방식(참고 구현) |

설계 원본은 Claude 문서(링크는 `docs/README.md`)이고 `docs/design-v2.md`는 그 사본입니다. 설계를 바꿀 때는 사본과 ADR을 고치고, 원본 문서는 Claude가 다음 세션에서 맞춥니다.

## 현재 상태 (2026-11-13)

| 단계 | 상태 |
|---|---|
| 0. 레거시 분리와 기준선 | v1 이동·기준선 `v1-13`(과제 10개 × 2회) 완료. 어려운 과제 H01~H05 작성 완료, `v1-13-hard` 측정 완료(15/15 성공, 거짓 완료 0, 검토 필요 9건 전부 `NOT_VERIFIED`) |
| 1. 골격과 프로토타입 | `core`, `runtime-fake` 완료, P1·P2·P3 완료(ADR 0003) |
| 2. 코어 워크플로 | **다음 작업** |
| 3~6 | 시작 전 |

핵심 실험 결과(ADR 0003)
- Codex: 하네스 MCP 서버를 스레드 `config`로 붙이고 `mcp_servers.agentdesk.default_tools_approval_mode = "approve"`를 주면 승인 정책 `never`에서도 도구 호출이 됩니다. 이 설정이 없으면 호출이 거부됩니다.
- Codex 토큰: `thread/tokenUsage/updated`의 `last`가 턴 증분이고 합이 `total`과 같습니다. 턴마다 약 1.7만 토큰의 기본 비용이 듭니다.
- Claude: `claude -p --input-format stream-json --output-format stream-json`로 한 프로세스에서 다중 턴이 됩니다. 턴별 `usage`는 증분이고 `total_cost_usd`는 누적입니다. `--allowedTools`는 도구를 제한하지 않으므로 읽기 전용 역할은 도구 목록 제한 옵션을 따로 써야 합니다(구현 때 테스트로 확인).

## 다음에 할 일 (2단계, 이 순서 권장)

각 항목의 "끝나는 조건"을 만족해야 완료입니다. 실제 Codex·Claude를 호출하는 확인은 사용자 PC에서만 가능하니 **스크립트로 만들어 두고 사용자에게 실행을 요청**하세요.

| 순서 | 작업 | 끝나는 조건 |
|---|---|---|
| 2-1 | `packages/tools-mcp`: stdio MCP 서버. 도구 `submit_report`(보고 종류별 `validateReport`로 검증), `request_user_input` | 도구 호출 시 잘못된 보고는 필드 경로가 담긴 오류를 돌려주고 테스트가 통과 |
| 2-2 | `packages/runtime-codex`: App Server JSON-RPC 클라이언트. `Runtime` 인터페이스 구현, 이벤트 정규화, 토큰 `last` 기록(`UsageLedger`), 중단, MCP 프로세스 정리, 실행 파일 탐색(`doctor`) | 가짜 App Server 스텁으로 단위 테스트, `scripts/proto/p1-codex.mjs`와 같은 흐름의 실행 스모크 스크립트 |
| 2-3 | 오케스트레이터: `answer`(빠른 경로), `build` 워크플로를 `runtime-fake`로 구동 | 설계서 "실행 흐름"의 순서대로 동작하는 테스트 |
| 2-4 | 게이트 G1(보고 형식)·G2(변경 대조, 보호 경로 `.agent-desk/`·`.git/`)·G3(verify 명령)·G5(예산), REDO 최대 2회, 실패 유형 분류 | 설계서 "결정론적 게이트" 표의 각 행에 대응하는 테스트 |
| 2-5 | verifier와 G4(독립 리뷰, 리뷰 정책 `always/auto/never`) | 새 세션·읽기 전용·`review` 설정 테스트 |
| 2-6 | SQLite(`node:sqlite`) 이벤트 저장 최소판 + Run Brief(1,500자 이내) | 재시작 후 Run 복구 테스트 |
| 2-7 | CLI `agent-desk run`, `agent-desk doctor` | `runtime-fake`로 끝까지 실행되는 CLI 테스트 |
| 2-8 | `runtime-fake`로 v1 실패 사례 재현 테스트(거짓 완료, 환경 오류, REDO 초과) | 세 사례가 각각 올바른 상태로 끝남 |
| 2-9 | 벤치마크 `bench/adapters/v2.mjs` (`bench/adapters/v1.mjs`와 같은 형태) | `bench/selftest.mjs` 통과 |
| 2-10 | (사용자 PC) `v2-codex` 측정, 리뷰 정책 3종 비교 | 사용자가 실행 |

## 작업 규칙

1. **건드리지 않는 것**: `legacy/`(v1 동결), `bench/tasks/T01~T10`과 `H01~H05`(측정의 기준이라 수정 금지. 고쳐야 하면 먼저 사용자에게 알리기), `bench/results/`(측정 결과)
2. **코드 스타일**: TypeScript, 빌드 없이 Node 타입 제거로 실행(`erasableSyntaxOnly`: enum·namespace·parameter property 금지). 패키지 간 import는 루트 `package.json`의 `imports`(`#core` 등)를 쓰고, 새 패키지는 필요할 때 거기에 추가합니다. 의존성은 최소로 두고, 추가하면 이유를 ADR에 적습니다(이미 zod를 쓰지 않기로 했습니다).
3. **검증**: 바꾼 뒤에는 `npm test`와 `npm run typecheck`가 통과해야 합니다. 이 저장소의 `npm install`이 필요하면 사용자 PC에서 실행됩니다. 화면을 만들었다면 실제 브라우저에서 확인합니다(`AGENTS.md`).
4. **Claude는 이 PC에서만, 사용자 본인 용도로만** 씁니다. 서버는 `127.0.0.1`에만 열고 계정 공유 기능을 만들지 않습니다.
5. **측정 값은 만들어 내지 않습니다.** 벤치마크 수치는 `bench/results/`의 파일에서만 옮깁니다. 확인하지 못한 것은 "확인하지 못함"으로 적습니다.
6. **결정이 바뀌면** `docs/adr/`에 새 파일(번호 이어서)을 쓰고 `docs/design-v2.md`를 맞춥니다.
7. **커밋**: 작은 단위로, 메시지에 무엇을·왜 적습니다. PC의 git은 `-c core.autocrlf=true`가 필요할 수 있습니다. 이 저장소의 원격 push는 사용자가 합니다.
8. **측정과 겹치지 않기**: (지금은 기준선 측정이 끝났지만 `v2-*` 측정이 시작되면) 사용자 PC에서 벤치마크가 도는 동안은 Codex·Claude 실제 호출(프로토타입, 스모크 테스트)을 하지 않습니다. 사용량 지표가 섞입니다. 가짜 런타임으로 하는 개발과 테스트는 괜찮습니다.

## 협업 방식

- 작업 전에 `git status`와 이 문서의 "인수인계 기록" 마지막 항목을 확인합니다.
- 두 도구가 같은 파일을 동시에 고치지 않도록, 한 번에 한 쪽만 작업합니다(사용자가 순서를 정합니다).
- Claude는 설계 변경, 문서(로드맵 탭, ADR), 리뷰와 측정 결과 해석을 주로 맡고, Codex는 구현을 주로 맡습니다. 필요하면 사용자가 바꿉니다.
- Codex가 한 일은 `docs/WORKLOG.md`에도 한 줄 추가합니다. Claude가 로드맵 탭의 체크박스를 그 기록에 맞춰 갱신합니다.

## 인수인계 기록

각 항목: 날짜, 누가, 무엇을 했나(커밋), 확인한 것과 못 한 것, 다음 사람이 할 일.

### 2026-11-13 · Claude
- 한 일: 어려운 과제 H01~H05 작성·검증, P1·P2 프로토타입 실행과 ADR 0003, 설계서 개정 2, 이 문서 작성.
- 확인한 것: `node bench/validate-tasks.mjs` 통과(과제 15개 모두 원본 실패·모범 답안 통과), `node bench/selftest.mjs` 통과.
- 확인하지 못한 것: `v1-13-hard` 측정 결과(진행 중), 이 작업의 커밋(사용자가 커밋·push 예정).
- 다음 사람이 할 일: 2-1 `tools-mcp`부터. 측정이 끝나기 전에는 실제 Codex·Claude를 호출하는 확인은 하지 않기.

### 2026-11-13 · Claude (2차)
- 한 일: 2-1 `packages/tools-mcp` 구현. 도구 3개(`submit_report`, `request_user_input`, `approve`), stdio MCP 서버(`bin.ts`), 세션별 토큰을 쓰는 127.0.0.1 HTTP 브리지(`ToolEndpoint`), 보고 검증기(`ReportCollector`, 거절 시 필드 경로 반환). `HarnessTools`에 `approve?` 추가.
- 확인한 것: 테스트 23개 통과(실제 자식 프로세스 e2e 포함), `tsc --noEmit` 통과.
- 확인하지 못한 것: 실제 Codex·Claude가 이 서버를 띄워 호출하는 것(2-2에서 확인).
- 다음 사람이 할 일: 2-2 `runtime-codex`. `mcpServerCommand(registration)`이 MCP 서버 실행 명령을 준다. Codex에는 ADR 0003대로 `default_tools_approval_mode = "approve"` 설정.

### 2026-11-13 · Claude (3차)
- 한 일: 2-2 `packages/runtime-codex`. 세션마다 `codex app-server` 프로세스 1개, `thread/start`에 MCP 서버 설정(`default_tools_approval_mode = "approve"`, ADR 0003), 샌드박스 `read-only`/`workspace-write` + `approvalPolicy never`, `thread/tokenUsage/updated`의 `last`를 usage 증분으로 변환, AbortSignal → `turn/interrupt`, 서버 승인 요청은 `approval_request` 이벤트로 알리고 거절, 서버가 죽으면 `turn_end failed`.
- 확인한 것: 가짜 app-server 테스트(실제 `tools-mcp` 프로세스를 거쳐 보고 제출까지) 포함 전체 32개 통과, `tsc --noEmit` 통과.
- 확인하지 못한 것: 실제 Codex와의 연결. `item/completed`의 `agentMessage`·`commandExecution`·`fileChange` 필드 이름(`text`, `command`, `aggregatedOutput`, `exitCode`, `changes[].kind.type`)과 `turn/completed`의 `turn.error.message`는 알려진 프로토콜을 바탕으로 한 가정입니다. 사용자 PC에서 `scripts/proto`식 실행으로 확인 필요(2-7 `doctor`/2-10에서).
- 다음 사람이 할 일: 2-3 오케스트레이터(answer/build).

### 2026-11-13 · Claude (4차)
- 한 일: 2-3 `packages/orchestrator`. `runRequest(request, config)`: lead 세션(읽기 전용, effort low)이 분류하고, `answer`면 같은 보고에 담긴 답으로 바로 끝(빠른 경로, builder 세션 없음), `build`면 builder 세션(workspace-write)이 보고를 제출. builder 보고는 Run 요구사항 id를 빠짐없이·중복 없이 다뤄야 하며(`ReportCollector`에 `check` 추가), 열린 요구사항(`not_done`/`unverified`)이 있으면 `needs_review`. 보고 없이 턴이 끝나면 1회 재요청 후 실패, 사용자 질문은 `askUser`로 전달(없으면 `needs_user`), 중단 신호는 `interrupted`, 역할별 런타임 지정 가능, 이벤트는 `onEvent`·`RunResult.events`로 기록, 토큰은 단계별 증분으로 `UsageLedger`에 기록.
- 확인한 것: 전체 41개 테스트 통과, `tsc --noEmit` 통과(가짜 런타임으로만).
- 아직 없는 것: G2·G3·G5, REDO, 실패 유형 분류와 일시 오류 재시도(2-4), 리뷰(2-5), `investigate`·`plan-build`(3단계, 지금은 failed로 끝남), 사용자가 대시보드에서 워크플로를 직접 고르는 기능.
- 다음 사람이 할 일: 2-4 게이트와 REDO.

### 2026-11-13 · Claude (5차, 설계 개정 3)
- 한 일: 사용자의 Notion 책 정리 노트를 설계에 대조해 반영(ADR 0004), 게이트 정책 3건 결정 기록(ADR 0005), `docs/design-v2.md`와 원본 Claude 문서(개정 3)·로드맵 탭 갱신.
- 구현에 영향: ① 2-4는 ADR 0005를 따름(unverified 정책, G2 무시 패턴, 총 토큰 예산). ② 역할 지침은 4단계에서 `.agent-desk/agents/<role>.md`로 옮길 예정이라 지금의 `orchestrator/src/prompts.ts`는 내장 기본값으로 둠. ③ 2-5 리뷰 정책 측정에는 '같은 세션 자체 점검' 구성을 비교 대상으로 넣을 것.
- 확인하지 못한 것: 책 내용 자체의 정확성은 사용자 노트를 근거로만 반영함(원문 확인 안 함).
- 다음 사람이 할 일: 2-4 게이트 G2·G3·G5와 REDO(ADR 0005 기준).

### 2026-11-13 · Claude (6차)
- 한 일: 2-4. `snapshot.ts`(변경 대조용 스냅샷, 보호 경로 복원), `gates.ts`(G2 변경 대조·읽기 전용 0건, G3 verify 실행·제한 시간, G5 총 토큰·시간), `failure.ts`(환경·일시·기타 분류), `run.ts` 갱신. 정책은 ADR 0005를 따름.
  - build: 보고 → G2·G3 → 요구사항 `not_done` 확인 → 실패 사유가 있으면 REDO(최대 2회, 첫 번째는 같은 세션, 두 번째는 실패 요약을 담은 새 세션), 그래도 실패면 `needs_review`.
  - 보호 경로(`.agent-desk/`, `.git`의 HEAD·config·refs) 변경은 복원하고 `failed`. 읽기 전용 단계(classify)에서 파일이 바뀌면 `needs_review`.
  - verify 명령이 실행 불가(명령 없음)면 REDO가 아니라 환경 오류로 즉시 실패. 일시 오류는 단계당 1회 새 세션으로 재시도.
  - `unverified`: G3 통과 시 `completed` + `RunResult.unverified`, verify 명령이 없으면 `needs_review`. 테스트 파일이 바뀌면 `RunResult.warnings`에 표시(2-5에서 리뷰 생략 금지에 사용).
  - 예산은 usage 이벤트마다 검사해 넘으면 턴을 중단하고 `interrupted` + `resume` 기록.
- 확인한 것: 전체 58개 테스트와 `tsc --noEmit` 통과(가짜 런타임, 실제 명령 실행 포함).
- 아직 없는 것: G4 리뷰(2-5). `RunResult.warnings`의 테스트 파일 변경 표시는 아직 리뷰 정책과 연결되지 않음. 사용률(Codex 5시간 한도) 기반 G5는 4단계.
- 다음 사람이 할 일: 2-5 verifier와 G4, 리뷰 정책 `always/auto/never`.

### 2026-11-13 · Claude (7차)
- 한 일: 2-5. `review.ts`(정책 결정 `decideReview`, 리뷰 프롬프트), `diff-text.ts`(변경 파일의 줄 단위 diff, 스냅샷에 작은 파일 본문 보관), 검증자 지침(`prompts.ts`), `run.ts`에 G4 연결.
  - 리뷰는 builder와 다른 새 세션(역할 `verifier`, 읽기 전용, 런타임 따로 지정 가능). 입력은 사용자 원문·요구사항·실제 diff·G3 결과이고 builder의 요약·추론은 주지 않음. 테스트 파일이 바뀌면 "검사를 약화했는지" 명시적으로 판단하도록 요구.
  - 정책: `always`(기본), `auto`(verify 통과 + 3파일·60줄 이하 + 테스트·보안 경로 없음일 때만 생략, verify가 없으면 리뷰), `never`. `config.review`, `config.autoReview`로 설정.
  - 판정: `PASS` → 완료, `REDO` → blocking 항목이 REDO 사유가 되어 builder로(REDO 한도 공유, 매번 새 verifier 세션), `BLOCKED`는 사유 필수 — G3 통과면 `completed` + `unverified`에 표시, verify가 없으면 `needs_review`. 검증자가 파일을 바꾸거나 판정 없이 끝나면 `needs_review`.
- 확인한 것: 전체 66개 테스트와 `tsc --noEmit` 통과(가짜 런타임).
- 아직 없는 것: '같은 세션 자체 점검' 비교 구성(3-5), 실제 모델이 판정 기준을 따르는지(2-10 측정으로 확인).
- 다음 사람이 할 일: 2-6 SQLite 이벤트 저장과 Run Brief.

### 2026-11-13 · Claude (8차)
- 한 일: 2-6. `packages/store`(`RunStore`: runs·steps·events·usage 테이블, 스키마 버전 관리, 이벤트 저장 콜백 `recorder(runId)`, `finishRun`, `recoverInterrupted`, `latestBrief`), 비밀값 가리기와 긴 문자열 4,000자 절단, `orchestrator/run-brief.ts`(코드가 만드는 1,500자 이내 Run Brief), `RunConfig.previousBrief`(classify 단계에만 전달).
- 확인한 것: 전체 73개 테스트와 `tsc --noEmit` 통과. 저장된 토큰 합계가 이벤트 로그의 턴 증분 합과 일치, 비정상 종료 후 재시작 시 `running` Run이 `interrupted`로 표시되고 다시 실행되지 않음.
- 아직 없는 것: `quota_samples` 테이블(Codex 한도 추적은 4단계), `node:sqlite`가 실험 기능이라 첫 import 때 경고가 한 번 출력됨(동작에는 영향 없음).
- 다음 사람이 할 일: 2-7 CLI `agent-desk run`·`doctor`.


### 2026-11-13 · Claude (9차)
- 한 일: 2-7. `packages/cli`(`main.ts` run·doctor, `discover.ts` Codex 탐색(Windows `codex.cmd` 셈은 따라가 실제 `codex.exe` 사용)·버전 범위 경고(0.167.x 확인됨), `config.ts` 프로젝트 설정 검증(알 수 없는 키는 오류), `paths.ts` 데이터 폴더·PC별 `machine.json`, `format.ts`). `npm run agent-desk -- run "요청" [--unattended --verify "cmd" --review auto --max-tokens N --max-minutes N --json]`, `doctor`.
  - 종료 코드: completed 0, failed 1, needs_review 2, needs_user 3, interrupted 4, 사용법 오류 64. `--unattended`는 질문을 하지 않고 `needs_user`로 끝냄.
  - 실행마다 RunStore에 기록하고 직전 Run Brief를 classify에 전달. doctor는 verify 명령이 없으면 FAIL과 후보(`npm test`)를 안내만 하고 설정 파일은 고치지 않음.
- 확인한 것: 전체 84개 테스트와 `tsc --noEmit` 통과(FakeRuntime으로 run·doctor·질문·설정 오류·Codex 탐색).
- 아직 없는 것: 실제 Codex로 실행(2-10, 사용자 PC), AGENTS.md/CLAUDE.md 차이 점검, Claude 실행 파일 탐색(3단계). 출력은 영어(PowerShell 5 인코딩 문제 회피).
- 다음 사람이 할 일: 2-8 v1 실패 재현 테스트, 2-9 벤치 어댑터.

### 2026-11-13 · Claude (10차)
- 한 일: 2-8. `orchestrator/test/v1-failures.test.ts`에 v1 실패 사례 7개를 끝-대-끝으로 재현: 거짓 완료 2건(변경 없이 "완료" 보고, 보고한 테스트 통과가 G3를 대신하지 못함) → 둘 다 `completed`가 아님, 환경 오류 2건(실행 불가 verify 명령, 런타임 시작 실패) → `failed`·REDO 0회, REDO 초과 → `needs_review`·REDO 2회, 거짓 경보 2건(unverified 주장 + G3 통과, 검증자 BLOCKED + 사유 + G3 통과) → `completed`.
- 확인한 것: 전체 91개 테스트와 `tsc --noEmit` 통과.
- 아직 없는 것: 실제 모델에서 같은 결과가 나오는지는 2-10 측정에서 확인.
- 다음 사람이 할 일: 2-9 `bench/adapters/v2.mjs`(`bench/selftest.mjs` 통과 필요).

### 2026-11-13 · Claude (11차)
- 한 일: 2-9. `bench/adapters/v2.mjs`(과제마다 `agent-desk run --json --unattended --verify "npm test"` 실행, RunResult → 공통 지표: 에이전트 수는 builder·verifier 등 lead 제외 역할, 검증자 판정 PASS/REDO→FAIL/BLOCKED→NOT_VERIFIED, REDO·게이트 결과 추가), `bench/run.mjs`에 `--adapter v2`와 `--review/--runtime/--verify/--max-tokens/--max-minutes/--cli` 옵션, `bench/selftest.mjs`에 가짜 CLI로 v2 어댑터 검증(거짓 완료 판정, 인자 전달, 지표) 추가.
- 확인한 것: v1·v2 `bench/selftest.mjs` 통과, 전체 테스트 통과.
- 아직 없는 것: 실제 Codex 측정(2-10, 사용자 PC), 5시간 사용률 한도 연동(4단계), 타임아웃 시 CLI를 강제 종료(Windows는 신호 불가).
- 다음 사람이 할 일: 2-10 사용자 PC에서 `npm run bench:run -- --adapter v2 --label v2-codex-auto --review auto` 등 측정(review always/auto/never 비교).

### 2026-11-13 · Claude (12차)
- 한 일: 2-11. `orchestrator/restore-point.ts`(`createRestorePoint`, `revertToRestorePoint`), `RunConfig.restorePointDir`·`RunResult.restorePoint`, build 직전 복사(5,000파일·100 MB 초과 시 경고만), CLI `agent-desk revert <run id> [--yes]`(계획 먼저, 적용은 `--yes`), 최근 10개 Run만 보관, `needs_review`/`failed` 종료 시 되돌리기 안내. 결정은 ADR 0006(git 참조는 나중).
- 확인한 것: 전체 95개 테스트와 `tsc --noEmit` 통과.
- 아직 없는 것: 대시보드의 되돌리기 버튼(5단계), git 기반 복원 지점.
- 다음 사람이 할 일: 2-10(사용자 PC 실측). 2단계 코드는 여기까지이며, 다음 구현은 3단계(Claude 런타임, plan-build·investigate).

### 2026-11-13 · Claude (13차)
- 한 일: 3-1·3-2. `packages/runtime-claude`(`claude -p` stream-json 세션, `--tools`로 도구 제한, `--permission-prompt-tool`, MCP 설정 임시 파일, 어시스턴트 메시지 id별 토큰 증분과 result 합계 보정, 중단은 control_request 후 유예 시간 뒤 강제 종료, `doctor`), `orchestrator/approval.ts`(허용 목록 + 거부 정책, `RunConfig.allowCommands`, 승인 결과 이벤트), CLI `--runtime claude`·`config.runtimes`·Claude 실행 파일 탐색(PATH → `~/.local/bin`). 결정은 ADR 0007.
- 확인한 것: 전체 112개 테스트와 `tsc --noEmit` 통과(가짜 claude CLI가 실제 MCP 서버를 호출).
- 아직 없는 것: 실제 Claude Code 확인 — `--tools` 쉼표 목록, `assistant`/`user` 메시지 형태, 권한 질문(`approve`) 호출·응답 형식, Bash 종료 코드(현재 `is_error`로 0/1), `--effort` 같은 추가 플래그는 쓰지 않음. 사용자 PC에서 스모크 스크립트로 확인 필요(아직 작성 안 함).
- 다음 사람이 할 일: 3-3 `plan-build`·`investigate` 워크플로, 스모크 스크립트 `scripts/smoke/`, 3-4·3-5·3-6 측정(사용자 PC).

### 2026-11-13 · Claude (14차)
- 한 일: 3-3. 보고 종류 `plan`(approach·steps·files·risks, steps 1개 이상)·`research`(angle·summary·findings·sources) 추가(core 스키마), lead 지침을 4개 워크플로로 확장(investigate는 요구사항 = 조사 관점 최대 3개), 계획 단계용 planner 지침(lead 역할, 읽기 전용)과 researcher 지침, `run.ts`에 `runPlan`·`runInvestigate`(researcher 병렬, 읽기 전용 스냅샷 가드, 결과는 코드가 조립해 `answer`로 제공), `plan-build`는 계획을 builder 프롬프트(REDO 새 세션 포함)에 넣음. `RunConfig.confirmPlan`(CLI 대화형 실행에서는 "계획대로 진행할까요" 질문, `--unattended`는 그대로 진행), `RunResult.plan`·`research`.
- 확인한 것: 전체 119개 테스트와 `tsc --noEmit`, 벤치 selftest 통과.
- 아직 없는 것: 실제 모델이 4개 워크플로를 올바르게 고르는지(3-6 분류 정확도 측정), 계획이 실제로 품질·토큰에 도움이 되는지(측정 필요). researcher 병렬 중 한 명이 일시 오류여도 재시도는 단계당 1회 공유.
- 다음 사람이 할 일: 사용자 PC에서 `scripts/smoke/runtime.ts` 실행(codex, claude) 후 결과 확인, 3-4·3-5·3-6 측정. 코드 쪽 다음 단계는 4단계(서버, 설정·역할 md 파일, `init`, `skills check`).

### 2026-11-13 · Claude (15차)
- 한 일: 4-2·4-6·4-7. `packages/project`(config 검증, 역할 파일 파서, 런타임 배정, `init` 검사·초안), CLI가 이 패키지를 사용(`cli/src/config.ts` 삭제). **설정 형식 변경**: 이전의 `runtime`·역할별 `runtimes` 맵 대신 설계서대로 `runtimes: {primary, review}`와 `roles.<role>.runtime`. 역할 파일의 effort·model·본문이 `RunConfig.effort/models/roleNotes`로, access는 `RunConfig.access`(builder 제한만)로 전달. `agent-desk init [--yes]`, `doctor`에 역할 파일 4개·AGENTS/CLAUDE 불일치 점검 추가.
- 확인한 것: 전체 129개 테스트와 `tsc --noEmit` 통과.
- 아직 없는 것: 스킬 배치·검증(4-8), 프로젝트 메모(4-9), 서버(4-1), 5시간 한도(4-3), 사용자 숙련도 감지는 테스트·CI·커밋 수로 리뷰 정책 제안만 함(별도 감지 없음).
- 다음 사람이 할 일: 4-8 `skills check`.

### 2026-11-13 · Claude (16차)
- 한 일: 4-8·4-9. `project/skills.ts`(`checkSkills`), CLI `agent-desk skills check`(오류 있으면 종료 코드 1). `project/memory.ts`(`addMemory`·`newSuggestions`·상한), `BuilderReport.memorySuggestions`(선택, 최대 5개 스키마·지침은 3개), `RunConfig.projectMemory`(모든 역할 지침에 포함), `RunResult.memorySuggestions`, CLI `agent-desk memory [add "<fact>"]`와 run 종료 시 제안 출력·대화형 승인.
- 확인한 것: 전체 135개 테스트와 `tsc --noEmit` 통과.
- 아직 없는 것: 스킬을 런타임에 실제로 배치(`.agents/skills`, `.claude/skills`)하고 세션에 `SkillRef`로 전달하는 부분 — 지금은 검증만 하고 `config.skills`/역할 파일의 `skills`는 아직 세션에 전달되지 않음. 트리거 검증·with/without 비교(6단계).
- 다음 사람이 할 일: 4-1 서버(HTTP + SSE, v1 보안 장치 이식).

### 2026-11-13 · Claude (17차)
- 한 일: 4-1. `packages/service`(`executeRun`, 실행 파일 탐색, 데이터 폴더)로 CLI 실행 로직 추출, `packages/server`(HTTP + SSE, v1 보안 장치 이식), CLI `serve`. 취소하면 대기 중인 질문도 함께 풀림.
- 확인한 것: 전체 141개 테스트와 `tsc` 통과(보안 헤더·Host/Origin·CSRF, 실행 시작·SSE·afterSeq, 409·400, 질문 응답·취소).
- 아직 없는 것: 정적 대시보드 파일 서빙(5단계), 폴더 선택 창, 5시간 사용량(4-3), 프로세스 관리·Supabase(4-4). SSE는 저장소를 0.4초마다 읽는 방식(단순·재접속 안전), 실시간 푸시가 필요하면 나중에 교체.
- 다음 사람이 할 일: 4-3 Codex 5시간 사용량 이식, 4-4, 이후 5단계 대시보드.

### 2026-11-13 · Claude (18차)
- 한 일: 4-3. `packages/service/src/usage-limits.ts`(정규화·증가분·가드), `CodexRuntime.readRateLimits()`, `executeRun`이 `limits.codexUsagePercent`/`--max-usage-percent`로 가드를 켜고 한도에 닿으면 실행을 중단해 `interrupted`로 기록.
- 확인한 것: 전체 147개 테스트와 `tsc` 통과(가짜 app-server·가짜 한도 응답).
- 아직 없는 것: 실제 Codex의 `account/rateLimits/read` 응답 형태 확인(v1에서 쓰던 형태 그대로 가정, 스모크 스크립트에는 아직 없음), 조회 주기 15초 기본값 조정, 대시보드 표시(5단계).
- 다음 사람이 할 일: 4-4 프로세스 관리·Supabase 이식 여부 결정(모여Go 운영에 필요한지), 사용자 PC에서 4-5.

### 2026-11-15 · Claude (19차)
- 한 일: 4-8 후속, 스킬 런타임 배치. `packages/project/src/index.ts`에 `skillsByRole(project, loaded, onSkip?)`(역할 파일의 `skills`, `config.skills`가 있으면 그 안에서만, 없거나 `skills check` 오류인 스킬은 제외하고 이유 안내), `RunConfig.skills`(역할별 `SkillRef[]`), `openSession`이 `SessionOptions.skills`에 넣고 `instructionsFor(..., skills)`가 "id: 설명 (SKILL.md 경로)" 목록과 사용 규칙을 붙임(`skillsText`). `executeRun`이 연결. **스킬 파일은 복사하지 않음**: 설계서의 "런타임별 위치에 배치"를 ADR 0008로 바꾸고 `docs/design-v2.md` 사본 수정.
- 확인한 것: 전체 149개 테스트 통과, `tsc` 통과(이 작업 환경에는 저장소 `node_modules`가 없어 외부 `@types/node`를 가리키는 임시 tsconfig로 실행 — 사용자 PC에서 `npm run typecheck` 한 번 확인 권장).
- 아직 없는 것: 실제 모델이 목록을 보고 SKILL.md를 읽는지(6단계 트리거 검증·스킬 유무 비교), Run 설정 스냅샷에 스킬 목록 기록, 대시보드 표시. 작업 시작 시 `legacy/agents/main.md`·`verifier.md`에 커밋되지 않은 수정이 있었음(이번 작업과 무관, 손대지 않고 커밋에서 제외) — 사용자가 의도한 것인지 확인 필요.
- 다음 사람이 할 일: 4-4 프로세스 관리·Supabase 이식 여부 결정, 사용자 PC에서 4-5.

### 2026-11-16 · Claude (20차)
- 한 일: 사용자 PC 첫 스모크(claude) 결과 반영. `submit_report` 입력 스키마에 필드 타입 선언, `ReportCollector` 문자열→값 재검증, 스모크가 `codex` 탐색 로직 사용.
- 확인한 것: 전체 151개 테스트와 `tsc` 통과. 실제 Claude에서 검증된 것: stream-json 다중 턴, usage 증분, `approve` 권한 호출, `--tools` 쉼표 목록, 중단. 아직 미검증: 수정 후 보고 제출, codex 전부.
- 다음 사람이 할 일: 사용자가 `git pull` 후 `node scripts/smoke/runtime.ts claude`·`codex` 재실행하고 `scripts/smoke/results/*.json`을 전달.



### 2026-11-16 · Claude (21차)
- 한 일: 두 런타임 스모크 재실행 결과 반영. Claude 전 항목 통과. Codex는 보고 제출·읽기 전용·중단 등 통과, `file_change` 이벤트만 0건(셸 명령으로 파일 작성) → 스모크 점검을 완화하고 `docs/WORKLOG.md`에 기록. 이벤트 필드 이름은 이 실행에서 usage·message·command·turn_end·보고가 모두 동작해 대체로 확인됨.
- 아직 없는 것: Codex `account/rateLimits/read` 실제 응답, Codex `fileChange` 이벤트(patch 도구 사용 시), 2-10 측정.
- 다음 사람이 할 일: 사용자 PC에서 2-10(`npm run bench:run -- --adapter v2 --label v2-codex-auto --review auto`).


## 22차 (2026-11-16)
- 대시보드 1차 구현 커밋(`b7fb6cb`). 빌드 검증은 사용자 PC에서: `npm run web:install` → `npm run web:typecheck` → `npm run web:build` → `npm run agent-desk -- serve`.
- 다음: 5-3 설정/스킬/사용량 패널, 5-4 벤치마크 비교 화면(`bench/results`), 서버 API 추가 필요.
- 마지막 단계 할 일(README와 함께): **UI 사용 매뉴얼** 작성 (화면별 사용법, 스크린샷 포함). 대시보드 완성 후에 작성.

## 할 일 등록: 5-5 에이전트 장면 (대시보드 5-3, 5-4 완료 후 착수)
- 목표: 한 화면(한 칸)에 lead/builder/verifier/researcher 캐릭터가 함께 일하는 모습을 실시간으로 보여 준다.
- 데이터: 기존 실행 이벤트(단계, 게이트, REDO 사유, 명령, 파일 변경, 질문)를 역할별 상태(생각/타이핑/대기/실패)로 변환한다. 서버 변경은 거의 없다.
- 구현: SVG/CSS 애니메이션, 외부 라이브러리·에셋 없음, 캐릭터는 직접 디자인한 원본(기존 캐릭터 모방 금지). 상태 변환 로직은 `web/src/model.ts` 계열의 순수 TS로 두고 테스트한다.
- "말 걸기" 표현: 에이전트 간 자유 대화가 아니라 하네스가 중개하는 핸드오프를 말풍선으로 의인화한다 (lead→builder 지시, verifier→builder REDO 사유, builder→lead 보고서). 이력서/문서에는 "역할 간 핸드오프 시각화"로 표기한다.
- 부가: v1(13개) vs v2(4개) 장면을 나란히 재생해 말풍선 수와 대기 시간 차이를 보여 주는 비교 뷰.
- 시작 전에 사용자에게 캐릭터 스타일(픽셀풍, 둥근 로봇 등)을 물어본다.
- 마지막 단계 할 일: README, UI 사용 매뉴얼.

## 대시보드 남은 순서
1) 1차 화면 검증 결과 반영 → 2) 5-3 실행 화면 보강(역할별 토큰/시간, 5시간 사용량 게이지, 보고서, 변경 파일) + 설정/스킬 패널 + 서버 API → 3) 5-4 벤치마크 비교 화면 → 4) 5-5 에이전트 장면 → 5) README, UI 매뉴얼.
