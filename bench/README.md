# Agent Desk 벤치마크

에이전트 구성을 바꿨을 때 **토큰 사용량**과 **실제 정확도**가 어떻게 변하는지 같은 조건에서 측정합니다. 에이전트의 자기 보고는 믿지 않고, 숨겨진 테스트로 결과물을 직접 채점합니다.

## 구성

| 경로 | 설명 |
|---|---|
| `sample-app/` | 벤치마크 대상인 작은 할 일 서비스 (API·화면·DB·설정, 외부 패키지 없음) |
| `tasks/T01~T10/` | 고정 과제. `task.json`(요청문), `acceptance.test.mjs`(에이전트에게 보이지 않는 채점 테스트), `solution.mjs`(채점이 공정한지 증명하는 모범 답안) |
| `validate-tasks.mjs` | 모든 과제가 원본에서는 실패하고 모범 답안에서는 통과하는지 확인 |
| `run.mjs` | 실행 중인 Agent Desk API로 과제를 실행하고 채점 결과를 저장 |
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

# Agent Desk 서버를 켜고 비교할 에이전트 구성을 적용한 뒤 실행
node bench/run.mjs --label baseline-13 --usage-limit 20
# 개선한 구성으로 바꾼 뒤 같은 과제를 실행
node bench/run.mjs --label improved --usage-limit 20

node bench/report.mjs baseline-13 improved   # bench/results/benchmark-report.md 생성
```

- 실행 중에는 Agent Desk에서 다른 요청을 보내지 마세요. 계정 전체의 5시간 사용률을 측정하기 때문입니다.
- 사용률 한도에 걸려 멈추면 한도가 회복된 뒤 같은 명령을 다시 실행하세요. 이미 기록된 과제는 건너뜁니다.
- 편차를 줄이려면 `--repeat 2` 이상으로 실행하세요. 같은 과제도 AI 실행마다 결과가 달라질 수 있습니다.
- 과제마다 `bench <라벨> <과제>` 이름의 프로젝트가 Agent Desk에 추가됩니다. 작업 폴더는 OS 임시 폴더의 `agent-desk-bench/`에 남아 있어 결과를 직접 확인할 수 있습니다.

## 기존 기록 분석

```powershell
node bench/analyze-history.mjs data\state.json --md bench\results\history.md
```

Agent Desk는 프로젝트마다 메인 AI 스레드를 이어 쓰는데, 스레드 누적 토큰을 요청별 사용량으로 저장해 왔습니다. 그래서 요청이 쌓일수록 대시보드 토큰 수가 부풀려집니다. 분석 스크립트는 같은 스레드의 직전 누적값을 빼서 요청별 증분으로 보정합니다. 결과 JSON에는 요청 원문을 저장하지 않습니다.
