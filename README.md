# Agent Desk

로컬 PC에서 Codex와 Claude를 함께 또는 하나만 써서 코딩 작업을 처리하는 에이전트 하네스입니다. 현재 v2로 재설계하는 중입니다.

| 경로 | 내용 |
|---|---|
| `legacy/` | v1 (13개 에이전트, Codex 전용 대시보드). 태그 `v1-legacy`. 실행 방법은 [legacy/README.md](legacy/README.md) |
| `bench/` | v1·v2 공용 벤치마크: 고정 과제 10개, 숨은 채점 테스트, 실행 기록 분석 |
| `docs/` | 설계 문서 안내, 결정 기록(ADR), 작업 기록 |
| `packages/` | v2 (작성 예정) |

## 자주 쓰는 명령

```powershell
npm run legacy:start     # v1 서버 실행 (Windows는 legacy\Start-AgentDesk.cmd도 가능)
npm run legacy:test      # v1 테스트
npm run bench:validate   # 벤치마크 과제가 공정한지 확인
npm run bench:selftest   # 벤치마크 러너 자체 검증
```

설계와 진행 상황은 [docs/README.md](docs/README.md)를 보세요.
