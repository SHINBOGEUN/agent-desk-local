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
| 0. 레거시 분리와 기준선 | v1 이동·기준선 `v1-13`(과제 10개 × 2회) 완료. 어려운 과제 H01~H05 작성 완료, **`v1-13-hard` 측정 진행 중(사용자 PC)** |
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
8. **측정과 겹치지 않기**: 사용자 PC에서 벤치마크가 도는 동안은 Codex·Claude 실제 호출(프로토타입, 스모크 테스트)을 하지 않습니다. 사용량 지표가 섞입니다. 가짜 런타임으로 하는 개발과 테스트는 괜찮습니다.

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
