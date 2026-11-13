# v2 패키지

설계: [Agent Desk v2 전체 설계서](https://claude.ai/artifact/YJkaS7TK9NDkcNdCEecBb6)

| 패키지 | 상태 | 역할 |
|---|---|---|
| `core/` | 1단계 | 도메인 타입, 보고 스키마 검증, 토큰 회계. 다른 패키지·파일시스템·HTTP에 의존하지 않음 |
| `runtime-fake/` | 1단계 | 스크립트로 동작하는 테스트용 런타임 |
| `runtime-codex/` | 2단계(2-2 구현, 실제 Codex 확인은 2-10) | Codex App Server 어댑터 |
| `runtime-claude/` | 3단계 | 로컬 Claude Code CLI(헤드리스) 어댑터 |
| `orchestrator/` | 2단계(2-3~2-5 완료) | 분류 → answer 빠른 경로 / build 워크플로, 게이트 G1·G2·G3·G5, REDO, 실패 유형을 실행하고 Run 상태를 정하는 코드. 독립 리뷰(G4)와 리뷰 정책 `always/auto/never` |
| `tools-mcp/` | 2단계(2-1 완료) | 하네스 도구(보고 제출·사용자 질문·승인)를 런타임에 주는 로컬 MCP 서버 |
| `cli/` | 2단계(2-7 완료) | `agent-desk run`·`doctor`·`revert`: 인자 해석, Codex 실행 파일 탐색(PATH → npm 전역 → 저장값), PC별 설정 저장, 프로젝트 `.agent-desk/config.json` 검증 |
| `store/` | 2단계(2-6 완료) | SQLite(`node:sqlite`) 저장소: Run·단계·이벤트·토큰 증분, 비밀값 가리기, 재시작 시 `interrupted` 복구, 직전 Run Brief |
| `server/` | 4단계 | HTTP + SSE API, 저장소, 승인 브로커 |
| `web/` | 5단계 | 대시보드 |
| `cli/` | 2단계 | `agent-desk run`, `agent-desk doctor` |

패키지는 필요한 단계에 만들어 빈 폴더를 두지 않습니다.

## 실행 방식

- Node.js 22.18 이상이 TypeScript를 바로 실행합니다(타입 제거). 빌드 단계가 없습니다.
- 그래서 지워지는 문법만 씁니다: `enum`, `namespace`, 생성자 매개변수 속성은 쓰지 않습니다. import 경로에는 `.ts`를 붙입니다.
- 패키지 사이 import는 루트 `package.json`의 `imports`(`#core`, `#runtime-fake`, `#tools-mcp`, `#runtime-codex`, `#orchestrator`, `#store`, `#cli`)를 씁니다. 설치 없이 동작합니다.
- 타입 검사: `npm install` 후 `npm run typecheck`. 테스트: `npm test`.
- 런타임 의존성은 두지 않습니다. 보고 스키마 검증도 `core/src/schema.ts`의 작은 검증기로 합니다.
