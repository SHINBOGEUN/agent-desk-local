# 문서 안내

Agent Desk v2 재설계 작업의 문서 위치입니다. 설계 원본은 Claude 문서에서 관리하고, 저장소에는 결정 기록과 측정 결과를 둡니다.

## 설계 문서 (원본: Claude 문서)

| 문서 | 내용 |
|---|---|
| [Agent Desk v2 전체 설계서](https://claude.ai/artifact/YJkaS7TK9NDkcNdCEecBb6) | 목표, 저장소 구조, 개념 모델, 실행 흐름, 런타임 계약, 게이트, 맥락, 보안, 관측, API, 테스트, 단계 |
| [개발 로드맵 탭](https://claude.ai/artifact/YJkaS7TK9NDkcNdCEecBb6#bc614b39-fee4) | 0~6단계 작업 체크리스트와 단계별 게이트 |
| [하네스 v2 설계 방향](https://claude.ai/artifact/26K7ar9oB1U4KewBDouxR1) | 공식 문서(Claude·Codex) 모범 사례 정리, 책 메모 반영, 재작성 판단 |

## 저장소 안의 문서

| 경로 | 내용 |
|---|---|
| `docs/HANDOFF.md` | Claude와 Codex가 번갈아 작업할 때 먼저 읽는 인수인계 문서(읽는 순서, 현재 상태, 다음 작업, 작업 규칙, 기록) |
| `docs/design-v2.md` | 전체 설계서 사본(원본은 위 Claude 문서) |
| `docs/adr/` | 설계 결정 기록 (ADR). 결정마다 한 파일 |
| `bench/README.md` | 벤치마크 구성·지표·실행 방법 |
| `bench/results/history-13-agents.md` | v1(13개 에이전트) 실제 실행 60건 분석 |
| `bench/results/runs/<라벨>/` | 벤치마크 실행 결과 (라벨별) |
