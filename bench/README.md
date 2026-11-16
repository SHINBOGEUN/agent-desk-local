# Agent Desk 벤치마크

에이전트 구성을 바꿨을 때 **토큰 사용량**과 **실제 정확도**가 어떻게 변하는지 같은 조건에서 측정합니다. 에이전트의 자기 보고는 믿지 않고, 숨겨진 테스트로 결과물을 직접 채점합니다.

## 구성

| 경로 | 설명 |
|---|---|
| `sample-app/` | 벤치마크 대상인 작은 할 일 서비스 (API·화면·DB·설정, 외부 패키지 없음) |
| `tasks/T01~T10/` | 고정 과제. `task.json`(요청문), `acceptance.test.mjs`(에이전트에게 보이지 않는 채점 테스트), `solution.mjs`(채점이 공정한지 증명하는 모범 답안) |
| `validate-tasks.mjs` | 모든 과제가 원본에서는 실패하고 모범 답안에서는 통과하는지 확인 |
| `run.mjs` | 과제 실행·채점·결과 저장 (버전 공통) |
| `adapters/v1.mjs` | v1(`legacy/`) HTTP API로 과제를 실행하는 어댑터. v2 어댑터는 2단계에서 추가 |
| `report.mjs` | 라벨(구성)별 지표를 집계하고 비교 |
| `analyze-history.mjs` | 기존 `data/state.json` 실행 기록 분석 (토큰 누적 기록 보정 포함) |
| `selftest.mjs` | 가짜 Agent Desk 서버로 러너·채점·리포트를 끝까지 검증 (Codex 사용 없음) |

| 과제 | 분야 | 내용 |
|---|---|---|
| T01 | 백엔드 버그 | 상태 필터 버그 수정 |
| T02 | 백엔드 검증 | 제목 입력 검증 |
| T03 | 프론트엔드 | 남은 할 일 수 표시 |
| T04 | DB | 우선순위 필드 + 스키마 마이그레이션 |
| T05 | 백엔드 기능 | 페이지네이션 |
| T06 | 보안 | 삭제 API 관리자 인증 (기존 테스트 수정 필요) |
| T07 | 풀스택 | 완료 항목 일괄 삭제 API + 버튼 |
| T08 | 서버 설정 | PORT 검증 |
| T09 | 질문 | 코드 수정 없이 설정값 답변 (과잉 위임 측정) |
| T10 | 백엔드 기능 | 최신순 정렬 |

## 지표

- **실제 성공률**: 프로젝트 자체 테스트와 숨은 채점 테스트를 모두 통과한 비율
- **거짓 완료 비율**: Agent Desk가 '완료'로 끝냈지만 실제로는 채점에 실패한 비율. 할루시네이션(근거 없는 완료 주장)을 객관적으로 측정하는 지표입니다.
- **체커 PASS인데 실제 실패**: 독립 검증 에이전트가 놓친 결함 수
- **토큰**: 요청당 평균·중앙값, 성공 1건당 토큰, 캐시 미적용 입력, 출력 토큰, 5시간 한도 사용률
- **조율 비용**: 투입 에이전트 수, 팀원 작업 수, 협의 턴, 소요 시간

과제마다 새 프로젝트 폴더(임시 폴더, 자체 `git init`)를 Agent Desk에 등록합니다. 그래서 과제 사이에 메인 AI 대화나 상위 저장소의 `AGENTS.md`가 섞이지 않습니다.

## 실행 순서 (Windows PowerShell)

```powershell
npm run bench:validate          # 과제가 공정한지 확인 (Codex 사용 없음)
npm run bench:selftest          # 러너 자체 검증 (Codex 사용 없음)

# v1 서버를 켠 뒤(legacy\Start-AgentDesk.cmd) 기준선 실행
node bench/run.mjs --label v1-13 --adapter v1 --repeat 2 --usage-limit 20

# 다른 구성·버전을 같은 과제로 실행한 뒤 비교
node bench/report.mjs v1-13 <다른-라벨>   # bench/results/benchmark-report.md 생성
```

- 실행 중에는 Agent Desk에서 다른 요청을 보내지 마세요. 계정 전체의 5시간 사용률을 측정하기 때문입니다.
- 사용률 한도에 걸려 멈추면 한도가 회복된 뒤 같은 명령을 다시 실행하세요. 이미 기록된 과제는 건너뜁니다.
- 편차를 줄이려면 `--repeat 2` 이상으로 실행하세요. 같은 과제도 AI 실행마다 결과가 달라질 수 있습니다.
- 과제마다 `bench <라벨> <과제>` 이름의 프로젝트가 Agent Desk에 추가됩니다. 작업 폴더는 OS 임시 폴더의 `agent-desk-bench/`에 남아 있어 결과를 직접 확인할 수 있습니다.

## 기존 기록 분석

```powershell
node bench/analyze-history.mjs legacy\data\state.json --md bench\results\history.md
```

