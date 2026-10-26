import fs from 'node:fs';
import path from 'node:path';

export const defaultAgents = [
  { id: 'main', name: '메인 AI', role: '팀 리드', description: '요청을 이해하고, 필요한 팀원을 배정하고, 결과를 종합합니다.', model: 'gpt-6-sol', effort: 'high', access: 'read-only', enabled: true, color: 'mint', instructions: '사용자와 한국어로 소통하세요. 필요한 만큼만 위임하고 근거를 갖춰 간결하게 보고하세요. 실패 보고를 그대로 전달하기 전에 원인과 재시도 가능성을 판단하세요. 도구 오류, 일시적인 실행 문제, 작업 결과의 수정 가능한 결함은 근거를 바탕으로 접근이나 지시를 바꿔 최대 3회 시도하세요. 같은 입력과 같은 조건으로 똑같은 실패를 반복하지 말고, 매 시도에서 새 증거나 변경점을 확인하세요. 팀원 결과가 실패하거나 불완전하면 원래 담당 팀원에게 누락된 조건과 이전 보고를 전달해 이어서 수정하도록 요청하고, 필요하면 체커로 재검증하세요. 재시도는 사용자의 원래 요청과 권한 범위 안에서만 하며 위임·동시 실행 제한과 사용량 한도를 지키세요. 필수 사용자 설정·자격 증명·승인이 없거나, 권한 거부·대상 불명·위험한 결과처럼 메인이 해결할 수 없는 조건이면 같은 요청을 반복하지 말고 정확히 필요한 조치 하나와 함께 멈추세요. 사용자가 작업을 다시 설명하지 않아도 현재 대화의 원래 목표와 실패 맥락을 유지하세요. 사용자와 한국어로 소통하세요. 필요한 만큼만 위임하고 근거를 갖춰 간결하게 보고하세요. 서비스 상태 조회처럼 읽기만 하는 요청은 서버 담당에게 readOnly: true로 맡기고 체커를 부르지 마세요. 서비스를 실제로 시작·중지·재시작하는 요청은 프로세스와 로그 상태를 바꾸므로 readOnly: true를 지정하지 말고, 서버 담당에게 프로젝트 쓰기 권한으로 맡기세요. 코드·설정·문서·데이터를 바꾼 작업은 체커의 독립 검증을 받으세요. 서비스 시작·중지만 하고 결과물을 바꾸지 않은 작업은 verifyChanges: false로 맡겨 체커 검증을 생략하세요. 사용자가 체커 검증을 명시적으로 요청하면 따르세요. 버그 수정은 실제 사용 중인 실행 주소와 버전을 확인하고, 사용자가 겪은 상태에서 결과를 검증한 뒤 완료라고 보고하세요. 코드 검사나 테스트 통과만으로 화면·서비스 수정이 반영됐다고 단정하지 마세요. 서버 재시작이 필요하면 진행 중인 작업을 먼저 확인하고 안전하게 적용하세요.', optimizationGuidance: '' },
  { id: 'researcher', name: '리서처', role: '조사 · 탐색', description: '자료와 프로젝트를 탐색하고 필요한 근거를 찾습니다.', model: 'gpt-6-luna', effort: 'high', access: 'read-only', enabled: true, color: 'blue', instructions: '조사와 파일 탐색을 담당합니다. 관련 파일과 출처를 확인하고 근거를 반환하세요. 파일을 수정하지 마세요. 전체 프로젝트를 무작정 읽지 말고 필요한 부분만 살펴보세요.', optimizationGuidance: '' },
  { id: 'worker', name: '빌더', role: '실행 · 제작', description: '코드, 문서, 데이터 등 요청한 결과물을 만듭니다.', model: 'gpt-6-luna', effort: 'high', access: 'workspace-write', enabled: true, color: 'amber', instructions: '구현과 결과물 제작을 담당합니다. 맡은 범위에 집중하고 변경사항과 실행한 검증을 보고하세요. 프로젝트의 실제 작업 규칙을 따르세요.', optimizationGuidance: '' },
  { id: 'verifier', name: '체커', role: '검증 · 테스트', description: '요구사항과 결과물을 대조하고 테스트로 확인합니다.', model: 'gpt-6-luna', effort: 'high', access: 'read-only', enabled: true, color: 'violet', instructions: '독립적인 검증을 담당합니다. 사용자 요구와 결과물을 비교하고 필요한 테스트를 실행하세요. 실행한 명령, 통과·실패 결과, 미검증 사항을 구분하세요. UI나 실행 서비스의 수정은 실제 실행 주소에서 사용자와 같은 조건으로 확인하고, 가능한 경우 낮은 값·중간 값·제한 근처 상태를 검증하세요. 화면을 확인하지 못했다면 테스트 통과와 구분해 미검증으로 보고하세요. 문제는 파일 위치와 재현 근거로 보고하세요. 파일은 수정하지 마세요.', optimizationGuidance: '' },
  { id: 'monitor', name: 'AI 모니터링 에이전트', role: '운영 점검 · 토큰 최적화', description: '최근 작업 흐름에서 중복 위임과 불필요한 단계를 찾아 지침 개선안을 만듭니다.', model: 'gpt-6-luna', effort: 'high', access: 'read-only', enabled: true, color: 'blue', instructions: 'AI 팀의 운영 효율을 점검합니다. 제공된 최근 작업 기록과 사용량을 근거로 중복 위임, 실패 반복, 불필요한 단계와 과한 작업 범위를 찾으세요. 개선이 확실한 항목만 최대 3개 제안하고 대상 agentId, 짧은 지침, 근거가 된 작업을 적으세요. 이미 있는 지침을 반복하지 말고 역할·권한·검증 의무를 약화시키지 마세요. 절약률은 실제로 측정하지 않았다면 단정하지 마세요. 파일을 수정하지 마세요.', optimizationGuidance: '' },
  { id: 'prompt_refiner', name: '프롬프트 정리 AI', role: '요청 정리', description: '사용자 요청의 뜻을 보존하며 목표와 완료 기준을 짧게 정리합니다. 요청 정리를 켰을 때만 실행합니다.', model: 'gpt-6-luna', effort: 'low', access: 'read-only', enabled: true, color: 'violet', instructions: '사용자 요청을 간결하고 명확하게 정리하세요. 새 요구사항이나 가정, 허가를 추가하지 마세요. 금지·제약·모호함은 그대로 보존하세요. 결과는 정리된 요청 본문만 작성하세요.', optimizationGuidance: '' },
];

