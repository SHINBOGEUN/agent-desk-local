# ADR 0003 · 1단계 프로토타입 결과 (Codex·Claude 연결 방식)

- 날짜: 2026-11-13
- 상태: 결정
- 근거 파일: `scripts/proto/results/p1-codex.json`, `p2-claude.json` (Windows 11, Node 24.20, Codex App Server 0.167.2, Claude Code 2.1.322)

## 확인한 것

### Codex (P1, P3-a, P3-b)
| 질문 | 결과 |
|---|---|
| 스레드 설정(`config`)으로 로컬 stdio MCP 서버를 붙일 수 있는가 | 가능. 서버 초기화와 도구 호출이 확인됨 |
| 읽기 전용 샌드박스에서 MCP 도구를 호출할 수 있는가 | **설정이 필요함.** 승인 정책이 `never`이면 `MCP tool call requires approval, but approval policy is never`로 호출이 거부됨 |
| `thread/tokenUsage/updated`의 `last`가 턴 증분이고 합이 `total`과 같은가 | 같음 (4회 실행 모두 `sum(last) == total`) |
| `turn/interrupt`가 긴 턴을 멈추는가 | 5~9ms 만에 `interrupted` |
| app-server 종료 뒤 MCP 프로세스가 남는가 | 남지 않음 |

호출 허용 방식을 세 가지로 비교했다.

| 방식 | 결과 | 비고 |
|---|---|---|
| A. `mcp_servers.agentdesk.default_tools_approval_mode = "approve"` | 통과, 승인 요청 없음 | **채택** |
| B. 도구에 `readOnlyHint` 표시 + `auto` | 통과, 승인 요청 없음 | `submit_report`는 읽기 전용이 아니라 표시가 정직하지 않음 |
| C. 승인 정책 `on-request` | 통과, `mcpServer/elicitation/request`에 하네스가 응답해야 함 | 매 호출마다 왕복이 생김 |

### Claude (P2, P3-c, P3-d)
| 질문 | 결과 |
|---|---|
| `claude -p --input-format stream-json --output-format stream-json`로 한 프로세스에서 다중 턴이 되는가 | 가능. 같은 세션으로 2번째 턴 처리 |
| `--mcp-config`로 하네스 MCP 서버를 붙여 도구를 호출할 수 있는가 | 가능 |
| 턴별 `usage`가 증분인가 | 증분. 단 `total_cost_usd`는 누적이라 차이를 계산해야 함 |
| stream-json 제어 메시지로 중단되는가 | 16ms 만에 `error_during_execution`, 프로세스는 살아 있음 |
| 종료 뒤 MCP 프로세스가 남는가 | 남지 않음 |
| `--allowedTools`로 도구가 제한되는가 | **아니오.** 승인 없이 쓸 도구를 지정하는 옵션일 뿐, Glob·Grep·WebFetch 등 내장 도구가 그대로 제공됨 |

## 결정
1. Codex의 하네스 도구 서버는 `default_tools_approval_mode = "approve"`로 연결하고 승인 정책은 `never`를 유지한다. 승인 요청 왕복이 없어서 가장 단순하다. 이 설정은 하네스가 직접 띄운 MCP 서버(`agentdesk`)에만 적용한다.
2. 토큰 원장은 Codex `last`를 턴 증분으로 기록하고, 합이 `total`과 어긋나면 `total`의 차이로 보정한다.
3. Claude 런타임은 로컬 CLI 헤드리스(stream-json)로 구현한다. Agent SDK 전환은 필요가 확인될 때까지 보류한다.
4. Claude에서 읽기 전용 역할(verifier 등)은 도구 목록 자체를 제한하는 옵션으로 만든다(`--allowedTools`만으로는 제한되지 않음). 제한이 실제로 되는지는 `runtime-claude` 구현 때 테스트로 확인한다.
5. 모델은 설정으로 고정한다. 프로토타입은 CLI 기본 모델로 실행되어 `claude-opus-5-5`가 쓰였다.
6. 비용은 누적 값의 차이로 계산한다.

## 알게 된 것
- 아무 일도 안 시키는 3턴짜리 Codex 스레드가 약 5만 토큰을 썼다. 턴마다 약 1.7만 토큰의 기본 비용(시스템 지침과 도구 정의)이 든다는 뜻이고, 턴 수를 줄이는 것이 토큰을 줄이는 직접적인 방법이다. 이 값은 v2 측정에서 단계별 토큰을 해석할 때 기준으로 쓴다.
- 이 프로토타입은 읽기 전용 샌드박스·승인 `never` 조합만 확인했다. 쓰기 권한이 있는 builder 역할의 승인 흐름은 `runtime-codex` 구현 때 따로 확인한다.

## 남은 것
- Windows에서 `codex.exe` 경로를 PATH로 찾지 못하는 문제: `doctor`가 실행 파일을 찾아 PC 설정에 저장한다(설계서 개정 2).
- 프로토타입 스크립트는 사용량을 약간 쓴다. 기준선 측정 중에는 실행하지 않는다.