Agent Desk는 프로젝트마다 메인 AI 스레드를 이어 쓰는데, 스레드 누적 토큰을 요청별 사용량으로 저장해 왔습니다. 그래서 요청이 쌓일수록 대시보드 토큰 수가 부풀려집니다. 분석 스크립트는 같은 스레드의 직전 누적값을 빼서 요청별 증분으로 보정합니다. 결과 JSON에는 요청 원문을 저장하지 않습니다.

## 어려운 과제 세트 (H01~H05)

T01~T10은 에이전트가 모두 성공해서 구성 차이가 성공률에 드러나지 않았습니다(v1-13 기준 20/20). 그래서 여러 파일을 고쳐야 하고 숨은 경계 조건이 있는 과제 5개를 추가했습니다. 기존 과제와 섞이지 않도록 `--set hard`로만 실행되고, 라벨도 따로 씁니다.

| ID | 분류 | 내용 | 숨은 함정 |
|---|---|---|---|
| H01 | 풀스택 | 태그: 마이그레이션, 정규화·검증, 필터, 집계, 화면 | 잘못된 PATCH는 title/done도 바꾸면 안 됨, 태그 이스케이프, 정규화 뒤에 개수 검사 |
| H02 | 풀스택 | 마감일·지연: 달력 검증, 주입된 시계, 정렬, 화면 | 존재하지 않는 날짜, `Date.now()` 직접 사용 금지, overdue는 저장하지 않음 |
| H03 | 백엔드 | 휴지통·복원·30일 자동 비우기 | 삭제 후 id 재사용 금지, 휴지통 항목은 수정 불가, 시계 주입 |
| H04 | 신뢰성 | 원자적 저장, 손상 복구, 새 버전 데이터 보호, 요청 크기 제한 | 새 버전 파일을 손상으로 오인해 덮어쓰면 안 됨, 정확히 100KB 경계 |
| H05 | 보안 | API 키 인증, 사용자별 격리 | 남의 항목은 403이 아니라 404, 본문으로 owner 지정 불가, 인증 끄면 기존 동작 유지 |

```powershell
node bench/validate-tasks.mjs                                  # 모든 과제 공정성 검증
node bench/run.mjs --label v1-13-hard --set hard --repeat 3    # v1 어려운 과제 3회
```

## 범용성 검증 (generality check)

`sample-app`(Node) 외에 서로 다른 종류의 프로젝트 두 개를 더 둬서, 하네스가 특정 언어·프로젝트 형태에 묶여 있지 않음을 검증합니다.

| 샘플 | 종류 | 테스트 | 과제 |
|---|---|---|---|
| `sample-app` | Node 서버 | `node --test` | T01–T10, H01–H05 |
| `samples/python-inventory` | Python 표준 라이브러리 | `python -m unittest` | P01 버그, P02 기능, P03 질문 |
| `samples/web-notes` | 정적 웹(HTML + ES 모듈) | `node --test` | W01 버그, W02 기능, W03 질문 |

- `task.json`의 `sample` 필드로 샘플을 고릅니다(생략 시 `sample-app`). 샘플별 실행 방식과 verify 명령은 `lib/evaluate.mjs`의 `SAMPLES`에 있습니다.
- 실행: `node bench/run.mjs --adapter v2 --label v2-general --set general` (`python`, `web`, `all`도 가능). Python 3가 필요하며 `BENCH_PYTHON`으로 실행 파일을 지정할 수 있습니다.
- 검증: `node bench/validate-tasks.mjs`가 모든 샘플의 과제를 증명합니다(미해결 시 숨은 테스트 실패, 참조 해법 적용 시 통과).

> 런타임 모드(ADR 0009): v2의 기본값이 `codex+claude`(Codex가 만들고 Claude가 검토)로 바뀌었습니다. 기존 `v2-codex*` 결과와 같은 조건으로 비교하려면 `--mode codex`를 붙이세요. 모드 비교 예: `--label v2-mix --mode codex+claude`.

## 검증 도구 (ADR 0010)

- 자체 점검 비교(3-5): `--review self`(builder가 같은 세션에서 자기 작업 점검)를 `always`, `never`와 같은 과제로 비교.
- 분류 정확도(3-6): `report.mjs` 표의 "워크플로 분류 정확도". 과제의 기대 워크플로는 질문이면 `answer`, 코드 과제면 `build`/`plan-build`(`task.json`의 `expect.workflows`로 바꿀 수 있음).
- 스킬 유무 비교(6-4): 같은 세트를 `--no-skills`로 한 번 더 돌려 비교(`web` 세트에 `html-output` 스킬이 있음).
- 트리거 검증(6-4): `npm run agent-desk -- skills trigger-test --project bench/samples/web-notes`.
- 실패 분석(6-5): `node bench/failures.mjs --label <라벨>` → `bench/results/failures.md`.
