# ADR 0009: 런타임 조합(모드)과 기본값 "Codex가 만들고 Claude가 검토"

- 날짜: 2026-11-16
- 상태: 결정 (사용자 결정)

## 결정

1. 조합을 네 가지 모드로 정리한다. `builder+reviewer` 표기:
   - `codex`: 모든 역할 Codex
   - `claude`: 모든 역할 Claude
   - `codex+claude`: lead·builder·researcher는 Codex, verifier는 Claude (**기본값**)
   - `claude+codex`: 반대
2. 설정 방법(우선순위 순): `--runtime`(모든 역할 하나로) > `--mode`·대시보드 선택 > `config.mode` > `config.runtimes`(primary/review, 역할별 `roles.<role>.runtime`) > 기본값. `config.mode`와 `config.runtimes`를 함께 쓰면 오류.
3. 기본값의 검토 런타임(Claude)이 설치되어 있지 않으면 primary(Codex)가 검토까지 맡고 안내를 남긴다. 사용자가 모드를 명시했을 때는 대체하지 않고 실패시킨다(대시보드는 시작 전에 막는다).
4. 역할 파일에 `model-codex`, `model-claude`를 둘 수 있다. 역할이 실제로 배정된 런타임의 값을 쓰고, 없으면 `model`을 쓴다.
5. Run 시작 이벤트(`run_started`)에 역할별 런타임을 기록해 대시보드와 결과에서 누가 어떤 모델이었는지 보이게 한다.

## 이유

- 책의 "두 명이 한 번씩 보는 것이 한 명이 두 번 보는 것보다 낫다"를 다른 모델끼리로 넓히면 같은 모델의 맹점을 공유하지 않는다는 가설이 생긴다. 측정 전이지만 사용자가 기본값으로 채택.
- 이전 벤치마크(`v2-codex*`)는 모두 Codex 단독이었으므로, 다시 비교할 때는 `--mode codex`를 명시해야 같은 조건이다.

## 남은 것

- 네 모드를 같은 과제로 비교하는 측정(사용자 PC).
- 한쪽 사용량 한도가 찼을 때 다른 런타임으로 넘기는 정책, Claude 사용량 게이지(5-7).
