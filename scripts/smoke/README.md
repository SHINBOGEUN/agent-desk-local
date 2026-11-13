# 실제 런타임 스모크 테스트 (사용자 PC에서 실행)

단위 테스트는 가짜 CLI로 돌기 때문에, 실제 Codex·Claude Code가 가정한 형식으로 응답하는지는 이 스크립트로만 확인됩니다. 요청 몇 개(아주 작은 사용량)를 보냅니다. **벤치마크를 측정하는 동안에는 실행하지 마세요.**

```
node scripts/smoke/runtime.ts codex
node scripts/smoke/runtime.ts claude
```

확인하는 것: 실행 파일 `doctor`, 읽기 전용 세션의 메시지·토큰·MCP 보고 도구, 같은 세션의 두 번째 턴, 읽기 전용에서 파일이 바뀌지 않음, 쓰기 세션의 파일 변경·명령 이벤트와 승인 요청, 중단.

결과는 `scripts/smoke/results/<runtime>.json`(이벤트 기록 포함)에 저장됩니다. FAIL이 있으면 그 파일을 Claude에게 보여 주세요. 이벤트 필드 이름이 달라서 생기는 문제를 어댑터에서 고칩니다.