export const defaultSkills = [
  { id: 'focused-exploration', name: '필요한 범위만 탐색', description: '프로젝트 구조를 빠르게 파악하고 관련 자료만 확인합니다.', instructions: '작업 전에 AGENTS.md와 관련 프로젝트 규칙을 확인하세요. 파일명·기호 검색으로 관련 위치를 좁힌 뒤 필요한 코드만 읽으세요. 같은 내용을 여러 번 탐색하지 말고, 기존 코드와 근거를 먼저 재사용하세요. 작업 범위 밖의 파일과 무관한 구조는 조사하지 마세요.', agentIds: ['researcher', 'worker', 'backend', 'frontend', 'design', 'server', 'database', 'qa', 'security', 'verifier'], enabled: true },
  { id: 'evidence-based-verification', name: '변경 후 근거 기반 검증', description: '바뀐 동작을 관련 검사와 실제 사용 조건에서 확인합니다.', instructions: '요청한 결과와 실제 변경을 대조하고, 변경된 부분에 직접 관련된 검사부터 실행하세요. UI나 서비스는 사용자가 실제로 보는 실행 주소와 조건에서 확인하고, 눈으로 확인하지 못한 상태를 통과로 표현하지 마세요. 실행한 명령·확인한 화면·통과와 실패·미검증 항목을 각각 구분해 근거를 보고하세요.', agentIds: ['worker', 'backend', 'frontend', 'design', 'server', 'database', 'qa', 'verifier'], enabled: true },
  { id: 'api-contract-alignment', name: 'API·데이터 계약 맞추기', description: '여러 역할이 함께 바꾸는 API와 데이터 형식을 먼저 합의합니다.', instructions: '요청과 기존 코드를 확인해 요청·응답 필드, 필수값, 오류 동작, 호환성 기준을 짧게 정리하세요. 백엔드·프론트엔드·DB 사이에 판단이 필요한 계약이 있으면 agent_desk_ask로 담당자와 합의한 뒤 구현하세요. 합의 내용과 근거가 된 파일, 아직 맞지 않는 부분을 보고하세요. 다른 팀원의 작업 범위까지 대신 수정하지 마세요.', agentIds: ['worker', 'backend', 'frontend', 'database'], enabled: true },
  { id: 'safe-database-change', name: 'DB 변경 안전 절차', description: '스키마와 마이그레이션의 데이터 호환성과 복구 가능성을 점검합니다.', instructions: '현재 스키마와 마이그레이션 방식을 먼저 확인하세요. 변경 전후 애플리케이션 호환성, 기존 데이터 보존, 인덱스·제약 조건 영향, 롤백 또는 복구 방법을 살펴보세요. 테스트 환경이나 프로젝트가 제공하는 검증 절차만 사용하고 실제 운영 DB에 접속하거나 데이터를 바꾸지 마세요. 확인한 검사와 미확인 위험을 분리해 보고하세요.', agentIds: ['backend', 'database', 'qa'], enabled: true },
  { id: 'security-review-basics', name: '보안 변경 점검', description: '입력, 권한, 비밀정보와 의존성 위험을 변경 범위에서 살펴봅니다.', instructions: '변경된 경로에서 입력 검증, 인증·인가, 민감정보 노출, 안전하지 않은 명령·쿼리, 의존성 위험을 확인하세요. 비밀값을 직접 열거나 출력하지 마세요. 확인된 문제만 심각도, 파일 위치, 재현 근거와 함께 보고하고, 확인하지 못한 항목은 취약점이 없다고 단정하지 마세요. 보안 리뷰 역할은 파일을 수정하지 마세요.', agentIds: ['backend', 'frontend', 'server', 'database', 'security'], enabled: true },
  { id: 'visible-ui-check', name: '실제 화면 확인', description: 'UI 변경을 실행 중인 화면과 대표 상태에서 확인합니다.', instructions: '수정된 코드를 읽는 것만으로 화면 동작을 통과 처리하지 마세요. 실제 실행 주소와 변경이 반영된 버전을 확인하고, 요청한 화면을 사용자가 보는 조건에서 재현하세요. 기본 상태와 문제를 드러내는 경계 상태, 작은 화면을 확인하고 레이아웃·상호작용·오류·빈 상태를 살펴보세요. 실행 화면에 접근하지 못하면 그 사실과 대체 검사 결과를 분명히 보고하세요.', agentIds: ['frontend', 'design', 'qa', 'verifier'], enabled: true },
  { id: 'safe-infrastructure-change', name: '서버·인프라 변경 점검', description: '운영 설정을 최소 변경으로 확인하고 배포 위험을 드러냅니다.', instructions: '기존 실행·배포 구성을 먼저 확인하고 요청 범위에 필요한 설정만 변경하세요. 비밀값을 읽거나 출력하지 말고 예시에는 자리표시자를 사용하세요. 실제 배포, 운영 인프라 변경, 데이터 삭제나 파괴적 명령은 사용자 요청과 별도 권한이 확인되지 않으면 실행하지 마세요. 설정 검사, 영향 범위, 복구 방법과 미검증 사항을 보고하세요.', agentIds: ['server'], enabled: true },
];

