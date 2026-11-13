# ADR 0002 · 런타임 어댑터, 4개 역할, 결정론적 게이트

- 날짜: 2026-11-13
- 상태: 결정 (Claude 연결 방식은 1단계 프로토타입 후 재검토)

## 결정
- 모델 호출은 `Runtime` 인터페이스 뒤에 둔다: `runtime-codex`(App Server), `runtime-claude`(로컬 Claude Code CLI 헤드리스), `runtime-fake`(테스트).
- Claude는 본인 PC에 로그인된 CLI로만 쓰고, 서버는 `127.0.0.1`에만 연다. 공유하지 않는다.
- 역할은 lead·builder·verifier·researcher 4개. backend·frontend·db·security 등은 스킬로 전환한다.
- 작업 순서는 코드의 워크플로(answer·investigate·build·plan-build)가 정한다. lead가 자동 분류하고 사용자가 직접 고를 수 있다.
- 완료 판정은 게이트(G1 보고 형식, G2 변경 대조, G3 verify 명령, G4 독립 리뷰, G5 예산)로만 한다. REDO는 Run당 최대 2회.
- 토큰은 턴 증분만 기록한다. 세션은 Run 밖으로 재사용하지 않는다.
- 에이전트 간 협의 기능은 빼고 시작한다(벤치마크로 필요성이 확인될 때만 추가).
