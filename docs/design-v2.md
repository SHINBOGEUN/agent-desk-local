<!-- 이 파일은 Claude 문서 "Agent Desk v2 전체 설계서"(개정 3, 2026-11-13)를 마크다운으로 내보낸 사본입니다. 원본: https://claude.ai/artifact/YJkaS7TK9NDkcNdCEecBb6
     내보내기에서 그림(실행 흐름 도식) 1개가 빠졌고, 날짜·멘션 칩은 글자로 바뀌었습니다. 설계를 바꾸면 이 사본과 원본을 함께 고치고, 바꾼 이유는 docs/adr/에 남깁니다. -->

# Agent Desk v2 전체 설계서

Nov 13, 2026 · @bogeun

v2는 코드가 작업 순서와 완료 판정을 결정하고, 모델은 교체 가능한 런타임(Codex·Claude)으로 작업만 하는 로컬 하네스입니다. TypeScript, 같은 저장소의 `legacy/` 분리, 대시보드 신규 작성을 전제로 합니다.

## 개정 3에서 바뀐 것

사용자가 책을 읽고 정리한 노트(Notion '하네스')를 대조해 반영했습니다. 반영한 것과 반영하지 않은 것의 이유는 [ADR 0004](adr/0004-book-notes-revision.md)에 있고, 게이트 판정의 세부 결정은 [ADR 0005](adr/0005-gate-policies.md)에 있습니다.

| 구분 | 변경 |
| --- | --- |
| 추가 | 팀 구조 선택 기준: 워크플로를 6패턴에 대응, 역할 추가는 전문성·병렬성·컨텍스트·재사용성 중 하나가 측정으로 확인될 때만, 위임 깊이는 1단계 고정 |
| 추가 | 스킬 점진적 공개 3층과 스킬 검증 절차(구조 검증, 트리거 8~10 + 비트리거 8~10, 스킬 유무 비교), `agent-desk skills check` |
| 변경 | 역할 정의를 `.agent-desk/agents/<role>.md`(프론트매터 + 지침)로 분리. `config.json`은 런타임 배정·검증·한도만 |
| 추가 | `agent-desk init`: 프로젝트 현황 검사(도메인·기존 에이전트/스킬·코드베이스·충돌) |
| 추가 | 개선 루프: 실패 원인을 스킬·역할 파일·워크플로 중 고칠 곳으로 분류, 6단계에 실패 분석 보고서 |
| 추가 | 독립 리뷰의 근거 가설과 측정 비교 대상(독립 세션 vs 같은 세션 자체 점검 vs 리뷰 없음) |
| 확정 | `unverified`·G2 불일치·G5 기준의 판정 정책(ADR 0005). REDO 초과는 `needs_review` 유지 |

## 개정 2에서 바뀐 것

기준선 측정(v1-13 첫 바퀴)과 0\~1단계 구현에서 드러난 사실을 반영해 설계를 고쳤습니다. 각 항목은 아래 해당 섹션에 반영돼 있습니다.

| 구분 | 드러난 사실 | 설계 변경 |
| --- | --- | --- |
| 수정 | v1은 과제 10개를 모두 실제로 성공했지만 4건을 '검토 필요'로 보고 | 목표를 '거짓 완료 제거'에서 **판정 정확도**(거짓 완료 + 거짓 경보 모두)로 넓힘 |
| 수정 | `v1-3` 측정은 v1 배정 규칙 때문에 성립하지 않음 | 제외. 에이전트 수·리뷰의 효과는 v2 안의 구성 비교(ablation)로 측정 |
| 수정 | 작업 환경에서 npm 설치가 막힘 | zod 대신 `core`의 자체 검증기, 빌드 없이 Node 타입 제거로 실행, 빈 패키지는 만들지 않음 |
| 보완 | 질문 하나(T09)에 19만 토큰, 전문 에이전트 호출 | `answer`는 분류와 답변을 한 턴에 끝내는 빠른 경로 |
| 보완 | 작은 변경에도 리뷰 세션 비용이 큼 | 리뷰 정책 `always · auto · never`를 설정으로 두고 벤치마크로 기본값 결정 |
| 보완 | builder가 테스트를 고쳐 통과시키는 경우(T06은 정당, 악용도 가능) | 테스트·검증 설정 변경은 G2가 표시하고 리뷰가 반드시 판단 |
| 추가 | v1 서버가 대시보드 전송 때문에 메모리 4GB 초과로 중단 | 이벤트 증분 전송, 느린 수신자 차단, 버퍼 상한을 API 규칙으로 명시 |
| 추가 | Codex가 PATH에 없고, `.cmd`는 직접 실행 불가, 환경 변수는 창마다 사라짐 | `doctor`가 실행 파일을 찾아 PC별 설정에 저장 |
| 추가 | v1이 시작할 때 Git 추적 파일(`agents/*.md`)을 PC 데이터로 덮어씀 | 설정의 원본은 파일 하나. 하네스는 추적 파일을 몰래 쓰지 않음 |
| 추가 | 실패한 작업이 작업 폴더에 반쯤 남음 | build 전 스냅샷, `needs_review`에서 되돌리기 제공 |
| 추가 | 메모리가 Run Brief 하나뿐 | 프로젝트 메모(`.agent-desk/memory.md`)를 사용자 소유로 추가 |
| 추가 | 줄바꿈(CRLF) 차이로 전체 파일이 수정됨으로 보임, PowerShell 5에서 한글 깨짐 | `.gitattributes`, 스크립트 출력 인코딩 규칙 |

## 목표와 범위

v2의 목표는 v1 대비 **성공 1건당 토큰을 줄이고, 거짓 완료를 없애는 것**입니다. 모든 목표는 `bench/` 벤치마크 수치로 판정합니다.

**목표**

- Codex만, Claude만, 또는 둘을 섞어서 같은 워크플로를 실행한다.
- 작업 순서·완료 판정·권한·예산·재시도는 코드가 결정한다. 모델은 단계 안의 작업만 한다.
- 프로젝트마다 설정 파일 하나(`.agent-desk/config.json`)로 역할·스킬·검증 명령을 바꾼다.
- 토큰을 턴 단위 증분으로 정확히 기록한다 (v1의 10.7배 과대 계상 재발 방지).

**범위 밖**

- 다른 사람과의 공유·원격 접속·다중 사용자. 서버는 `127.0.0.1`에서만 열리고, Claude는 본인 PC에 로그인된 CLI로만 쓴다.
- 에이전트 간 자유 대화(v1의 협의 기능). 협의 43턴이 남긴 가치가 측정되지 않았으므로, 필요성이 수치로 확인될 때만 추가한다.
- 병렬 쓰기 작업. 초기에는 쓰기를 한 번에 하나만 하고, 필요해지면 git worktree로 확장한다.

