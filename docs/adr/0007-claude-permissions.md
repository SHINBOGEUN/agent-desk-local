# ADR 0007 · Claude 세션의 권한: 도구 제한 + 승인 정책

- 상태: 채택 (2026-11-13, 사용자 선택: "기본 허용 목록 + 나머지 거부")
- 관련: ADR 0003(Claude는 stream-json, `--allowedTools`는 도구를 제한하지 못함), 로드맵 3-1·3-2

## 결정
- Claude에는 Codex 같은 샌드박스가 없으므로 두 겹으로 막습니다.
  1. `--tools`로 사용할 수 있는 내장 도구 자체를 제한: 읽기 전용 역할은 `Read,Glob,Grep`, builder는 여기에 `Edit,Write,Bash`. 웹·위임·스케줄 도구는 없음.
  2. `--permission-prompt-tool mcp__agentdesk__approve`로 권한 질문을 하네스가 받아 `decideApproval`(orchestrator/approval.ts)이 결정.
- 정책(사람에게 묻지 않으므로 `--unattended`에서도 같음):
  - 읽기: 프로젝트 안의 경로만.
  - 수정: builder만, 프로젝트 안, `.agent-desk/`·`.git` 보호 경로 제외.
  - Bash: 프로젝트 안에서 읽기·테스트·빌드류만(`npm|pnpm|yarn|bun`의 test/run/build/lint/typecheck/check/ci, `node <파일>`, 읽기 전용 git, `ls`·`cat`·`grep` 등, builder는 `mkdir`·`cp`·`mv`·`touch`). 삭제, 네트워크, 설치, 셸 실행, 명령 치환, 프로젝트 밖 경로, `node -e`는 거부하고 거부 사유를 모델에게 알려 줌.
  - 프로젝트가 더 허용하려면 `.agent-desk/config.json`의 `allowCommands`(명령 접두어 목록).
- 승인 결과는 `approval_request` 런타임 이벤트로 기록(허용/거부, 사유).

## 한계
- 명령 해석은 단순한 단어 분리라서 속임수(예: 허용된 `node <파일>`이 파일 안에서 무엇을 하든)는 막지 못합니다. 샌드박스를 대체하지 않으므로 Claude는 이 PC에서 본인 용도로만 쓰는 전제를 유지합니다.
- 실제 Claude Code에서 `--tools` 쉼표 목록, 권한 질문 호출 형식, Bash 종료 코드(현재 `is_error`로 0/1 추정)는 확인하지 못했고 사용자 PC 스모크 테스트로 확인해야 합니다.
