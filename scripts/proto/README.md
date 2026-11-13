# 1단계 프로토타입 (P1~P3)

v2의 런타임 어댑터를 만들기 전에, 설계서의 "프로토타입으로 먼저 확인할 것"을 실제 CLI로 확인하는 스크립트입니다. 결과는 `scripts/proto/results/*.json`에 저장되고, 이 결과로 어댑터 설계를 확정합니다(ADR).

**벤치마크 측정 중에는 실행하지 마세요.** 계정 사용률이 함께 올라가 기준선이 오염됩니다. 각 스크립트는 짧은 요청 3~4개만 보냅니다.

| 스크립트 | 확인하는 것 |
|---|---|
| `p1-codex.mjs` | P1-a 스레드 설정으로 로컬 MCP 서버 연결 · P1-b read-only 샌드박스에서 MCP 도구 호출(필요한 승인 요청 기록) · P1-c 턴별 토큰 `last`의 합이 `total`과 같은지 · P3-a `turn/interrupt` · P3-b 종료 후 MCP 서버 프로세스 정리 |
| `p2-claude.mjs` | P2-a 한 프로세스에서 stream-json으로 여러 턴 · P2-b `--mcp-config` 도구 호출과 `--allowedTools` 제한 · P2-c 턴별 usage가 증분인지 누적인지 · P3-c stream-json 중단 메시지 · P3-d 종료 후 MCP 서버 프로세스 정리 |
| `mini-mcp-server.mjs` | 두 스크립트가 쓰는 최소 MCP 서버. 도구 호출과 자기 프로세스 ID를 로그로 남겨, 모델의 말이 아니라 실제 호출로 확인 |

## 실행 (Windows PowerShell)

```powershell
cd D:\work\AI-Agent\agent-desk-local
node scripts/proto/p1-codex.mjs --codex "C:\Users\<사용자>\AppData\Roaming\npm\node_modules\@openai\codex\node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin\codex.exe"
node scripts/proto/p2-claude.mjs --claude (Get-Command claude).Source
```

- `claude`를 찾지 못하면 `where.exe claude`로 위치를 확인해 `--claude`에 넘깁니다. `.cmd` 파일이면 같은 폴더의 실제 실행 파일을 지정합니다.
- 각 스크립트는 임시 작업 폴더를 만들고, 그 안에 전체 통신 기록(`transcript.jsonl`)과 MCP 로그를 남깁니다. 결과 JSON에 경로가 적힙니다.