**성공 지표** (v1-13 기준선 대비, 같은 과제 10개 × 2회)

| 지표 | 목표 | v1-13 첫 바퀴 (참고) |
| --- | --- | --- |
| 실제 성공률 (숨은 테스트 통과) | 기준선 이상. 쉬운 세트는 100% 유지, 어려운 세트에서 비교 | 10/10 |
| 거짓 완료 (완료 보고인데 실제 실패) | 0건 | 0건 |
| 거짓 경보 (실제 성공인데 검토 필요) | 기준선보다 낮게 | 4/10 |
| 성공 1건당 토큰 | 기준선보다 낮게 | 평균 약 62만 |
| 질문형 요청(T09) 토큰 | 위임 없이 단일 턴 | 19만, 에이전트 1명 호출 |
| 과제당 소요 시간 | 기준선보다 짧게 | 평균 약 4.3분 |
| 토큰 기록 오차 | 런타임 보고값의 턴별 합과 일치 | 해당 없음 |

주 지표는 토큰과 판정 정확도입니다. 5시간 한도 사용률은 계정 전체 값이라 다른 Codex 작업이 섞이므로 참고값으로만 씁니다. 구체적인 목표 수치(예: 토큰 몇 % 감소)는 기준선 둘째 바퀴와 어려운 과제 세트 측정이 끝난 뒤 정합니다.

## 저장소 구조

v1은 `legacy/`로 옮겨 그대로 실행 가능하게 두고, v2는 npm workspaces 모노레포로 루트에 둡니다. `bench/`는 두 버전이 공유합니다.

```text
agent-desk-local/
├─ legacy/                 v1 전체 (server.mjs, lib/, public/, agents/, test/, 시작 스크립트)
├─ bench/                  공용 벤치마크
│  └─ adapters/            v1.ts · v2.ts  (같은 과제를 각 버전 API로 실행)
├─ packages/
│  ├─ core/                도메인 모델, 오케스트레이터, 게이트, 예산  (런타임·파일시스템·HTTP 비의존)
│  ├─ runtime-codex/       Codex App Server 어댑터 + generate-ts로 만든 프로토콜 타입
│  ├─ runtime-claude/      Claude Code CLI(헤드리스) 어댑터
│  ├─ runtime-fake/        스크립트로 동작하는 테스트용 런타임
│  ├─ tools-mcp/           하네스 도구(보고 제출·승인)를 두 런타임에 주는 로컬 MCP 서버
│  ├─ server/              HTTP+SSE API, 보안, 저장소(SQLite), 승인 브로커, 프로세스·Supabase 이식
│  ├─ web/                 새 대시보드 (Vite + React + TypeScript)
│  └─ cli/                 agent-desk 명령 (run · doctor · bench)
├─ docs/adr/               설계 결정 기록 (ADR)
└─ package.json            workspaces, 공통 스크립트
```

**의존 방향 규칙**: `core`는 어떤 패키지에도 의존하지 않습니다. 런타임·서버·CLI가 `core`의 인터페이스를 구현하거나 호출합니다. 그래서 오케스트레이터를 `runtime-fake`만으로 빠르게 테스트할 수 있습니다.

**실행 환경**: TypeScript를 빌드 없이 Node의 타입 제거로 바로 실행합니다(Node.js 22.18 이상, 서버의 `node:sqlite`까지 고려해 24 권장). 그래서 `enum` 같은 지워지지 않는 문법은 쓰지 않고, 패키지 사이 import는 루트 `package.json`의 `imports`(`#core` 등)를 씁니다. 런타임 의존성은 두지 않는 것을 기본으로 하고(보고 검증도 자체 검증기), 빌드 도구는 `web/`에만 둡니다. 패키지 폴더는 필요한 단계에 만듭니다. Windows 우선 검증이며, 저장소에 `.gitattributes`를 두어 줄바꿈 차이로 생기는 가짜 변경을 막습니다.

## 핵심 개념 모델

v1은 "에이전트가 다른 에이전트를 부르는" 구조였습니다. v2는 **코드가 정한 Workflow가 Step을 순서대로 실행**하고, 각 Step에서만 모델이 일합니다.

| 개념 | 정의 | 누가 정하나 | 예시 |
| --- | --- | --- | --- |
| Project | 연결된 폴더 + `.agent-desk/config.json` | 사용자 | minitodo 등 임의의 프로젝트 |
| Run | 사용자 요청 하나의 전체 처리 | 사용자 | "상태 필터 버그 고쳐줘" |
| Workflow | Run을 처리하는 Step의 고정 순서 | 코드 (분류 결과로 선택) | `answer` · `build` · `plan-build` · `investigate` |
| Step | Workflow 안의 한 단계. 역할 하나가 턴 하나 이상 실행 | 코드 | classify, plan, build, gate, review, report |
| Role | Step을 수행하는 역할. 권한·런타임·스킬을 가짐 | 설정 파일 | `lead` · `builder` · `verifier` · `researcher` (4개) |
| Skill | 역할에 붙는 전문 지식. 필요할 때만 로드 | 설정 파일 + SKILL.md | api-conventions, db-migration, security-review |
| Session | 런타임의 대화 단위 (Codex thread / Claude session) | 코드. Run 밖으로 재사용하지 않음 | builder 세션 1개, verifier 세션 1개 |
| Gate | 코드가 실행하는 판정. 모델 출력 없이 통과/실패 | 코드 + 설정 | verify 명령 종료 코드, 변경 파일 대조, 예산 |
| Report | Step이 제출하는 구조화된 결과 | 스키마 (코드) | 변경 파일, 실행 명령, 판정 |
| Event | 모든 일의 추가 전용 기록 | 코드 | 턴 시작, 토큰 증분, 명령 결과, 게이트 판정 |

**v1 대비 바뀐 점**

- 역할은 13개에서 4개로 줄고, backend·frontend·db·security 등은 스킬이 됩니다.
- 메인 AI가 위임 도구로 팀원을 부르던 방식을 없앱니다. `lead`는 분류와 계획만 하고, 다음 Step은 Workflow가 정합니다.
- Session은 Run 안에서만 살아 있습니다. 이전 Run의 내용은 짧은 요약(Run Brief)으로만 전달합니다.

**팀 구조 선택 기준** (책의 6패턴과 대응)