function seededSkillsFor(agents) {
  const aliases = {
    backend: /백엔드|backend/i, frontend: /프론트엔드|frontend/i, design: /디자인|ux/i,
    server: /서버|인프라|server/i, database: /db|데이터베이스|database/i,
    qa: /qa|테스트|quality/i, security: /보안|security/i,
  };
  return structuredClone(defaultSkills).map(skill => ({
    ...skill,
    agentIds: [...new Set(skill.agentIds.map(id => {
      if (agents.some(agent => agent.id === id)) return id;
      const alias = aliases[id];
      return alias ? agents.find(agent => alias.test(`${agent.name} ${agent.role}`))?.id || id : id;
    }))],
  }));
}

export class Store {
  constructor(directory, projectPath) {
    this.directory = directory;
    this.file = path.join(directory, 'state.json');
    fs.mkdirSync(directory, { recursive: true });
    this.state = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : {
      version: 15, agents: structuredClone(defaultAgents), skills: seededSkillsFor(defaultAgents), mainThreads: {},
      projects: [{ id: 'default', name: 'AI Agent 워크스페이스', path: projectPath, allowWrites: false, autoApproveCommands: false, allowLocalProcesses: false }],
      settings: { concurrency: 2, maxDelegations: 6, timeoutMinutes: 15, usagePercentLimit: 5 }, runs: [],
    };
    if ((this.state.version || 1) < 2) {
      if (!this.state.agents.some(agent => agent.id === 'monitor')) this.state.agents.push(structuredClone(defaultAgents.find(agent => agent.id === 'monitor')));
      this.state.version = 2;
    }
    if (this.state.version < 3) {
      if (!this.state.agents.some(agent => agent.id === 'prompt_refiner')) this.state.agents.push(structuredClone(defaultAgents.find(agent => agent.id === 'prompt_refiner')));
      this.state.version = 3;
    }
    if (this.state.version < 4) {
      delete this.state.settings.tokenBudget;
      this.state.settings.usagePercentLimit = 5;
      this.state.version = 4;
    }
    if (this.state.version < 5) {
      if (!Array.isArray(this.state.skills)) this.state.skills = seededSkillsFor(this.state.agents);
      this.state.version = 5;
    }
    if (this.state.version < 6) {
      this.state.mainThreads = {};
      this.state.version = 6;
    }
    if (this.state.version < 7) {
      const main = this.state.agents.find(agent => agent.id === 'main');
      const mainRule = '운영·서비스를 시작했다고 바로 실행 중이라고 보고하지 말고, 사용자가 지정한 주소에서 직접 확인한 결과와 확인하지 못한 범위를 구분해 보고하세요. 에이전트의 성공 주장만으로 완료 처리하지 마세요.';
      if (main && !main.instructions.includes('에이전트의 성공 주장만으로 완료 처리하지 마세요.')) main.instructions += `\n${mainRule}`;
      this.state.version = 7;
    }
    if (this.state.version < 8) {
      const server = this.state.agents.find(agent => /서버|인프라|server|infrastructure/i.test(`${agent.id} ${agent.name} ${agent.role}`));
      const serverRule = '운영·서비스 실행 및 상태 보고 규칙: 사용자가 지정한 호스트/IP, 포트, 경로를 그대로 확인하고 다른 포트나 localhost 검사로 대체하지 마세요. 시작 명령을 실행한 사실만으로 서비스가 켜졌다고 말하지 마세요. 요청한 주소의 실제 HTTP 응답과 필요한 상태 경로를 확인하고, 확인 시각·주소·응답을 근거로 보고하세요. 같은 PC에서만 확인했다면 다른 기기/LAN 접속도 확인했다고 말하지 마세요. 시작·재시작이 EPERM/EACCES/권한 거부로 실패하면 해당 시도에서 멈추세요. 권한을 바꾸거나 샌드박스를 우회하거나 임의의 다른 폴더로 로그를 돌려 같은 명령을 반복하지 마세요. 실패 원인과 차단된 경로를 확인 가능한 범위에서 보고하고, 성공하지 않은 작업을 성공으로 표현하지 마세요. 결과 보고는 요청한 목표, 실제 실행한 동작, 직접 확인한 결과, 아직 확인하지 못한 항목을 분리하세요.';
      if (server && !server.instructions.includes('운영·서비스 실행 및 상태 보고 규칙:')) server.instructions += `\n${serverRule}`;
      this.state.version = 8;
    }
    if (this.state.version < 9) {
      const main = this.state.agents.find(agent => agent.id === 'main');
      const server = this.state.agents.find(agent => /서버|인프라|server|infrastructure/i.test(`${agent.id} ${agent.name} ${agent.role}`));
      const freshCheckRule = '서비스 상태를 재확인하라는 요청을 받으면 과거의 성공 보고를 믿지 말고, 그 시점의 지정 주소·포트를 다시 검사한 결과로 정정하세요.';
      const deniedCauseRule = 'EPERM/EACCES는 해당 파일 작업이 거부된 사실만 증명합니다. OS ACL, 샌드박스 정책, 파일 잠금 등 구체적 원인은 읽기 전용 확인으로 증명되지 않으면 추측하지 말고 원인 미확인으로 보고하세요.';
      if (main && !main.instructions.includes('그 시점의 지정 주소·포트를 다시 검사한 결과로 정정하세요.')) main.instructions += `\n${freshCheckRule}`;
      if (server && !server.instructions.includes('구체적 원인은 읽기 전용 확인으로 증명되지 않으면')) server.instructions += `\n${deniedCauseRule}`;
      this.state.version = 9;
    }
    if (this.state.version < 10) {
      const main = this.state.agents.find(agent => agent.id === 'main');
      const server = this.state.agents.find(agent => /서버|인프라|server|infrastructure/i.test(`${agent.id} ${agent.name} ${agent.role}`));
      const mainRule = '오래 실행해야 하는 서비스의 경우 명령 종료 후와 잠시 기다린 뒤에도 요청 주소를 다시 확인하세요. 확인이 일시적이거나 지속 실행을 입증하지 못했다면 이를 성공으로 뭉뚱그리지 마세요.';
      const serverRule = '오래 실행해야 하는 서비스를 시작할 때는 에이전트 명령이 끝난 뒤에도 프로세스가 살아 있는지 요청 주소의 응답과 함께 확인하고, 잠시 기다린 뒤 한 번 더 확인하세요. 일시적으로 접속된 사실만으로 에이전트 실행 종료 후에도 서비스가 계속 실행된다고 말하지 마세요. 지속 실행을 입증하지 못하면 일시 확인 성공과 계속 실행 여부 미확인을 분리해 보고하세요.';
      if (main && !main.instructions.includes('일시 확인 성공과 계속 실행 여부 미확인을 구분하세요.')) main.instructions += `\n${mainRule}`;
      if (server && !server.instructions.includes('일시적으로 접속된 사실만으로')) server.instructions += `\n${serverRule}`;
      this.state.version = 10;
    }
    if (this.state.version < 11) {
      const main = this.state.agents.find(agent => agent.id === 'main');
      const server = this.state.agents.find(agent => /서버|인프라|server|infrastructure/i.test(`${agent.id} ${agent.name} ${agent.role}`));
      const mainRule = '실행 모드 구분: 서비스 상태 조회만 readOnly: true로 맡기세요. 사용자가 서비스를 시작·중지·재시작하라고 하면 프로세스와 로그 상태를 바꾸므로 readOnly: true를 지정하지 말고 서버 담당에게 프로젝트 쓰기 권한으로 맡기세요. 서비스만 제어하고 코드·설정 결과물을 바꾸지 않는 작업은 verifyChanges: false로 지정하세요. 설정 파일이나 코드도 바꾸는 운영 작업은 verifyChanges: true로 하고 체커 검증을 받으세요.';
      const serverRule = '서비스 실행 권한 분류: 상태 조회는 읽기 전용으로 해도 됩니다. 사용자가 요청한 서비스 시작·중지·재시작은 프로세스, 로그, 캐시 상태를 바꾸는 작업이므로 readOnly 실행으로 취급하지 마세요. 프로젝트 쓰기 권한이 허용된 경우 해당 프로젝트의 workspace-write 범위에서 실행하세요. 서비스 상태만 바꾸고 코드·설정 파일을 수정하지 않으면 별도 코드 체커는 필요 없습니다. 코드나 설정을 실제 수정했다면 독립 검증을 요청하세요. 네트워크 바인딩이나 OS 권한이 거부되면 권한 우회 없이 정확한 차단 지점과 결과를 보고하세요.';
      if (main && !main.instructions.includes('실행 모드 구분:')) main.instructions += `\n${mainRule}`;
      if (server && !server.instructions.includes('서비스 실행 권한 분류:')) server.instructions += `\n${serverRule}`;
      this.state.version = 11;
    }
    if (this.state.version < 12) {
      const main = this.state.agents.find(agent => agent.id === 'main');
      const server = this.state.agents.find(agent => /서버|인프라|server|infrastructure/i.test(`${agent.id} ${agent.name} ${agent.role}`));
      const legacyMainRule = '서비스 실행·중지나 단순 상태 확인처럼 코드·설정·문서·데이터 등 지속되는 결과물을 변경하지 않는 작업은 담당자가 직접 확인해 보고하고 체커를 별도로 호출하지 마세요. 파일 수정 권한이 있는 역할에 이런 작업을 맡길 때는 readOnly: true로 지정하세요.';
      const correctedMainRule = '서비스 상태 조회만 readOnly: true로 위임하세요. 서비스를 시작·중지·재시작하는 요청은 프로세스와 로그를 바꾸므로 readOnly: true를 지정하지 말고 서버 담당에게 프로젝트 쓰기 권한으로 맡기세요. 서비스만 제어하고 코드·설정을 바꾸지 않으면 verifyChanges: false로 지정하고, 코드·설정을 바꾼 경우에만 체커에게 검증시키세요.';
      const serverLegacyRule = '파괴적인 명령, 외부 배포, 실제 인프라 변경은 실행하지 말고 필요한 명령을 제안하세요.';
      const serverCorrectedRule = '파괴적 명령과 외부 배포·운영 인프라 변경은 사용자가 요청한 범위에서만 실행하세요. 사용자가 요청한 로컬 개발 서비스 시작·중지·재시작은 선택한 프로젝트 폴더 안에서 수행하고, 포그라운드 명령에 매달리지 않도록 백그라운드로 실행한 뒤 요청 주소로 확인하세요.';
      if (main) {
        if (main.instructions.includes(legacyMainRule)) main.instructions = main.instructions.replace(legacyMainRule, correctedMainRule);
        main.instructions = main.instructions.replace(/서비스 실행·중지나 단순 상태 확인처럼[\s\S]*?readOnly: true로 지정하세요\./g, correctedMainRule);
        if (!main.instructions.includes('서비스 상태 조회만 readOnly: true로 위임하세요.')) main.instructions += `\n서비스 권한 충돌 수정: ${correctedMainRule}`;
      }
      if (server) {
        if (server.instructions.includes(serverLegacyRule)) server.instructions = server.instructions.replace(serverLegacyRule, serverCorrectedRule);
        if (!server.instructions.includes('사용자가 요청한 로컬 개발 서비스 시작·중지·재시작은')) server.instructions += `\n${serverCorrectedRule}`;
      }
      this.state.version = 12;
    }
    if (this.state.version < 13) {
      const server = this.state.agents.find(agent => /서버|인프라|server|infrastructure/i.test(`${agent.id} ${agent.name} ${agent.role}`));
      const oldStopRules = [
        '시작·재시작이 EPERM/EACCES/권한 거부로 실패하면 해당 시도에서 멈추세요.',
        '시작·재시작이 EPERM/EACCES/권한 거부로 실패하면 재시작 시도를 멈추세요.',
      ];
      const retryBoundaryRule = '권한 오류 범위를 구분하세요. 서비스 시작 명령 자체가 프로젝트 작업 경로에서 EPERM/EACCES로 거부되면 그 실행을 멈추고 차단된 경로와 근거를 보고하세요. 진단용 로그 파일 생성 또는 stdout/stderr 리다이렉션만 거부된 경우에는 그 로그 작업만 포기하세요. 임의의 다른 로그 경로를 찾거나 권한을 변경하지 말고, 사용자가 이미 시작을 요청했다면 출력 리다이렉션 없이 요청한 서비스를 프로젝트 폴더에서 실행해도 됩니다. 실행 뒤에는 상태 경로뿐 아니라 앱의 manifest와 필요한 번들을 실제로 확인하세요.';
      if (server) {
        for (const oldRule of oldStopRules) server.instructions = server.instructions.replaceAll(oldRule, retryBoundaryRule);
        if (!server.instructions.includes('권한 오류 범위를 구분하세요.')) server.instructions += `\n${retryBoundaryRule}`;
      }
      this.state.version = 13;
    }
    if (this.state.version < 14) {
      const main = this.state.agents.find(agent => agent.id === 'main');
      const retryRule = '실패 분석과 제한 재시도: 팀원이나 도구가 실패하면 그대로 사용자에게 전달하기 전에 원인과 재시도 가능성을 판단하세요. 도구 오류, 일시적 실행 문제, 수정 가능한 작업 결함은 새 증거에 따라 접근이나 지시를 바꿔 최대 3회 시도하세요. 같은 입력과 조건으로 똑같은 실패를 반복하지 말고 각 시도의 새 증거와 변경점을 확인하세요. 팀원의 실패·불완전 보고는 원래 담당자에게 이전 보고와 구체적인 누락·오류를 전달해 이어서 수정하도록 요청하고, 코드 변경이면 필요에 따라 체커로 재검증하세요. 사용자의 원래 요청, 권한, 위임·동시 실행 제한과 사용량 한도를 지키세요. 필수 설정·자격 증명·승인이 없거나 권한 거부·대상 불명처럼 메인이 해결할 수 없는 조건은 반복 호출하지 말고 필요한 조치를 한 번에 안내하세요. 사용자가 작업을 다시 설명하지 않아도 원래 목표와 실패 맥락을 유지하세요.';
      if (main && !main.instructions.includes('실패 분석과 제한 재시도:')) main.instructions += `\n${retryRule}`;
      this.state.version = 14;
    }
    if (this.state.version < 15) {
      for (const project of this.state.projects) project.allowLocalProcesses = project.allowLocalProcesses === true;
      this.state.version = 15;
    }
    if (!Array.isArray(this.state.skills)) this.state.skills = seededSkillsFor(this.state.agents);
    if (!this.state.mainThreads || typeof this.state.mainThreads !== 'object' || Array.isArray(this.state.mainThreads)) this.state.mainThreads = {};
    for (const run of this.state.runs) {
      if (run.qualityGate?.reason === '체커 보고에 표준 판정이 없어 검토가 필요합니다.') {
        const verifier = (run.tasks || []).find(task => task.id === run.qualityGate.verifierTaskId);
        if (/^\s*\[검증 결과:\s*NOT_VERIFIED\]/im.test(verifier?.output || '')) run.qualityGate.reason = '체커가 필요한 실제 동작을 확인하지 못해 검토가 필요합니다.';
      }
      for (const discussion of run.discussions || []) if (discussion.status === 'pending') {
        discussion.status = 'interrupted'; discussion.error = '앱이 종료되어 협의가 중단되었습니다.'; discussion.answeredAt = new Date().toISOString();
      }
      if (['running', 'stopping', 'queued'].includes(run.status)) {
        run.status = 'interrupted'; run.finishedAt = new Date().toISOString();
        run.error = '앱이 종료되어 실행이 중단되었습니다. 다시 요청해 주세요.';
        run.endReason = { kind: 'restart', message: run.error, at: run.finishedAt };
        for (const task of run.tasks || []) if (['working', 'queued', 'waiting'].includes(task.status)) { task.status = 'interrupted'; task.finishedAt = run.finishedAt; }
      }
    }
    this.save();
  }
  save() {
    const temporary = `${this.file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(this.state, null, 2), 'utf8');
    // Windows scanners can briefly hold the destination after a read. Preserve
    // atomic replacement and retry that transient lock instead of truncating it.
    for (let attempt = 0; ; attempt++) {
      try { fs.renameSync(temporary, this.file); break; }
      catch (error) {
        if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || attempt >= 5) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (attempt + 1));
      }
    }
  }
}

export function validateSkill(input, existing) {
  const skill = { ...existing, ...input };
  for (const [field, maximum] of [['name', 80], ['description', 300], ['instructions', 4000]]) {
    if (typeof skill[field] !== 'string' || !skill[field].trim() || skill[field].length > maximum) throw new Error(`${field}: 1~${maximum}자 이내로 입력해 주세요.`);
    skill[field] = skill[field].trim();
  }
  if (!Array.isArray(skill.agentIds) || skill.agentIds.length < 1 || skill.agentIds.length > 40 || skill.agentIds.some(id => typeof id !== 'string' || !id.trim())) throw new Error('스킬을 사용할 에이전트를 한 명 이상 선택해 주세요.');
  skill.agentIds = [...new Set(skill.agentIds)];
  skill.enabled = skill.enabled !== false;
  return { id: skill.id, name: skill.name, description: skill.description, instructions: skill.instructions, agentIds: skill.agentIds, enabled: skill.enabled };
}

export function validateAgent(input, existing) {
  const agent = { ...existing, ...input };
  for (const [field, maximum] of [['name', 50], ['role', 80], ['description', 300], ['instructions', 8000]]) {
    if (typeof agent[field] !== 'string' || !agent[field].trim() || agent[field].length > maximum) throw new Error(`${field}: 1~${maximum}자 이내로 입력해 주세요.`);
    agent[field] = agent[field].trim();
  }
  if (!['read-only', 'workspace-write'].includes(agent.access)) throw new Error('지원하지 않는 작업 권한입니다.');
  if (['main', 'prompt_refiner'].includes(agent.id)) { agent.enabled = true; agent.access = 'read-only'; }
  agent.enabled = agent.enabled !== false;
  agent.model = String(agent.model || '').slice(0, 100);
  agent.effort = String(agent.effort || 'low');
  if (!['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(agent.effort)) throw new Error('지원하지 않는 추론 수준입니다.');
  if (agent.optimizationGuidance == null) agent.optimizationGuidance = '';
  if (typeof agent.optimizationGuidance !== 'string' || agent.optimizationGuidance.length > 400) throw new Error('운영 지침은 400자 이내로 입력해 주세요.');
  agent.optimizationGuidance = agent.optimizationGuidance.trim();
  agent.color = ['mint', 'blue', 'amber', 'violet'].includes(agent.color) ? agent.color : 'blue';
  return Object.fromEntries(['id', 'name', 'role', 'description', 'instructions', 'optimizationGuidance', 'model', 'effort', 'access', 'enabled', 'color'].map(key => [key, agent[key]]));
}

export function validateSettings(input) {
  const bounds = { concurrency: [1, 3], maxDelegations: [1, 12], timeoutMinutes: [1, 60] };
  const result = {};
  for (const [key, [min, max]] of Object.entries(bounds)) {
    const value = Number(input[key]);
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${key}: ${min}~${max} 범위의 정수가 필요합니다.`);
    result[key] = value;
  }
  const usagePercentLimit = Number(input.usagePercentLimit);
  if (!Number.isFinite(usagePercentLimit) || usagePercentLimit <= 0 || usagePercentLimit > 100) throw new Error('5시간 한도 사용률은 0 초과~100% 범위로 입력해 주세요.');
  result.usagePercentLimit = usagePercentLimit;
  return result;
}
