# 3D 에이전트 사무실 (보관)

2026-11-22에 대시보드에서 내렸다(다른 사람에게 보여주기에 캐릭터가 적당하지 않음). 나중에 다른 캐릭터로 다시 만들 때 쓰려고 그대로 보관한다. 이 폴더는 빌드·타입 검사·테스트에 들어가지 않는다.

| 파일 | 내용 |
|---|---|
| `office3d.ts` | Three.js 사무실: 로봇(모델 애니메이션 + 2관절 IK), 책상·벽 화면, 하네스 게이트·램프, 서류 전달, 소품, 그림자·빛 번짐 |
| `office-life.ts` | 순수 로직: 사무실 자리, 가구를 피하는 경로, 로봇별 시드 난수, 다음 할 일(`nextPlan`) |
| `agent-scene-3d.tsx` | React 컴포넌트 `AgentScene`: 실행 타임라인 → 3D 상태, 이름표·말풍선 오버레이, 드래그 회전 |
| `scene3d.css` | 위 컴포넌트 스타일 |
| `test/office-life.test.ts` | `office-life.ts` 테스트 4개 |
| `models/RobotExpressive.glb` | CC0 로봇 모델 (출처는 `models/README.md`) |

## 다시 켜는 법
1. `office3d.ts`, `office-life.ts`를 `web/src/`로, 테스트를 `web/test/`로 옮기고 import 경로(`../../src/` → `./`)를 되돌린다.
2. `agent-scene-3d.tsx`의 `AgentScene`을 `web/src/agent-scene.tsx`로 합치고, `scene3d.css`를 `web/src/styles.css` 끝에 붙인다.
3. 모델을 `web/public/models/`로 옮긴다.
4. `App.tsx`의 실행 화면 보기 선택에 `'scene'`을 다시 넣는다(`view === 'scene' ? <AgentScene … />`).
5. `three`, `@types/three`는 `web/package.json`에 그대로 남아 있다.

다른 캐릭터로 바꿀 때는 `office3d.ts`의 `buildRobot`(모델·색·소품)과 `posture`(자세)만 바꾸면 되고, 상태 판단(`scene.ts`의 `sceneOf`, `stationOf`)과 `office-life.ts`는 그대로 쓸 수 있다.