| 패턴 | v2에서 | 쓰는 조건 |
| --- | --- | --- |
| 파이프라인 | `build`·`plan-build`의 Step 순서 | 앞 결과 없이는 다음을 시작할 수 없고, 중간 산출물(보고·diff)을 확인할 수 있을 때 |
| 생성-검증 | builder → 게이트 → verifier → REDO(최대 2회) | 검증 기준이 명확하고 만드는 관점과 검사하는 관점이 분리될 때. 함정인 무한 루프는 REDO 상한으로 막음 |
| 팬아웃/팬인 | `investigate`의 researcher 병렬 조사 | 같은 입력을 다른 관점으로 동시에 볼 때 |
| 전문가 풀 | 스킬 선택(라우터 = lead의 분류) | 전문가끼리 실시간 소통이 필요 없을 때. 라우터 정확도가 핵심이라 분류 정확도를 측정 대상에 포함 |
| 감독자 | 없음 | 작업 수가 실행 전에 정해지지 않는 경우가 측정으로 확인될 때만 |
| 계층적 위임 | 없음(위임 깊이 1: Workflow → 역할) | 3단계는 금지, 2단계도 필요가 확인될 때만 |

역할을 늘리거나 쪼갤 때의 기준은 책의 네 가지입니다: 전문성(역할 영역이 뚜렷이 다름), 병렬성(독립 실행 가능), 컨텍스트(처리 부담이 큼), 재사용성(다른 프로젝트에서도 씀). 하나도 해당하지 않으면 역할이 아니라 스킬로 둡니다. 팀 규모는 3~5명이 적정이고 10명 이상은 구조를 다시 짜야 한다는 것이 책의 경험칙이라, v2는 4개로 시작합니다. 모델이 다른 에이전트를 호출하는 도구는 제공하지 않아 위임이 재귀로 번지는 일이 구조상 없습니다.

## 실행 흐름

모든 Run은 분류로 시작해 워크플로 하나를 타고, 파일을 바꾸는 워크플로는 게이트와 독립 리뷰를 통과해야만 완료됩니다.

&#91;embedded content: build · plan-build 워크플로 · 게이트 4개, REDO 최대 2회\]

자동 게이트에서 실패하면 리뷰를 건너뛰고 바로 REDO로 돌아가 리뷰 토큰을 아낍니다. `answer`(질문)와 `investigate`(조사)는 파일을 바꾸지 않으므로, 각각 lead 단독 답변과 researcher 병렬 조사 후 바로 보고합니다.

| 워크플로 | 고르는 기준 | Step |
| --- | --- | --- |
| `answer` | 파일 변경 없이 답할 수 있는 질문 | classify → report |
| `investigate` | 원인 분석·구조 파악, 변경 없음 | classify → research(병렬) → report |
| `build` | diff를 한 문장으로 설명할 수 있는 변경 | classify → build → gates → review → report |
| `plan-build` | 여러 파일·방법이 불확실한 변경 | classify → plan → build → gates → review → report |

분류는 lead가 낮은 추론 강도로 한 번에 하고, 사용자가 대시보드에서 워크플로를 직접 고를 수도 있습니다.

**빠른 경로**: lead가 `answer`로 분류하면 같은 턴에서 바로 답을 제출합니다(분류 보고 + 답변 보고를 한 번에). 질문 하나에 세션을 두 번 열지 않기 위한 것으로, v1이 T09에서 쓴 19만 토큰이 비교 대상입니다. lead는 읽기 전용이라 답하는 동안 파일을 바꿀 수 없고, G2가 변경 0건을 확인합니다.

**리뷰 정책**: 독립 리뷰(G4)는 새 세션이 코드를 다시 읽는 비용이 듭니다. 설정 `review`로 정합니다.

| 값 | 동작 |
| --- | --- |
| `always` (초기 기본값) | 파일을 바꾼 Run은 항상 리뷰 |
| `auto` | verify 명령이 있고 통과했으며, 변경이 작고(파일 수·줄 수 기준), 테스트·보안 관련 파일을 건드리지 않았을 때만 리뷰 생략 |
| `never` | 자동 게이트만. 벤치마크 비교용 |

기본값을 `auto`로 바꿀지는 세 값을 같은 과제로 측정해 정합니다. 리뷰가 비용만큼 결함을 잡는지가 판단 기준입니다.

독립 리뷰의 근거는 "두 명이 한 번씩 보는 것이 한 명이 두 번 보는 것보다 낫다"는 가설입니다(책의 정리). 이를 확인하려고 비교 대상에 **builder가 같은 세션에서 자기 결과를 다시 점검하는 구성**을 추가합니다. 독립 리뷰가 자체 점검보다 결함을 더 잡지 못하면 리뷰 비용을 정당화할 수 없습니다.

## 런타임 어댑터 계약

모든 런타임은 같은 `Runtime` 인터페이스를 구현하고, 코어는 정규화된 이벤트만 봅니다. 토큰은 반드시 **턴 증분**으로 내보내는 것이 계약입니다.

```ts
interface Runtime {
  id: 'codex' | 'claude' | 'fake';
  doctor(): Promise<DoctorResult>;                 // 설치·로그인·버전·샌드박스 점검
  startSession(opts: SessionOptions): Promise<Session>;
}

interface SessionOptions {
  cwd: string;
  model?: string;
  effort?: 'low' | 'medium' | 'high';
  access: 'read-only' | 'workspace-write';
  instructions: string;        // 역할 지침 (짧게)
  skills: SkillRef[];          // 설명만 노출, 본문은 필요할 때 로드
  tools: HarnessToolEndpoint;  // 하네스 MCP 서버 접속 정보
}

interface Session {
  id: string;
  runTurn(input: TurnInput, signal: AbortSignal): AsyncIterable<RuntimeEvent>;
  close(): Promise<void>;
}

type RuntimeEvent =
  | { type: 'message'; text: string; final: boolean }
  | { type: 'command'; command: string; exitCode: number | null; output: string }
  | { type: 'file_change'; path: string; kind: 'add' | 'update' | 'delete' }
  | { type: 'approval_request'; id: string; kind: string; detail: unknown }
  | { type: 'usage'; delta: TokenUsage }   // 턴 증분만. 누적값 금지
  | { type: 'turn_end'; status: 'completed' | 'interrupted' | 'failed'; error?: string };
```

| 기능 | CodexRuntime | ClaudeRuntime |
| --- | --- | --- |
| 실행 | `codex app-server` (stdio JSON-RPC) | `claude -p --input-format stream-json --output-format stream-json --verbose` |
| 세션 | `thread/start`, Run마다 새 스레드 | init 이벤트의 session id, Run 안에서만 `--resume` |
| 역할 지침 | `developerInstructions` | `--append-system-prompt` |
| 읽기 전용 | `sandbox: read-only` | `--allowedTools`(읽기·검색) + `--disallowedTools`(편집·셸) |
| 쓰기 | `sandbox: workspace-write` | `--permission-mode acceptEdits` + 허용 명령 목록 |
| 하네스 도구 | 로컬 MCP 서버 (thread config) | `--mcp-config` + `--strict-mcp-config` |
| 승인 | `item/*/requestApproval` → 승인 브로커 | `--permission-prompt-tool`(MCP) → 같은 브로커 |
| 토큰 | `thread/tokenUsage/updated`의 `last` | 턴 결과 메시지의 usage |
| 중단 | `turn/interrupt` | 프로세스 인터럽트 |
| 스킬 | 지침에 목록(id·설명·SKILL.md 경로), 복사 없음 (ADR 0008) | 같음 |

