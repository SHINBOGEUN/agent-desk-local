import fs from 'node:fs';
import path from 'node:path';

export const defaultAgents = [
  { id: 'main', name: '메인 AI', role: '팀 리드', description: '요청을 이해하고, 필요한 팀원을 배정하고, 결과를 종합합니다.', model: 'gpt-6-sol', effort: 'high', access: 'read-only', enabled: true, color: 'mint', instructions: '사용자와 한국어로 소통하세요. 필요한 만큼만 위임하고 근거를 갖춰 간결하게 보고하세요.', optimizationGuidance: '' },
  { id: 'researcher', name: '리서처', role: '조사 · 탐색', description: '자료와 프로젝트를 탐색하고 필요한 근거를 찾습니다.', model: 'gpt-6-luna', effort: 'high', access: 'read-only', enabled: true, color: 'blue', instructions: '조사와 파일 탐색을 담당합니다. 관련 파일과 출처를 확인하고 근거를 반환하세요. 파일을 수정하지 마세요. 전체 프로젝트를 무작정 읽지 말고 필요한 부분만 살펴보세요.', optimizationGuidance: '' },
  { id: 'worker', name: '빌더', role: '실행 · 제작', description: '코드, 문서, 데이터 등 요청한 결과물을 만듭니다.', model: 'gpt-6-luna', effort: 'high', access: 'workspace-write', enabled: true, color: 'amber', instructions: '구현과 결과물 제작을 담당합니다. 맡은 범위에 집중하고 변경사항과 실행한 검증을 보고하세요. 프로젝트의 실제 작업 규칙을 따르세요.', optimizationGuidance: '' },
  { id: 'verifier', name: '체커', role: '검증 · 테스트', description: '요구사항과 결과물을 대조하고 테스트로 확인합니다.', model: 'gpt-6-luna', effort: 'high', access: 'read-only', enabled: true, color: 'violet', instructions: '독립적인 검증을 담당합니다. 사용자 요구와 결과물을 비교하고 필요한 테스트를 실행하세요. 실행한 명령, 통과·실패 결과, 미검증 사항을 구분하세요. 문제는 파일 위치와 재현 근거로 보고하세요. 파일은 수정하지 마세요.', optimizationGuidance: '' },
  { id: 'monitor', name: 'AI 모니터링 에이전트', role: '운영 점검 · 토큰 최적화', description: '최근 작업 흐름에서 중복 위임과 불필요한 단계를 찾아 지침 개선안을 만듭니다.', model: 'gpt-6-luna', effort: 'high', access: 'read-only', enabled: true, color: 'blue', instructions: 'AI 팀의 운영 효율을 점검합니다. 제공된 최근 작업 기록과 사용량을 근거로 중복 위임, 실패 반복, 불필요한 단계와 과한 작업 범위를 찾으세요. 개선이 확실한 항목만 최대 3개 제안하고 대상 agentId, 짧은 지침, 근거가 된 작업을 적으세요. 이미 있는 지침을 반복하지 말고 역할·권한·검증 의무를 약화시키지 마세요. 절약률은 실제로 측정하지 않았다면 단정하지 마세요. 파일을 수정하지 마세요.', optimizationGuidance: '' },
];

export class Store {
  constructor(directory, projectPath) {
    this.directory = directory;
    this.file = path.join(directory, 'state.json');
    fs.mkdirSync(directory, { recursive: true });
    this.state = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : {
      version: 2, agents: structuredClone(defaultAgents),
      projects: [{ id: 'default', name: 'AI Agent 워크스페이스', path: projectPath, allowWrites: false }],
      settings: { concurrency: 2, maxDelegations: 6, timeoutMinutes: 15, tokenBudget: 250000 }, runs: [],
    };
    if ((this.state.version || 1) < 2) {
      if (!this.state.agents.some(agent => agent.id === 'monitor')) this.state.agents.push(structuredClone(defaultAgents.find(agent => agent.id === 'monitor')));
      this.state.version = 2;
    }
    for (const run of this.state.runs) {
      if (['running', 'stopping', 'queued'].includes(run.status)) {
        run.status = 'interrupted'; run.finishedAt = new Date().toISOString();
        run.error = '앱이 종료되어 실행이 중단되었습니다. 다시 요청해 주세요.';
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

export function validateAgent(input, existing) {
  const agent = { ...existing, ...input };
  for (const [field, maximum] of [['name', 50], ['role', 80], ['description', 300], ['instructions', 8000]]) {
    if (typeof agent[field] !== 'string' || !agent[field].trim() || agent[field].length > maximum) throw new Error(`${field}: 1~${maximum}자 이내로 입력해 주세요.`);
    agent[field] = agent[field].trim();
  }
  if (!['read-only', 'workspace-write'].includes(agent.access)) throw new Error('지원하지 않는 작업 권한입니다.');
  if (agent.id === 'main') { agent.enabled = true; agent.access = 'read-only'; }
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
  const bounds = { concurrency: [1, 3], maxDelegations: [1, 12], timeoutMinutes: [1, 60], tokenBudget: [1000, 2000000] };
  const result = {};
  for (const [key, [min, max]] of Object.entries(bounds)) {
    const value = Number(input[key]);
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${key}: ${min}~${max} 범위의 정수가 필요합니다.`);
    result[key] = value;
  }
  return result;
}
