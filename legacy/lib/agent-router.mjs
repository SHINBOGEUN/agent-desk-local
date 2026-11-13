const changeIntent = /\b(implement|build|create|generate|write|fix|change|update|delete|refactor|add|start|stop|restart|run|deploy|optimize)\b|구현|만들|생성|작성|고치|수정|변경|바꾸|추가|삭제|개선|최적화|리팩터|조정|줄이|좁히|늘리|넓히|키우|작게|크게|정돈|배치|실행|시작|올리|띄우|켜|내리|중지|재시작|배포/i;
const inspectIntent = /\b(inspect|investigate|analy[sz]e|diagnos|trace|research|review|test|verify|check)\b|조사|분석|파악|진단|원인|찾아|탐색|재현|오류|에러|버그|문제|실패|안 ?보|안 ?되|검토|리뷰|테스트|검증|점검|확인/i;
const explicitResearch = /리서처|조사|탐색|구조.{0,8}파악|원인|진단|research|investigat|inspect|분석/i;
const roleMatchers = {
  researcher: /리서처|조사|research/i,
  backend: /백엔드|backend|api/i,
  frontend: /프론트엔드|frontend|프론트.*ui/i,
  design: /웹디자인|디자인|ux|사용성/i,
  server: /서버|인프라|devops|배포|server|infrastructure/i,
  database: /데이터베이스|\bdb\b|sql|마이그레이션|schema|database/i,
  qa: /\bqa\b|테스트|재현|quality/i,
  security: /보안|security|취약점|인증|인가/i,
  worker: /빌더|일반 구현|worker/i,
};

function findAgent(agents, role) {
  const exact = agents.find(agent => agent.enabled && agent.id === role);
  return exact || agents.find(agent => agent.enabled && roleMatchers[role]?.test(`${agent.name} ${agent.role}`));
}

/**
 * Stable, local request routing. This deliberately uses paired intent + domain
 * triggers so a question that merely mentions a role does not start a worker.
 */
export function routeRequest(message, agents = []) {
  const text = String(message || '').trim();
  const changes = changeIntent.test(text);
  const inspects = inspectIntent.test(text);
  const roles = [];
  const matches = [];
  const unavailable = [];
  const add = (role, reason) => {
    if (roles.includes(role)) return;
    const agent = findAgent(agents, role);
    if (!agent) { unavailable.push({ role, reason }); return; }
    roles.push(role);
    matches.push({ role, agentId: agent.id, agentName: agent.name, reason });
  };

  if (!changes && !inspects) return { mode: 'direct', requiredAgentIds: [], matches, unavailable };

  if (inspects && explicitResearch.test(text)) add('researcher', '요청에 기존 구조·원인 조사 트리거가 있습니다.');
  const requestedReview = /보안.{0,12}(검토|점검|리뷰)|취약점|security review/i.test(text);
  const securityChange = changes && /인증|인가|권한|비밀|개인정보|취약점|보안|security|auth/i.test(text);
  if (requestedReview || securityChange) add('security', requestedReview ? '보안 검토를 명시했습니다.' : '보안 경계가 포함된 변경입니다.');

  if (changes && /(?:api|백엔드|backend|서버 로직|인증 로직|외부 연동)/i.test(text)) add('backend', 'API 또는 서버 로직 변경 트리거가 있습니다.');
  const designIntent = changes && /(?:웹디자인|디자인 시스템|ux|사용 흐름|정보 구조|와이어프레임)/i.test(text);
  if (designIntent) add('design', 'UX·정보 구조 또는 디자인 변경 트리거가 있습니다.');
  if (changes && /(?:프론트엔드|프론트|화면|페이지|컴포넌트|버튼|입력창|폼|메뉴|모달|ui|스타일|레이아웃|반응형)/i.test(text)) add('frontend', '화면 또는 프론트엔드 변경 트리거가 있습니다.');
  if ((changes || inspects) && /(?:데이터베이스|\bdb\b|sql|스키마|테이블|쿼리|인덱스|마이그레이션|database)/i.test(text)) add('database', 'DB 구조·쿼리·마이그레이션 트리거가 있습니다.');
  if ((changes || inspects) && /(?:서버|서비스|인프라|배포|컨테이너|도커|ci\/cd|네트워크|포트|프로세스|localhost|server|devops)/i.test(text)) add('server', '서버·운영·인프라 트리거가 있습니다.');
  if (inspects && /(?:테스트|검증|재현|qa|품질)/i.test(text)) add('qa', '테스트·재현·검증이 요청의 핵심입니다.');

  if (!roles.length && changes && !unavailable.length) add('worker', '변경 요청이지만 전문 분야 트리거가 없어 빌더를 배정합니다.');
  return { mode: roles.length || unavailable.length ? 'routed' : 'direct', requiredAgentIds: matches.map(item => item.agentId), matches, unavailable };
}

export function routingPlanText(plan) {
  if (!plan || plan.mode === 'direct') return '결정적 배정 트리거: 일반 질문 또는 작업 의도가 없는 요청이므로 팀 위임 없이 직접 답하세요.';
  const matched = plan.matches.map(item => `- ${item.agentName} (${item.agentId}): ${item.reason}`).join('\n') || '- 일치하는 활성 담당자가 없습니다.';
  const missing = plan.unavailable.length ? `\n비활성·미등록 담당자:\n${plan.unavailable.map(item => `- ${item.role}: ${item.reason}`).join('\n')}\n없는 역할을 다른 담당자로 임의 대체하지 말고 사용자에게 알려 주세요.` : '';
  return `결정적 배정 트리거 (시스템이 정함; 메인이 변경 불가):\n${matched}${missing}\n필수 담당자는 agent_desk_run으로 모두 실행해야 합니다. 메인은 작업 지시·완료 조건·선후 관계만 구체화하고 필수 담당자를 생략하거나 임의 교체하지 마세요. 독립 작업은 함께 배정할 수 있고, 선행 결과가 필요한 경우 순서대로 배정하세요. 쓰기 작업이 있으면 마지막 변경 뒤 체커 검증은 별도 품질 게이트로 실행하세요.`;
}