**하네스 도구를 MCP 하나로 통일**: v1은 Codex의 실험적 동적 도구(`dynamicTools`)에 의존했습니다. v2는 `tools-mcp` 로컬 MCP 서버 하나를 두 런타임이 같이 쓰게 해서, 도구 구현을 한 번만 합니다. 도구는 `submit_report`(구조화 보고 제출), `request_user_input`(사용자에게 질문), `approve`(Claude 권한 프롬프트용) 세 개만 둡니다. 위임 도구는 없습니다.

**실행 파일 찾기와 Windows 처리** (기준선 측정에서 실제로 막혔던 부분)

- `doctor`가 Codex·Claude 실행 파일을 찾습니다: PATH → npm 전역 폴더의 실제 `codex.exe` → `~/.local/bin/claude.exe` 순서. npm이 만드는 `.cmd`는 셸 없이 실행할 수 없으므로 실제 실행 파일까지 따라갑니다.
- 찾은 경로와 CLI 버전은 PC별 설정(Agent Desk 데이터 폴더)에 저장합니다. 환경 변수를 창마다 다시 넣을 필요가 없습니다.
- CLI 버전이 어댑터가 검증한 범위를 벗어나면 경고합니다. Codex App Server는 실험적 프로토콜이라 버전에 따라 깨질 수 있습니다.
- 세션을 닫을 때 프로세스 트리 전체를 정리하고, 정리를 확인하지 못하면 그 사실을 기록합니다.
- 시작 스크립트의 출력은 Windows PowerShell 5에서도 깨지지 않게 인코딩을 맞춥니다.

**프로토타입으로 먼저 확인할 것** (1단계)

- [ ] Codex App Server가 thread 설정으로 로컬 MCP 서버를 붙일 수 있는지, read-only 샌드박스에서도 MCP 호출이 되는지
- [ ] Claude CLI stream-json 입력으로 한 프로세스에 여러 턴을 보낼 수 있는지, 턴별 usage가 증분인지
- [ ] Windows에서 두 CLI의 중단·정리가 프로세스를 남기지 않는지

플래그의 근거는 [Claude Code CLI reference](https://docs.claude.com/en/docs/claude-code/cli-reference)와 [Codex App Server](https://developers.openai.com/codex/app-server)입니다.

## 결정론적 게이트와 완료 판정

Run의 `completed`는 모델의 말이 아니라 게이트 통과로만 결정됩니다. v1에서 체커 첫 검증 PASS가 0/23이었던 문제를 구조로 막는 부분입니다.

| 게이트 | 실행 주체 | 통과 조건 | 실패 시 |
| --- | --- | --- | --- |
| G1 보고 형식 | 코드 (스키마 검사) | `submit_report`가 스키마에 맞음 | 틀린 필드 경로를 알려 같은 세션에 다시 요청 (1회) |
| G2 변경 대조 | 코드 (git diff·파일 스냅샷) | 보고한 변경 파일 = 실제 변경 파일. 읽기 전용 Step은 변경 0. 보호 경로(`.agent-desk/`, `.git/`) 변경 없음 | 불일치를 REDO 사유로 기록. 보호 경로 변경은 되돌리고 중단 |
| G3 검증 명령 | 코드 (하네스가 직접 실행) | 설정의 `verify` 명령 전부 종료 코드 0 (명령별 제한 시간) | 출력 끝부분 요약과 함께 REDO |
| G4 독립 리뷰 | verifier (새 세션, 읽기 전용) | `verdict: PASS`, blocking 목록 비어 있음 | blocking 항목만 REDO |
| G5 예산 | 코드 | 토큰·사용률·시간 한도 안 | 중단 + 이어하기 기록 |

**REDO 규칙**: REDO는 G2·G3 실패, 요구사항 미충족, 사실과 다른 보고에만 내립니다. 스타일 제안은 REDO 사유가 아닙니다. REDO는 Run당 최대 2회이고, 첫 REDO는 같은 builder 세션에서, 두 번째는 실패 요약을 담은 새 세션에서 실행합니다. 그래도 실패하면 `needs_review`로 끝내고 사용자에게 넘깁니다.

**판정은 양쪽으로 틀릴 수 있습니다.** v1 기준선에서 거짓 완료는 0건이었지만, 실제로 성공한 작업 10건 중 4건이 '검토 필요'로 끝났습니다. 원인은 체커가 확인을 못 했다고 보고(NOT\_VERIFIED)한 것을 그대로 판정에 쓴 것입니다. v2는 이렇게 다릅니다.

- 테스트 실행 같은 사실 확인은 G3가 합니다. verifier에게 "테스트를 돌려 보라"고 맡기지 않고, G3 결과를 입력으로 줍니다.
- verifier의 `BLOCKED`(판단 불가)는 이유를 반드시 적게 하고, G3가 통과한 상태의 `BLOCKED`는 '검토 필요'가 아니라 \*\*'완료(리뷰 미확인 항목 있음)'\*\*으로 보고합니다. 사용자가 무엇이 확인되지 않았는지 볼 수 있게 합니다.
- 벤치마크는 거짓 완료와 거짓 경보를 따로 집계합니다. 한쪽을 줄이려고 다른 쪽을 늘리는 변경을 걸러내기 위해서입니다.

**테스트를 고쳐서 통과시키는 경우.** builder가 테스트 파일을 바꾸는 것은 정당할 때도 있지만(인증 추가로 기존 테스트가 바뀌어야 하는 T06), 실패하는 테스트를 지우는 식의 악용도 가능합니다. G2는 테스트·검증 관련 파일이 바뀌면 표시를 남기고, 이 경우 리뷰 정책이 `auto`여도 G4를 생략하지 않으며, verifier에게 "테스트 변경이 요구사항 때문인지, 검사를 약화한 것인지"를 명시적으로 판단하게 합니다.

**스냅샷과 되돌리기.** build Step 전에 작업 폴더 상태를 스냅샷으로 남깁니다(git 저장소면 사용자의 브랜치·스테이징을 건드리지 않는 별도 참조, 아니면 파일 복사). Run이 `needs_review`나 `failed`로 끝나면 변경을 그대로 두되, 대시보드와 CLI에서 "이 Run 이전으로 되돌리기"를 제공합니다. 자동으로 되돌리지는 않습니다. 반쯤 된 작업이라도 사용자가 이어서 고칠 수 있기 때문입니다. (2-11 구현: 파일 복사 방식으로 시작, [ADR 0006](adr/0006-restore-points.md))

**요구사항 목록이 틀렸을 때.** 요구사항을 잘못 뽑으면 builder와 verifier가 함께 틀린 기준을 따릅니다. 그래서 verifier에게는 목록과 함께 사용자 요청 원문도 주고, 원문에 있는데 목록에 빠진 요구를 blocking으로 보고할 수 있게 합니다. `plan-build`에서는 사용자가 시작 전에 목록을 고칠 수 있습니다.

**실패 유형별 처리** (v1의 같은 요청 7회 반복 방지)

| 유형 | 예 | 처리 |
| --- | --- | --- |
| 수정 가능 | 테스트 실패, 요구사항 누락 | REDO (상한 안에서) |
| 환경 | `spawn EPERM`, 명령 없음, 권한 거부 | 즉시 중단, `doctor` 결과와 필요한 조치 한 가지 보고 |
| 정보 부족 | 대상 불명, 자격 증명 필요 | `request_user_input`으로 질문하고 대기 |
| 런타임 일시 오류 | 연결 끊김, 타임아웃 | 같은 Step 1회 재시도 |

**보고 스키마** (core의 자체 검증기로 검증, 구현 완료)

```ts
type BuilderReport = {
  summary: string;
  changedFiles: string[];                          // G2가 실제 변경과 대조
  commandsRun: { command: string; exitCode: number }[];
  requirements: { id: string; status: 'done' | 'not_done' | 'unverified'; evidence: string }[];
  unverified: string[];                            // 확인 못한 것을 숨기지 않게
};

type VerifierReport = {
  verdict: 'PASS' | 'REDO' | 'BLOCKED';
  blocking: { file?: string; line?: number; reason: string; evidence: string }[];
  optional: string[];                              // 제안. REDO 사유 아님
};
```

요구사항 목록(`requirements`)은 `plan` 또는 `classify` Step이 요청에서 뽑아 Run에 고정합니다. builder와 verifier는 같은 목록을 두고 각자 판단합니다.

## 맥락·메모리와 프로젝트 설정·스킬

기본 원칙은 **각 세션에는 그 Step에 필요한 것만** 넣는 것입니다. v1에서 메인 AI가 프로젝트 대화 전체를 이어 써서 단순 답변 하나에 1.9M 토큰을 쓴 문제를 막습니다.

**맥락에 들어가는 것 (Step별)**

| Step | 받는 것 | 받지 않는 것 |
| --- | --- | --- |
| classify | 사용자 요청, 직전 Run Brief 1개(최대 1,500자) | 코드, 이전 대화 전문 |
| plan | 요청, 요구사항, 저장소 탐색 권한(읽기) | 다른 Run의 기록 |
| build | 요청, 요구사항, 계획(있으면), 스킬 설명 목록 | 리뷰어의 추론 |
| review | 요구사항, diff, verify 명령 결과 | builder의 대화·추론 (자기 결과 편향 방지) |
| report | 모든 Step의 구조화 보고 | 원본 도구 출력 |

**기억 계층**

- **프로젝트 지침**: 대상 프로젝트의 `AGENTS.md`·`CLAUDE.md`. 런타임이 직접 읽고, 하네스는 다시 복사하지 않습니다. 두 파일의 내용이 다르면 `doctor`가 알려 줍니다(런타임마다 다른 규칙을 따르는 것을 막기 위해).
- **프로젝트 메모** (`.agent-desk/memory.md`, 신규): 여러 Run에 걸쳐 유효한 사실입니다. 예: "마이그레이션은 사용자가 직접 적용한다", "에뮬레이터 포트는 8081". 소유자는 사용자입니다. 하네스는 Run이 끝날 때 추가할 항목을 **제안**만 하고, 사용자가 승인해야 파일에 들어갑니다. 길이 상한(예: 2,000자)을 두어 맥락을 부풀리지 않게 합니다. Git으로 추적되므로 무엇이 언제 들어갔는지 볼 수 있습니다.
- **Run Brief**: Run이 끝날 때 코드가 구조화 보고에서 만드는 요약(목표, 결과, 변경 파일, 남은 일). 다음 Run에는 최근 1개만 전달합니다. 모델이 따로 요약하지 않아 토큰이 들지 않습니다.
- **이어하기**: 중단된 Run은 Run Brief + 남은 요구사항으로 새 Run을 시작합니다. 이전 세션을 재사용하지 않습니다.
- **긴 Step 안의 맥락**: 한 세션이 길어져 런타임이 자체 압축을 하면 목표가 흐려질 수 있습니다. 하네스는 Step마다 토큰 상한을 두고, 넘으면 지금까지의 보고와 남은 요구사항으로 새 세션을 엽니다.

**프로젝트 설정** (`.agent-desk/config.json`)

```json
{
  "runtimes": { "primary": "codex", "review": "claude" },
  "roles": {
    "lead":       { "runtime": "primary", "effort": "low" },
    "builder":    { "runtime": "primary", "effort": "high", "access": "workspace-write" },
    "verifier":   { "runtime": "review",  "effort": "medium" },
    "researcher": { "runtime": "primary", "effort": "medium" }
  },
  "skills": ["api-conventions", "db-migration", "security-review"],
  "verify": ["npm test"],
  "limits": { "redo": 2, "tokens": 2000000, "codexUsagePercent": 10, "minutes": 30 }
}
```

- 설정이 없는 프로젝트는 `doctor`가 `package.json` 등을 보고 초안을 만들어 사용자가 확인합니다.
- `review`를 `codex`로 바꾸면 Codex 단독, `primary`를 `claude`로 바꾸면 Claude 단독입니다.
- 개인 PC별 값(경로, 토큰, 로그)은 프로젝트가 아니라 Agent Desk 데이터 폴더에 둡니다.

**역할 정의 파일.** 역할의 지침은 `config.json`이 아니라 `.agent-desk/agents/<role>.md`에 둡니다("파일이 없으면 존재하지 않는다"). 프론트매터에 `access`·`effort`·`skills`를, 본문에 지침을 적습니다. 하네스는 역할 4개(`lead`·`builder`·`verifier`·`researcher`)의 파일이 모두 있는지 `doctor`로 확인하고, 없으면 내장 기본값을 쓰되 알려 줍니다. `config.json`에는 런타임 배정, `verify`, 한도만 남습니다. 위 예시의 `roles` 항목 중 `access`·`effort`·스킬은 이 파일로 옮겨지고, 런타임 배정(`runtime`)만 설정에 남습니다.

**프로젝트 현황 검사 (`agent-desk init`).** `doctor`가 환경을 점검한다면 `init`은 프로젝트를 점검해 설정 초안을 만듭니다: 도메인과 핵심 작업 유형, 이미 있는 에이전트·스킬(`AGENTS.md`, `.claude/`, `.agents/`), 코드베이스 탐색(verify 명령 후보), 사용자 숙련도 감지, 기존 설정과의 충돌. 결과는 사용자가 확인한 뒤에만 파일로 씁니다.

**설정의 원본은 하나입니다.** v1은 에이전트 지침을 Git 추적 파일과 PC 데이터 두 곳에 두고, 시작할 때 추적 파일을 PC 데이터로 덮어썼습니다(기준선 측정 중 실제로 발생). v2의 규칙은 이렇습니다.

- 프로젝트 설정·스킬·메모의 원본은 `.agent-desk/` 안의 파일입니다. 대시보드는 이 파일을 편집하는 화면일 뿐이고, 따로 복사본을 갖지 않습니다.
- 하네스가 추적 파일을 쓰는 것은 사용자가 저장을 누른 때뿐입니다. 시작·실행 중에는 쓰지 않습니다.
- 실행 시 설정은 Run에 스냅샷으로 기록합니다. 나중에 "이 결과가 어떤 설정에서 나왔나"를 확인할 수 있게 하기 위해서입니다.

**스킬**

- 점진적 공개 3층: (1) `description`만 항상 맥락에 둡니다. (2) 트리거되면 SKILL.md 본문을 읽습니다. (3) 참조 문서·스크립트는 본문이 가리킬 때만 읽습니다. 설명 목록이 길어지면 매 턴의 비용이 되므로 `description`은 짧고 구체적으로 씁니다.
- 형식은 SKILL.md 하나로 통일하고, 원본은 `.agent-desk/skills/<id>/SKILL.md`에 둡니다. 런타임별 위치로 복사하지 않고, 역할 파일의 `skills`(그리고 `config.skills`)로 정한 목록을 세션 지침에 "id: 설명 (SKILL.md 경로)"로 넣습니다. 모델은 설명이 맞을 때 SKILL.md를 직접 읽습니다(ADR 0008).
- 프론트매터 필수 항목(책의 PUSHY 공식): `description`에 수행 동사, 트리거 조건, 제외 조건을 모두 적습니다. 셀프 점검에서 세 가지가 없으면 경고합니다. 모델은 자체 기능으로 충분히 처리할 수 있다고 판단하면 스킬을 호출하지 않는 경향이 있으므로, 설명에는 이 스킬이 왜 필요한지(없으면 무엇이 틀리는지)가 드러나야 합니다.
- 스킬 검증: (a) 구조 검증(파일 위치, 프론트매터, 참조 파일 일관성)은 `agent-desk skills check`가 자동으로 합니다. (b) 트리거 검증은 should-trigger 8~10개와 should-not-trigger 8~10개 요청을 두고 호출 여부를 확인합니다. (c) 스킬을 붙인 실행과 뺀 실행을 같은 과제로 비교해 효과를 확인합니다. (d) 정상 시나리오 1개와 오류 시나리오 1개로 드라이런합니다. (b)~(d)는 벤치마크 과제로 두고 6단계에서 수행합니다.
- 본문은 규칙보다 이유를 씁니다(Why-first). 예시: "마이그레이션은 되돌리기 SQL을 같이 만든다. 운영 DB에서 실패하면 수동 복구가 필요하기 때문이다."

## 권한·보안·승인 브로커

권한은 역할에 고정하고, 런타임별 설정으로 번역합니다. 역할이 요청한다고 권한이 늘어나지 않습니다.

| 역할 | 기본 권한 | 셸 명령 | 비고 |
| --- | --- | --- | --- |
| lead | 읽기 전용 | 없음 | 분류·계획만 |
| researcher | 읽기 전용 | 읽기용 명령만 | 병렬 실행 가능 |
| builder | 작업 폴더 쓰기 | 허용 목록 + 승인 | 한 번에 하나만 |
| verifier | 읽기 전용 | 검증용 명령만 | 파일 변경 시 G2가 실패 처리 |

**승인 브로커**: 두 런타임의 승인 요청을 하나의 큐로 모읍니다. 요청마다 역할·명령·경로를 보여주고, 사용자는 이번 한 번 / 이번 Run / 항상(프로젝트 허용 목록에 추가) 중 고릅니다. 응답이 없으면 일정 시간 뒤 거절하고 Run을 `needs_user`로 멈춥니다.

**v1에서 이식할 보안 장치** (테스트 포함)

- `127.0.0.1` 바인딩, Host·Origin 검사, 실행마다 새로 만드는 CSRF 토큰, CSP 헤더
- 로그·명령 출력의 비밀값 패턴 가리기
- Supabase 자격 증명의 Windows DPAPI 암호화
- 프로세스 관리의 명령 제한(개발용 npm 스크립트만, 셸 연결 금지)

**신뢰 경계**: 웹 페이지·외부 문서 등 신뢰할 수 없는 내용을 읽는 Step은 읽기 전용으로만 실행합니다. 다음 Step에는 원문이 아니라 구조화 보고만 넘겨, 문서 속 지시가 쓰기 권한을 가진 역할까지 전달되지 않게 합니다.

**보호 경로**: builder가 `.agent-desk/`(verify 명령·권한 설정)와 `.git/`을 바꾸면 자기 검사 기준을 스스로 느슨하게 만들 수 있습니다. 이 경로는 역할과 무관하게 쓰기를 막고, G2가 사후에도 확인합니다.

**무인 실행**: 벤치마크처럼 사람이 없는 실행은 `--unattended`로 표시합니다. 이 모드에서는 허용 목록 밖의 승인 요청을 즉시 거절하고 기록합니다. v1 벤치마크 어댑터처럼 전부 허용하는 방식은 쓰지 않습니다.

**인증**: Codex·Claude 모두 본인 PC에 로그인된 CLI를 그대로 쓰고, 하네스는 로그인 토큰을 읽거나 저장하지 않습니다.

## 관측과 토큰·예산 회계

모든 일은 추가 전용 이벤트 로그에 남기고, 화면·보고서·벤치마크는 이 로그에서 계산합니다. 그래서 대시보드 숫자와 벤치마크 숫자가 같은 출처를 가집니다.

**저장 구조** (`node:sqlite`)

| 테이블 | 내용 |
| --- | --- |
| `runs` | 요청, 워크플로, 상태, 종료 사유, Run Brief |
| `steps` | 역할, 런타임, 모델·effort, 시작·종료, 보고(JSON) |
| `events` | 추가 전용. 턴 시작·메시지·명령·파일 변경·승인·게이트 판정 |
| `usage` | Step·턴별 토큰 증분 (입력, 캐시 입력, 출력, 추론) |
| `quota_samples` | Codex 5시간 한도 사용률 측정값과 측정 시각 |

**토큰 회계 규칙**

- 저장하는 것은 턴 증분뿐입니다. Run 합계는 증분의 합으로만 계산합니다.
- 캐시 입력은 따로 표시합니다. v1 기록에서 입력의 대부분이 캐시였기 때문에, 캐시 미적용 입력과 출력이 실제 비용을 더 잘 보여줍니다.
- 런타임 합계와 증분 합이 어긋나면 경고 이벤트를 남깁니다 (회귀 테스트 대상).

**예산 가드**: Run마다 아래 한도 중 먼저 닿는 것에서 멈춥니다. 70%·90%에서 경고합니다.

- 토큰 합계 (런타임 공통)
- Codex 5시간 한도 사용률 증가분 (v1 로직 이식, Codex 런타임을 쓸 때만)
- 경과 시간

Claude는 계정 사용률을 읽는 공식 경로를 아직 확인하지 못했으므로, 초기에는 토큰 한도로만 제한합니다.

**기록의 크기 제한**: 명령 출력과 메시지는 이벤트당 상한(예: 4,000자)으로 잘라 저장하고, 비밀값 패턴을 가린 뒤 기록합니다. 전체 출력이 필요하면 파일로 따로 둡니다.

**서버 재시작 복구**: Run 상태는 이벤트마다 SQLite에 기록되므로, 서버가 죽었다 켜지면 진행 중이던 Run을 `interrupted`로 표시하고 남은 런타임 프로세스를 정리합니다. 자동으로 다시 실행하지는 않습니다.

## 서버 API와 새 대시보드

대시보드·CLI·벤치마크는 모두 같은 HTTP API를 씁니다. v1처럼 상태 전체를 매번 보내지 않고, 이벤트를 흐름(SSE)으로 보냅니다.

| 메서드 · 경로 | 용도 |
| --- | --- |
| `GET /api/projects` · `POST /api/projects` | 프로젝트 목록·연결 |
| `POST /api/projects/:id/doctor` | 런타임·설정·검증 명령 점검 |
| `POST /api/runs` | Run 시작 (요청, 이미지, 워크플로 강제 선택 가능) |
| `GET /api/runs/:id` | Run·Step·보고·게이트·토큰 상세 |
| `POST /api/runs/:id/cancel` · `/resume` | 중단·이어하기 |
| `GET /api/runs/:id/events` (SSE) | 실시간 이벤트 |
| `GET /api/approvals` · `POST /api/approvals/:id` | 승인 대기열·응답 |
| `GET /api/usage` | 토큰·한도 사용률 집계 |

모든 변경 요청은 CSRF 토큰을 요구합니다. API 타입은 `core`에서 정의해 서버와 `web`이 같이 씁니다.

**실시간 전송 규칙** (v1 서버가 기준선 측정 중 메모리 4GB 초과로 죽은 원인을 막는 규칙)

- 상태 전체를 보내지 않습니다. 이벤트 하나에 일련번호를 붙여 그 이벤트만 보내고, 끊겼다 다시 붙은 화면은 마지막 번호 이후만 다시 받습니다.
- 받는 쪽이 느리면 보내기를 멈춥니다. 연결마다 대기 버퍼에 상한을 두고, 넘으면 그 연결을 끊습니다. 화면은 다시 붙어 이어 받습니다.
- 글자 단위로 흐르는 메시지는 일정 간격으로 묶어 보냅니다.
- 회귀 테스트: 응답을 읽지 않는 연결을 붙여 둔 채 이벤트를 대량으로 발생시켜도 서버 메모리가 늘지 않는지 확인합니다.

**대시보드 화면**

| 화면 | 보여주는 것 | v1과 다른 점 |
| --- | --- | --- |
| 작업 콘솔 | 요청 입력, 진행 중 Run의 Step 타임라인, 승인 카드 | 에이전트 13개 상태 대신 Workflow 단계를 보여줌 |
| Run 상세 | 요구사항별 상태, 게이트 G1\~G5 결과, diff, verify 출력, Step별 토큰 | 완료 근거를 한눈에 확인 |
| 프로젝트 설정 | `.agent-desk/config.json` 편집, 역할별 런타임 선택, doctor 결과 | 설정이 파일로 남아 Git으로 추적 |
| 스킬 | SKILL.md 목록·편집, 설명 필수 항목 점검 | 트리거·제외 조건 누락 경고 |
| 사용량 | Run별·역할별·런타임별 토큰, 한도 사용률 추이 | 턴 증분 기반의 정확한 숫자 |
| 벤치마크 | 라벨별 성공률·거짓 완료·성공당 토큰 비교 차트 | 신규 |

화면 상세 디자인은 코어가 돌아간 뒤(5단계) 별도 목업으로 정합니다.

## 테스트·벤치마크 전략

테스트는 빠르고 모델 사용량이 들지 않는 것부터 쌓고, 실제 모델을 쓰는 측정은 벤치마크에서만 합니다.

| 층 | 대상 | 도구 | 모델 사용 |
| --- | --- | --- | --- |
| 단위 | 오케스트레이터, 게이트, REDO 규칙, 예산, 토큰 회계 | `node:test` + `runtime-fake` 시나리오 | 없음 |
| 계약 | 런타임 어댑터가 이벤트를 올바르게 정규화하는지 | 실제 CLI 출력을 녹화한 스냅샷 재생 | 녹화할 때만 |
| 통합 | HTTP API, 승인 브로커, SSE | 서버 + `runtime-fake` | 없음 |
| 스모크 | 실제 Codex·Claude 연결 | `agent-desk doctor` + 짧은 과제 1개 | 소량 |
| 벤치마크 | 성공률·거짓 완료·토큰 | `bench/` 과제 10개, 숨은 채점 테스트 | 큼 |

**runtime-fake 시나리오 예시**: "builder가 파일을 바꾸지 않고 완료 보고" → G2가 잡는지, "verify 명령 실패 후 수정" → REDO 1회로 끝나는지, "환경 오류" → 재시도 없이 멈추는지. v1 실패 기록에서 나온 사례를 그대로 테스트로 만듭니다.

**벤치마크 운영**

- `bench/adapters/`에 v1·v2 어댑터를 두고, 과제·채점·리포트는 그대로 공유합니다. v1 어댑터는 구현됐고, 측정 중 서버 중단에도 이어서 돌도록 보강했습니다.
- **과제 세트 2종**: 쉬운 세트 T01\~T10(고정, 수정하지 않음)과 어려운 세트 H01\~(여러 파일·얽힌 요구사항·함정 포함, 작성 예정). v1이 쉬운 세트를 모두 성공해서 성공률 차이는 어려운 세트에서만 볼 수 있습니다. 어려운 세트도 v2 코어를 쓰기 전에 커밋해 고정합니다.
- **측정 라벨**

  | 라벨 | 구성 | 답하는 질문 |
  | --- | --- | --- |
  | `v1-13` | v1, 에이전트 13개 | 기준선 |
  | `v2-codex` | v2, Codex, 리뷰 always | 새 구조의 효과 |
  | `v2-codex-noreview` | v2, Codex, 리뷰 never | 독립 리뷰가 비용만큼 가치가 있나 |
  | `v2-codex-auto` | v2, Codex, 리뷰 auto | 선택적 리뷰로 둘 다 얻을 수 있나 |
  | `v2-claude` | v2, Claude | 런타임 교체 |
  | `v2-mixed` | Codex 구현 + Claude 리뷰 | 다른 모델의 교차 검증 효과 |
- 같은 모델·같은 추론 수준으로 맞춰 비교하고, 조건은 결과의 `_config.json`에 기록합니다. 각 라벨은 과제당 2회, 최종 측정은 3회 반복합니다.
- 주 지표는 토큰·판정 정확도·소요 시간입니다. 5시간 한도 사용률은 측정 중 다른 작업이 섞이므로 참고값입니다.
- 설계 변경은 벤치마크 결과와 함께 ADR(`docs/adr/`)로 남겨, 어떤 변경이 몇 %를 바꿨는지 추적합니다.

## 개발 단계와 결정이 필요한 질문

각 단계는 통과 기준(게이트)을 만족해야 다음 단계로 넘어갑니다.

작업 단위 체크리스트: 개발 로드맵

1. **0단계 · 레거시 분리와 기준선** (진행 중): `v1-legacy` 태그, `legacy/` 이동, 벤치마크 어댑터 분리는 완료. `v1-13` 측정 중. 이어서 어려운 과제 세트를 만들어 v1 기준선을 한 번 더 측정
   - 게이트: 쉬운 세트·어려운 세트 모두 v1 기준선 확보
2. **1단계 · 골격과 프로토타입** (진행 중): `core` 타입·보고 검증·토큰 원장과 `runtime-fake`는 완료(테스트 15개). 남은 것은 실제 CLI로 P1(Codex)·P2(Claude) 확인
   - 게이트: 두 CLI 모두 MCP 도구 호출·턴 토큰 증분·중단·프로세스 정리가 동작. 안 되는 항목은 어댑터 설계를 고친 뒤 다시 확인
3. **2단계 · 코어 워크플로**: `answer`(빠른 경로)·`build` 워크플로, 게이트 G1\~G5, REDO, 스냅샷·되돌리기, 리뷰 정책, 예산, CodexRuntime, CLI `run`·`doctor`
   - 게이트: `v2-codex`가 `v1-13`보다 실제 성공률이 같거나 높고, 성공 1건당 토큰과 거짓 경보가 낮음. 리뷰 정책 3종 측정으로 기본값 결정
4. **3단계 · Claude와 혼합**: ClaudeRuntime, 승인 브로커 연결, `plan-build`·`investigate` 워크플로
   - 게이트: `v2-claude`, `v2-mixed` 측정 완료. 독립 리뷰 대 자체 점검 비교 포함
5. **4단계 · 서버와 설정**: HTTP API(실시간 전송 규칙 포함), SQLite·재시작 복구, `.agent-desk/` 설정·스킬·메모, v1 보안·프로세스·Supabase 이식
   - 추가 항목: 역할 정의 파일(`.agent-desk/agents/<role>.md`), `agent-desk init`, `agent-desk skills check`
   - 게이트: 특정 프로젝트에 묶이지 않고 설정 파일만으로 운영
6. **5단계 · 새 대시보드**: 화면 목업 → `web/` 구현
   - 게이트: v1 대시보드 없이 일상 사용 가능
7. **6단계 · 마무리**: 최종 벤치마크(전 라벨 × 3회), 문서 정리, 이력서 문장
   - 추가 항목: 스킬 트리거·유무 비교 과제, 실패 분석 보고서(원인을 스킬·역할 파일·워크플로 중 고칠 곳으로 분류)
   - 게이트: 모든 수치가 저장소의 결과 파일로 재현 가능

**결정 사항** (2026-11-13)

| 질문 | 결정 |
| --- | --- |
| Claude 연결 방식 | CLI 헤드리스로 시작. 1단계 프로토타입에서 Agent SDK가 로컬 로그인으로 동작하면 옮김 |
| 워크플로 선택 | lead가 자동 분류하고, 대시보드에서 사용자가 직접 고르면 그걸 따름 |
| 에이전트 간 협의 | 빼고 시작. 벤치마크에서 필요성이 확인될 때만 추가 |
| Supabase·프로세스 관리 | 4단계에 테스트와 함께 이식 |

**남은 위험과 대응**

| 위험 | 영향 | 대응 |
| --- | --- | --- |
| Codex App Server가 실험적 프로토콜이라 CLI 업데이트로 깨짐 | Codex 런타임 전체 중단 | 어댑터에 검증한 버전 범위 기록, `doctor` 경고, 실제 출력 녹화본으로 계약 테스트 |
| P1·P2에서 MCP 도구 호출이나 턴 토큰 증분이 기대와 다름 | 런타임 계약 수정 필요 | Codex는 동적 도구로, 토큰은 누적값 차분(`deltaFromCumulative`, 구현됨)으로 대체 |
| 모델이 `submit_report`를 호출하지 않고 끝냄 | Step 결과 없음 | 턴 종료 시 보고가 없으면 같은 세션에 한 번 더 요청, 그래도 없으면 실패로 기록 |
| 게이트가 엄격해 거짓 경보가 늘어남 | 사용자가 판정을 무시하게 됨 | 거짓 경보를 별도 지표로 측정, 단계 게이트에 포함 |
| verify 명령이 없는 프로젝트 | G3가 비어 완료 근거가 약함 | `doctor`가 후보 명령을 제안, 없으면 리뷰 정책을 `always`로 고정하고 보고에 "자동 검증 없음" 표시 |
| 벤치마크 과제를 설계자가 만듦 | 결과의 신뢰도 의심 | 과제를 v2 코드 전에 커밋해 고정, 전부 공개, 사용자가 직접 만든 과제 추가 권장 |
| 표본이 작음(과제당 2\~3회) | 작은 차이를 개선으로 오해 | 반복 간 편차를 함께 보고, 편차보다 작은 차이는 주장하지 않음 |

## 출처

- [하네스 v2 설계: Claude·Codex 통합 에이전트 하네스](https://claude.ai/artifact/26K7ar9oB1U4KewBDouxR1) (방향 문서, 공식 문서 요약·책 메모 반영)
- [Claude Code CLI reference](https://docs.claude.com/en/docs/claude-code/cli-reference)
- [Best practices for Claude Code](https://code.claude.com/docs/en/best-practices)
- [Codex best practices](https://developers.openai.com/codex/learn/best-practices)
- [Codex App Server](https://developers.openai.com/codex/app-server)
- 실측 데이터: `bench/results/history-13-agents.md` (agent-desk-local)
