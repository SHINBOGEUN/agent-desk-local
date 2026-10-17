const icons = {
 grid:'<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
 team:'<circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 5a3 3 0 0 1 0 6M18 14a5 5 0 0 1 3 4v3"/>',
 history:'<path d="M3 11a9 9 0 1 1 2.6 7M3 4v7h7M12 7v5l3 2"/>',
 folder:'<path d="M3 7a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
 settings:'<path d="m9 3-1 3-3 1-2 4 2 2v4l4 2 3-1 3 1 4-2v-4l2-2-2-4-3-1-1-3z"/><circle cx="12" cy="12" r="3"/>',
 lock:'<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/>',
 plus:'<path d="M12 5v14M5 12h14"/>',
 spark:'<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5z"/>',
 'arrow-up':'<path d="M12 19V5m-6 6 6-6 6 6"/>',
 'arrow-right':'<path d="M5 12h14m-6-6 6 6-6 6"/>',
 activity:'<path d="M3 12h4l3-7 4 14 3-7h4"/>',
 search:'<circle cx="10" cy="10" r="6"/><path d="m15 15 6 6"/>',
 build:'<path d="m14 4 6 6M3 21l5-1L20 8l-4-4L4 16zM5 15l4 4"/>',
 shield:'<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6zM8 12l3 3 5-6"/>',
 close:'<path d="m6 6 12 12M18 6 6 18"/>',
 terminal:'<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3m6 0h4"/>',
 edit:'<path d="m14 4 6 6M4 16l-1 5 5-1L20 8l-4-4z"/>',
 check:'<path d="m5 12 4 4L19 6"/>',
 clock:'<circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/>',
 token:'<path d="m12 3 8 4v10l-8 4-8-4V7zM4 7l8 4 8-4M12 11v10"/>',
};
const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.spark}</svg>`;
const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[char]);
const format = value => Number(value || 0).toLocaleString('ko-KR');
const clock = date => new Date(date).toLocaleTimeString('ko-KR', { hour12:false, hour:'2-digit', minute:'2-digit', second:'2-digit' });
const date = value => new Date(value).toLocaleString('ko-KR', { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' });
const labels = { idle:'대기 중', working:'작업 중', running:'진행 중', waiting:'응답 대기', queued:'배정 대기', completed:'완료', needs_review:'검토 필요', failed:'실패', interrupted:'중단', stopping:'중단 중', disabled:'비활성' };
const badge = status => `<span class="status ${esc(status)}"><i></i>${labels[status] || esc(status)}</span>`;
let state, csrf, selectedProject = localStorage.getItem('agent-desk-project') || '', view = 'overview', editorType, editorId, selectedRunId, skillEditorId;
let chatSignature = '', lastActivitySignature = '', lastApprovalSignature = '', settingsPopulated = false;
let flowReturnTimer;
let draftImages = [], pendingImageReads = 0, sendingRequest = false;
const MAX_DRAFT_IMAGES = 3, MAX_DRAFT_IMAGE_BYTES = 5 * 1024 * 1024;
const FLOW_REPORT_MS = 6000;
const agentIcon = agent => agent.id === 'main' ? 'spark' : agent.id === 'researcher' ? 'search' : agent.id === 'verifier' ? 'shield' : 'build';
const avatar = agent => `<span class="agent-avatar ${esc(agent.color)}">${icon(agentIcon(agent))}</span>`;
function paintIcons(root = document) { root.querySelectorAll('[data-icon]').forEach(node => { node.innerHTML = icon(node.dataset.icon); node.removeAttribute('data-icon'); }); }
paintIcons();
$('#refine-prompt').checked = localStorage.getItem('agent-desk-refine') === 'true';

function toast(message, error = false) { const element = $('#toast'); element.textContent = message; element.className = `toast${error ? ' error' : ''}`; clearTimeout(toast.timer); toast.timer = setTimeout(() => element.classList.add('hidden'), 4500); }
function renderDraftImages() {
  const container = $('#image-preview'); container.replaceChildren();
  container.classList.toggle('hidden', !draftImages.length);
  draftImages.forEach((image, index) => {
    const card = document.createElement('div'); card.className = 'draft-image';
    const preview = document.createElement('img'); preview.src = image.dataUrl; preview.alt = `첨부 이미지 ${index + 1} 미리보기`;
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'draft-image-remove'; remove.textContent = '×'; remove.setAttribute('aria-label', `첨부 이미지 ${index + 1} 제거`);
    remove.addEventListener('click', () => { draftImages.splice(index, 1); renderDraftImages(); });
    card.append(preview, remove); container.append(card);
  });
}
function readImage(file) { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve({ dataUrl: reader.result }); reader.onerror = () => reject(new Error('이미지를 읽지 못했습니다.')); reader.readAsDataURL(file); }); }
async function addImages(files) {
  const selected = [...files];
  if (pendingImageReads) throw new Error('이미지 첨부가 끝난 뒤 다시 시도해 주세요.');
  if (draftImages.length + selected.length > MAX_DRAFT_IMAGES) throw new Error(`이미지는 최대 ${MAX_DRAFT_IMAGES}장까지 첨부할 수 있습니다.`);
  for (const file of selected) {
    if (!['image/png','image/jpeg','image/webp'].includes(file.type)) throw new Error('PNG, JPEG, WebP 이미지만 첨부할 수 있습니다.');
    if (!file.size || file.size > MAX_DRAFT_IMAGE_BYTES) throw new Error('이미지 한 장은 5MB 이하여야 합니다.');
  }
  pendingImageReads++; if (state) render();
  try { draftImages.push(...await Promise.all(selected.map(readImage))); renderDraftImages(); }
  finally { pendingImageReads--; if (state) render(); }
}
const runImages = run => (run.images || []).length ? `<div class="run-images">${run.images.map((image, index) => `<a href="/api/attachments/${esc(image.id)}" target="_blank" rel="noopener noreferrer" aria-label="첨부 이미지 ${index + 1} 크게 보기"><img src="/api/attachments/${esc(image.id)}" alt="첨부 이미지 ${index + 1}" loading="lazy"></a>`).join('')}</div>` : '';
async function api(route, payload) {
  const response = await fetch(`/api/${route}`, { method:'POST', headers:{ 'Content-Type':'application/json', 'X-Agent-Desk-Token':csrf }, body:JSON.stringify(payload) });
  const result = await response.json(); if (!response.ok) throw new Error(result.error || '요청에 실패했습니다.'); return result;
}
const project = () => state?.projects.find(item => item.id === selectedProject);
const projectRuns = () => (state?.runs || []).filter(item => item.projectId === selectedProject);
const delegatedCount = run => run.tasks.filter(task => !task.consultation && !['main', 'prompt_refiner'].includes(task.agentId)).length;
const resumable = run => ['interrupted', 'failed', 'needs_review'].includes(run.status);
const resumeButton = run => resumable(run) ? `<button class="button secondary resume-button" type="button" data-resume="${esc(run.id)}" ${state.activeRunId || state.connection.status !== 'connected' ? 'disabled' : ''}>이어서 실행</button>` : '';
function quotaResumePlan(run) {
  if (run.endReason?.kind !== 'usage_limit') return null;
  const base = Math.max(state.settings.usagePercentLimit, run.limits?.usagePercentLimit || 0);
  const current = state.usageLimits?.windows?.find(window => window.kind === 'primary' && window.windowDurationMins === 300);
  const prior = run.accountUsage;
  if (current && Number.isFinite(prior?.windowResetsAt) && Number.isFinite(current.resetsAt) && Math.abs(prior.windowResetsAt - current.resetsAt) >= 300) return { message:'5시간 한도 창이 갱신됐습니다. 일반 이어서 실행을 선택하세요.' };
  const consumed = current && Number.isFinite(prior?.baselineUsedPercent) ? Math.max(0, Math.round((current.usedPercent - prior.baselineUsedPercent) * 10) / 10) : prior?.consumedPercent ?? base;
  const additional = Math.max(5, Math.ceil((consumed + 5 - base) / 5) * 5);
  const limit = base + additional;
  if (limit > 100 || current && (current.remainingPercent < 5 || limit - consumed > current.remainingPercent)) return { message:`현재 누적 ${format(consumed)}%p입니다. 계정 잔여량이나 작업 한도 때문에 더 늘릴 수 없습니다.` };
  return { base, consumed, additional, limit };
}
const extendResumeButton = (run, plan = quotaResumePlan(run)) => plan?.additional
  ? `<button class="button primary resume-button resume-extra-button" type="button" data-resume="${esc(run.id)}" data-resume-extra="${plan.additional}" ${state.activeRunId || state.connection.status !== 'connected' ? 'disabled' : ''}>+${format(plan.additional)}%p 추가해서 이어서 실행</button>` : '';
function runDiagnostics(run) {
  const reason = run.status === 'needs_review'
    ? run.qualityGate?.reason || run.endReason?.message || run.error
    : run.endReason?.message || run.error;
  const groups = new Map();
  for (const task of run.tasks || []) {
    const key = task.agentId || task.agentName;
    const group = groups.get(key) || { name:task.agentName || key, tokens:0, tasks:0, unreported:0 };
    group.tasks++;
    if (Number.isFinite(task.usage?.totalTokens)) group.tokens += task.usage.totalTokens;
    else group.unreported++;
    groups.set(key,group);
  }
  const measured = [...groups.values()].reduce((total, group) => total + group.tokens, 0);
  const rows = [...groups.values()].sort((a,b) => b.tokens - a.tokens).map(group => `<div class="agent-usage-row"><strong>${esc(group.name)}</strong><span>${format(group.tokens)} 토큰${measured ? ` · ${format(Math.round(group.tokens / measured * 1000) / 10)}%` : ''} · ${group.tasks}개 작업${group.unreported ? ` · ${group.unreported}개 사용량 미보고` : ''}</span></div>`).join('');
  const quota = run.accountUsage ? `5시간 한도 사용률 증가 ${format(run.accountUsage.consumedPercent)}%p / 제한 ${format(run.limits?.usagePercentLimit)}%p` : '이 실행의 5시간 사용률 기록 없음';
  const plan = quotaResumePlan(run);
  const resumeNote = plan?.additional ? `현재 누적 ${format(plan.consumed)}%p · 이번 작업 한도 ${format(plan.base)} → ${format(plan.limit)}%p. 기존 사용량을 유지하며 이번 작업에만 적용합니다.` : plan?.message || '현재 파일 상태를 확인한 뒤 미완료 부분을 진행합니다. 같은 5시간 창에서는 이전 사용률을 합산합니다.';
  return `${reason ? `<section class="run-reason"><strong>${run.status === 'interrupted' ? '중단 이유' : run.status === 'failed' ? '실패 이유' : '검토 필요 이유'}</strong><p>${esc(reason)}</p>${run.endReason?.at ? `<small>${esc(date(run.endReason.at))}</small>` : ''}</section>` : ''}<section class="agent-usage"><h3>에이전트별 사용량</h3>${rows || '<p>사용량이 보고된 작업이 없습니다.</p>'}<small>${esc(quota)} · 위 비율은 기록된 토큰 기준입니다. 계정의 5시간 사용률은 에이전트별로 나눌 수 없습니다.</small></section>${run.resumeFromRunId ? `<p class="resume-note">이전 작업을 이어서 실행한 기록입니다. 이전 기록 ID: ${esc(run.resumeFromRunId)}</p>` : ''}${resumable(run) ? `<div class="resume-actions">${resumeButton(run)}${extendResumeButton(run, plan)}<small>${esc(resumeNote)}</small></div>` : ''}`;
}
const refinementSummary = run => {
  const refinement = run.promptRefinement;
  if (!refinement?.enabled) return '';
  const detail = refinement.status === 'completed' ? `<div class="refinement-text">${esc(refinement.text)}</div>` : refinement.status === 'failed' ? `<p>정리에 실패해 원문을 메인 AI에 전달했습니다. ${esc(refinement.error || '')}</p>` : '<p>요청을 정리하고 있어요.</p>';
  return `<div class="prompt-refinement"><strong>요청 정리 AI ${refinement.status === 'completed' ? '완료' : refinement.status === 'failed' ? '실패' : '작업 중'}</strong>${detail}</div>`;
};
const runtime = id => state.runtime.find(item => item.id === id) || { status:'idle' };
const recentFlowReports = run => (run?.tasks || []).filter(task => !['main','prompt_refiner'].includes(task.agentId) && task.status === 'completed' && task.finishedAt && Date.now() - Date.parse(task.finishedAt) < FLOW_REPORT_MS);
const effortNames = { low:'Low', medium:'Medium', high:'High', xhigh:'XHigh', max:'Max', ultra:'Ultra' };
const effortOrder = Object.keys(effortNames);
const effortName = effort => effortNames[effort] || effortNames.low;
const modelName = agent => {
  const model = state.models.find(item => item.id === agent?.model) || state.models.find(item => item.isDefault);
  return (model?.name || agent?.model || 'Codex 기본 모델').replace(/^(GPT-\d+(?:\.\d+)?)-/, '$1 ');
};

// Escape first; only a small safe Markdown subset is rendered. Raw HTML never executes.
function markdown(text) {
  const pieces = String(text || '').split(/(```[\s\S]*?```)/g);
  return pieces.map(piece => {
    if (piece.startsWith('```')) return `<pre><code>${esc(piece.replace(/^```[^\n]*\n?/, '').replace(/```$/, ''))}</code></pre>`;
    return esc(piece).replace(/`([^`\n]+)`/g, '<code>$1</code>').replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>').replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  }).join('');
}

function render() {
  if (!state) return;
  if (!project()) selectedProject = state.projects[0]?.id || '';
  localStorage.setItem('agent-desk-project', selectedProject);
  const projectOptions = state.projects.map(item => `<option value="${esc(item.id)}">${esc(item.name)}</option>`).join('');
  if ($('#project-select').innerHTML !== projectOptions) $('#project-select').innerHTML = projectOptions;
  $('#project-select').value = selectedProject;
  $('#project-select').disabled = !!state.activeRunId;
  $('#project-path').textContent = project()?.path || '';
  $('#project-path').title = project()?.path || '';
  $('#project-permission').className = `permission-pill${project()?.allowWrites ? ' write' : ''}`;
  $('#project-permission').innerHTML = `${icon(project()?.allowWrites ? 'edit' : 'lock')}${project()?.allowWrites ? '파일 수정 허용' : '읽기 전용'}${project()?.autoApproveCommands ? ' · 자동 실행' : ''}`;
  const connection = $('#connection'); connection.className = `connection ${state.connection.status === 'connected' ? '' : state.connection.status === 'connecting' ? 'connecting' : 'error'}`;
  connection.innerHTML = `<i></i>${esc(state.connection.status === 'connected' ? 'Codex 연결됨' : state.connection.status === 'connecting' ? '연결 중' : '연결 확인 필요')}`;
  connection.title = state.connection.message;
  $('#agent-count').textContent = state.agents.length;
  $('#skill-count').textContent = (state.skills || []).filter(skill => skill.enabled).length;
  const busy = !!state.activeRunId;
  $('#send').classList.toggle('hidden', busy); $('#stop').classList.toggle('hidden', !busy);
  $('#send').disabled = state.connection.status !== 'connected' || pendingImageReads > 0 || sendingRequest;
  $('#message').disabled = busy || sendingRequest;
  $('#attach-image').disabled = busy || pendingImageReads > 0 || sendingRequest;
  $('#image-input').disabled = busy || pendingImageReads > 0 || sendingRequest;
  $('#refine-prompt').disabled = busy;
  const mainAgent = state.agents.find(agent => agent.id === 'main');
  $('#main-model').innerHTML = `<strong>${esc(effortName(mainAgent?.effort))}</strong><span>${esc(modelName(mainAgent))} ›</span>`;
  const runs = projectRuns(); const active = state.runtime.filter(item => ['working','waiting','queued'].includes(item.status));
  const usage = runs.reduce((total, run) => total + run.usage.totalTokens, 0);
  const stats = [
    ['지금 일하는 에이전트',active.length,'명',busy ? '팀이 요청을 처리하고 있어요' : '새로운 요청을 기다리고 있어요','activity'],
    ['나의 에이전트',state.agents.filter(item => item.enabled).length,'명',`전체 ${state.agents.length}명 · 메인 AI 포함`,'team'],
    ['완료한 요청',runs.filter(run => run.status === 'completed').length,'건','현재 프로젝트에 저장된 기록','check'],
    ['사용한 토큰',format(usage),'',usage ? '메인 AI + 모든 팀원의 사용량' : '첫 요청부터 사용량을 기록해요','token'],
  ];
  $('#stats').innerHTML = stats.map(([title,value,unit,note,i]) => `<article class="stat"><div class="stat-top">${title}${icon(i)}</div><div class="stat-number">${value}<span>${unit}</span></div><div class="stat-note">${note}</div></article>`).join('');
  renderUsageLimits();
  renderBudgetStatus();
  renderFlow();
  renderChat(); renderActivity(); renderApprovals();
  if (view === 'agents') renderAgents(); if (view === 'skills') renderSkills(); if (view === 'history') renderHistory(); if (view === 'projects') renderProjects();
  if (view === 'settings' && !settingsPopulated) { for (const [key,value] of Object.entries(state.settings)) if ($('#settings-form').elements[key]) $('#settings-form').elements[key].value = value; settingsPopulated = true; }
  if ($('#detail').open) renderDetail();
}

function renderBudgetStatus() {
  const latest = projectRuns()[0];
  const running = latest && ['running', 'stopping'].includes(latest.status);
  const limit = running ? latest.limits?.usagePercentLimit : state.settings.usagePercentLimit;
  const consumed = latest?.accountUsage?.consumedPercent;
  const measured = Number.isFinite(consumed);
  const measurementLimit = latest?.limits?.usagePercentLimit || limit;
  const percentage = measured && measurementLimit ? Math.max(0, Math.min(100, Math.round(consumed / measurementLimit * 100))) : 0;
  const tone = measured && percentage >= 90 ? 'critical' : measured && percentage >= 70 ? 'warning' : '';
  const label = running ? `이번 요청 5시간 한도 ${measured ? `${format(consumed)}%p` : '측정 중'} / 제한 ${format(limit)}%p` : `다음 요청 제한: 5시간 한도의 ${format(limit)}%p`;
  const last = !running && latest ? latest.accountUsage ? `최근 실행 ${format(consumed)}%p / ${format(latest.limits?.usagePercentLimit)}%p · ${labels[latest.status] || latest.status}` : '최근 실행의 사용률 기록 없음' : '';
  const selected = project();
  $('#budget-status').className = `budget-status ${tone}`;
  const fillColor = percentage >= 90 ? '#dc7f77' : percentage >= 70 ? '#d9ad61' : '#8bce98';
  $('#budget-status').innerHTML = `<div class="budget-status-row"><strong>${esc(label)}</strong><span>${running && measured ? `제한의 ${percentage}% 사용` : esc(last)}</span></div>${running && measured ? `<svg class="budget-status-track" role="progressbar" aria-label="이번 요청 사용률 제한 도달 정도" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percentage}" viewBox="0 0 1000 14" preserveAspectRatio="none"><rect width="1000" height="14" rx="7" fill="#243329"/><rect width="${percentage * 10}" height="14" rx="7" fill="${fillColor}"/></svg>` : ''}<small>선택 프로젝트: ${esc(selected?.path || '')} · ${selected?.allowWrites ? '파일 수정 허용' : '읽기 전용'} · 계정 전체의 5시간 사용률 변화이므로 다른 Codex 작업도 포함될 수 있습니다.</small>`;
}

function renderUsageLimits() {
  const limits = state.usageLimits || { status:'loading', windows:[] };
  const container = $('#usage-limits');
  if (limits.status !== 'available') {
    container.innerHTML = `<p class="usage-message">${esc(limits.status === 'loading' ? '사용량을 확인하는 중입니다.' : limits.message || '사용량을 확인할 수 없습니다.')}</p>`;
    return;
  }
  const cards = limits.windows.map((window, index) => {
    const label = window.windowDurationMins === 300 ? '5시간' : window.windowDurationMins === 10080 ? '1주' : window.windowDurationMins ? `${format(window.windowDurationMins)}분` : `한도 ${index + 1}`;
    const remaining = Math.max(0, Math.min(100, Number(window.remainingPercent) || 0));
    const reset = window.resetsAt ? `초기화 ${date(window.resetsAt * 1000)}` : '초기화 시각 확인 불가';
    const level = remaining <= 10 ? 'critical' : remaining <= 20 ? 'low' : '';
    return `<div class="usage-window ${level}"><div class="usage-row"><strong>${esc(label)}</strong><span><b>${remaining.toLocaleString('ko-KR')}%</b> 남음</span></div><div class="usage-track" role="progressbar" aria-label="${esc(label)} 남은 사용량" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${remaining}"><i style="width:${remaining}%"></i></div><small>${esc(reset)}</small></div>`;
  }).join('');
  container.innerHTML = `${cards}<span class="usage-checked">${limits.checkedAt ? `마지막 확인 ${esc(clock(limits.checkedAt))}` : ''}</span>`;
}

function renderFlow() {
  const busy = !!state.activeRunId;
  const activeRun = state.runs.find(run => run.id === state.activeRunId);
  const reports = recentFlowReports(activeRun || projectRuns()[0]);
  const reportingAgents = new Set(reports.map(task => task.agentId));
  const refining = activeRun?.promptRefinement?.status === 'working';
  const mainAgent = state.agents.find(agent => agent.id === 'main') || { name:'메인 AI' };
  const mainRuntime = runtime('main');
  const activeStatuses = ['working','waiting','queued'];
  const mainLabel = mainRuntime.status === 'waiting' ? '팀원 보고 대기 중' : mainRuntime.status === 'queued' ? '배정 대기 중' : refining ? '정리 결과 대기 중' : busy ? (mainRuntime.task || '요청 분석 중') : '대기 중';
  const refinement = activeRun?.promptRefinement;
  const refinerLabel = refinement?.status === 'working' ? '요청 정리 중' : refinement?.status === 'completed' ? '정리 완료 · 메인에게 전달' : refinement?.status === 'failed' ? '원문으로 전달' : refinement?.enabled ? '정리 대기' : $('#refine-prompt').checked ? '다음 요청에서 사용' : '꺼짐 · 바로 메인으로';
  $('#flow-user').classList.toggle('is-active', busy);
  $('#flow-user').querySelector('.flow-node-status').textContent = refining ? '정리 AI에게 전달됨' : busy ? '요청 전달됨' : '대기 중';
  $('#flow-refiner').classList.toggle('is-active', refining);
  $('#flow-refiner').classList.toggle('is-waiting', refinement?.status === 'pending');
  $('#flow-refiner').classList.toggle('is-skipped', !refinement?.enabled);
  $('#flow-refiner').querySelector('.flow-node-status').textContent = refinerLabel;
  $('#flow-main').classList.toggle('is-active', busy && !refining);
  $('#flow-main').querySelector('.flow-main-avatar').innerHTML = icon('spark');
  $('#flow-main').querySelector('b').textContent = mainAgent.name;
  $('#flow-main').querySelector('.flow-node-status').textContent = mainLabel;
  const agents = state.agents.filter(agent => !['main', 'prompt_refiner'].includes(agent.id));
  $('#flow-agents').innerHTML = agents.length ? agents.map((agent,index) => {
    const rt = runtime(agent.id); const active = activeStatuses.includes(rt.status); const reporting = rt.status === 'idle' && reportingAgents.has(agent.id);
    return `<article class="flow-node flow-agent ${active ? 'is-active' : ''} ${rt.status === 'waiting' || rt.status === 'queued' ? 'is-waiting' : ''} ${reporting ? 'is-reporting' : ''}" id="flow-agent-${index}" data-flow-status="${esc(rt.status)}"><span class="flow-agent-avatar ${esc(agent.color)}">${icon(agentIcon(agent))}</span><div class="flow-agent-copy"><b>${esc(agent.name)}</b><small title="${esc(rt.task || agent.role)}">${esc(rt.task || agent.role)}</small></div>${reporting ? '<span class="status completed"><i></i>보고 완료</span>' : badge(rt.status)}</article>`;
  }).join('') : '<div class="flow-empty">등록된 에이전트가 없습니다.</div>';
  const activeAgents = agents.filter(agent => activeStatuses.includes(runtime(agent.id).status));
  const caption = busy ? `${activeAgents.length + (activeStatuses.includes(mainRuntime.status) ? 1 : 0) + (refining ? 1 : 0)}명 작업 중 · 흐름이 실시간으로 표시됩니다` : reports.length ? '완료 보고가 메인 AI로 돌아오는 중입니다' : '요청을 보내면 담당 흐름이 표시됩니다';
  if ($('#flow-caption').textContent !== caption) $('#flow-caption').textContent = caption;
  const taskSummary = activeAgents.length ? `<span class="flow-summary-label">현재 배정</span>${activeAgents.map(agent => { const rt = runtime(agent.id); return `<span class="flow-task-chip"><i></i><b>${esc(agent.name)}</b><span>${esc(rt.task || labels[rt.status] || '작업 중')}</span>${badge(rt.status)}</span>`; }).join('')}` : `<span class="flow-summary-idle"><i></i>${refining ? '요청 정리 AI가 원문을 정리하고 있습니다.' : reports.length ? '완료된 팀원 보고가 메인 AI에 전달되었습니다.' : busy ? `메인 AI ${esc(mainLabel)}` : '모든 팀원이 대기 중입니다. 요청을 보내면 작업 경로가 움직입니다.'}</span>`;
  if ($('#flow-task-summary').innerHTML !== taskSummary) $('#flow-task-summary').innerHTML = taskSummary;
  requestAnimationFrame(drawFlowLines);
}

function drawFlowLines() {
  const canvas = $('#team-flow-graph'), svg = $('#flow-lines');
  if (!canvas || !svg || !state) return;
  clearTimeout(flowReturnTimer);
  const bounds = canvas.getBoundingClientRect();
  if (!bounds.width || !bounds.height) return;
  svg.setAttribute('viewBox', `0 0 ${bounds.width} ${bounds.height}`);
  svg.setAttribute('width', bounds.width); svg.setAttribute('height', bounds.height);
  const activeRun = state.runs.find(run => run.id === state.activeRunId);
  const reports = recentFlowReports(activeRun || projectRuns()[0]);
  if (reports.length) {
    const nextExpiry = Math.min(...reports.map(task => FLOW_REPORT_MS - (Date.now() - Date.parse(task.finishedAt))));
    flowReturnTimer = setTimeout(() => renderFlow(), Math.max(50, nextExpiry + 40));
  }
  const refining = activeRun?.promptRefinement?.status === 'working';
  const usingRefiner = activeRun?.promptRefinement?.enabled;
  const links = usingRefiner ? [
    { from:$('#flow-user'),to:$('#flow-refiner'),active:refining || activeRun.promptRefinement.status === 'completed',waiting:false },
    { from:$('#flow-refiner'),to:$('#flow-main'),active:activeRun.promptRefinement.status === 'completed',waiting:refining,handoff:activeRun.promptRefinement.status === 'completed' },
  ] : [{ from:$('#flow-user'),to:$('#flow-main'),active:!!state.activeRunId,waiting:false,bypass:true }];
  if (activeRun?.promptRefinement?.status === 'failed') links.push({ from:$('#flow-user'),to:$('#flow-main'),active:true,waiting:false,bypass:true });
  const agents = state.agents.filter(item => !['main', 'prompt_refiner'].includes(item.id));
  const agentNodes = agents.map((agent,index) => ({ agent, node:document.getElementById(`flow-agent-${index}`), status:runtime(agent.id).status })).filter(item => item.node);
  const mainRect = $('#flow-main').getBoundingClientRect();
  const rootX = mainRect.left + mainRect.width / 2 - bounds.left;
  const rootY = mainRect.bottom - bounds.top;
  const columns = getComputedStyle($('#flow-agents')).gridTemplateColumns.split(' ').length > 1;
  const firstRect = agentNodes[0]?.node.getBoundingClientRect();
  const spineX = columns ? rootX : firstRect ? Math.max(9, firstRect.left - bounds.left - 13) : rootX;
  const reportedAgents = new Set(reports.map(task => task.agentId));
  const branches = agentNodes.map(({agent,node,status}) => {
    const rect = node.getBoundingClientRect();
    const y = rect.top + rect.height / 2 - bounds.top;
    const left = rect.left - bounds.left, right = rect.right - bounds.left;
    const edge = columns ? (left < spineX ? right : left) : left;
    return { y, edge, status, reporting:status === 'idle' && reportedAgents.has(agent.id) };
  });
  const lastY = Math.max(rootY, ...branches.map(branch => branch.y));
  const activeBranches = branches.filter(branch => branch.status === 'working');
  const activeY = Math.max(rootY, ...activeBranches.map(branch => branch.y));
  const trunkPath = y => `M ${rootX} ${rootY} V ${rootY + 9} H ${spineX} V ${y}`;
  const trunk = branches.length ? `<path class="flow-spine" d="${trunkPath(lastY)}"/>${activeBranches.length ? `<path class="flow-spine is-active" d="${trunkPath(activeY)}"/>` : ''}` : '';
  const branchPaths = branches.map(({y,edge,status,reporting}) => {
    const working = status === 'working', waiting = status === 'waiting' || status === 'queued';
    const bend = Math.min(22, Math.abs(edge - spineX) / 3);
    const direction = Math.sign(edge - spineX) || 1;
    const d = `M ${spineX} ${y} C ${spineX + direction * bend} ${y}, ${edge - direction * bend} ${y}, ${edge} ${y}`;
    return `<path class="flow-branch${status === 'disabled' ? ' is-disabled' : ''}" d="${d}"/>${working || waiting || reporting ? `<path class="flow-branch ${working ? 'is-active' : waiting ? 'is-waiting' : 'is-reporting'}" d="${d}"/>` : ''}<circle class="flow-junction${working ? ' is-active' : waiting ? ' is-waiting' : reporting ? ' is-reporting' : ''}" cx="${spineX}" cy="${y}" r="3"/>`;
  }).join('');
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const motionPaths = branches.map(({y,edge,status,reporting}) => {
    if (status !== 'working' && !reporting) return '';
    const returning = reporting;
    const d = returning
      ? `M ${edge} ${y} H ${spineX} V ${rootY + 9} H ${rootX} V ${rootY}`
      : `M ${rootX} ${rootY} V ${rootY + 9} H ${spineX} V ${y} H ${edge}`;
    const kind = returning ? 'is-returning' : 'is-outbound';
    return `<path class="flow-route ${kind}" d="${d}"/>${reduceMotion ? '' : `<circle class="flow-light ${kind}" r="3.5"><animateMotion path="${d}" dur="2.4s" repeatCount="indefinite"/></circle>`}`;
  }).join('');
  const agentIndexes = new Map(agents.map((agent,index) => [agent.id,index]));
  for (const task of activeRun?.tasks || []) {
    if (!['queued','working','waiting'].includes(task.status)) continue;
    for (const source of task.handoffFrom || []) {
      const fromIndex = agentIndexes.get(source.agentId), toIndex = agentIndexes.get(task.agentId);
      if (fromIndex === undefined || toIndex === undefined) continue;
      links.push({ from:document.getElementById(`flow-agent-${fromIndex}`),to:document.getElementById(`flow-agent-${toIndex}`),active:true,waiting:false,handoff:true });
    }
  }
  for (const item of activeRun?.discussions || []) {
    if (item.status !== 'pending' && (!item.answeredAt || Date.now() - Date.parse(item.answeredAt) > 12000)) continue;
    const fromIndex = agentIndexes.get(item.status === 'pending' ? item.fromId : item.toId);
    const toIndex = agentIndexes.get(item.status === 'pending' ? item.toId : item.fromId);
    if (fromIndex === undefined || toIndex === undefined) continue;
    links.push({ from:document.getElementById(`flow-agent-${fromIndex}`),to:document.getElementById(`flow-agent-${toIndex}`),active:true,waiting:false,discussion:true });
  }
  const pathFor = ({from,to,active,waiting,handoff,discussion,bypass}) => {
    if (!from || !to) return '';
    const a=from.getBoundingClientRect(), b=to.getBoundingClientRect();
    const ax=a.left+a.width/2-bounds.left, ay=a.top+a.height/2-bounds.top;
    const bx=b.left+b.width/2-bounds.left, by=b.top+b.height/2-bounds.top;
    const dx=bx-ax,dy=by-ay;
    let x1,y1,x2,y2,d;
    if (Math.abs(dx)>Math.abs(dy)) {
      const dir=dx>=0?1:-1; x1=ax+dir*a.width/2; y1=ay; x2=bx-dir*b.width/2; y2=by;
      const bend=Math.max(22,Math.abs(x2-x1)*.4); d=`M ${x1} ${y1} C ${x1+dir*bend} ${y1}, ${x2-dir*bend} ${y2}, ${x2} ${y2}`;
    } else {
      const dir=dy>=0?1:-1; x1=ax; y1=ay+dir*a.height/2; x2=bx; y2=by-dir*b.height/2;
      const bend=Math.max(22,Math.abs(y2-y1)*.4); d=`M ${x1} ${y1} C ${x1} ${y1+dir*bend}, ${x2} ${y2-dir*bend}, ${x2} ${y2}`;
    }
    if (bypass) {
      const skipped = $('#flow-refiner').getBoundingClientRect();
      if (skipped.top >= a.bottom - 1 && skipped.bottom <= b.top + 1) {
        const rail = Math.max(8, Math.min(a.left,b.left,skipped.left) - bounds.left - 16);
        x1 = a.left - bounds.left; y1 = ay; x2 = b.left - bounds.left; y2 = by;
        d = `M ${x1} ${y1} H ${rail + 10} Q ${rail} ${y1} ${rail} ${y1 + 10} V ${y2 - 10} Q ${rail} ${y2} ${rail + 10} ${y2} H ${x2}`;
      }
    }
    return `<path class="flow-path${active?' is-active':''}${waiting?' is-waiting':''}${handoff?' is-handoff':''}${discussion?' is-discussion':''}${bypass?' is-bypass':''}" d="${d}"/>${(handoff || discussion) && !reduceMotion ? `<circle class="flow-light is-returning" r="3.5"><animateMotion path="${d}" dur="2.4s" repeatCount="indefinite"/></circle>` : ''}`;
  };
  const markup = `<defs><marker id="flow-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0 8 4 0 8z"/></marker></defs>${trunk}${branchPaths}${motionPaths}${links.map(pathFor).join('')}`;
  // Keep live SVG nodes in place between state events so the moving lights do not restart.
  if (svg._flowMarkup !== markup) { svg.innerHTML = markup; svg._flowMarkup = markup; }
}
window.addEventListener('resize', () => requestAnimationFrame(drawFlowLines));

function renderChat() {
  const runs = projectRuns().slice(0,10).reverse();
  const latest = runs.at(-1);
  const mainTask = latest?.tasks.find(item => item.agentId === 'main');
  const signature = JSON.stringify([selectedProject, state.activeRunId, state.connection.status, runs.map(item => [item.id,item.answer,item.error,item.status,item.tasks.length,item.tasks.find(task => task.agentId === 'main')?.liveText,item.promptRefinement?.status,item.promptRefinement?.text,(item.images || []).map(image => image.id)])]);
  if (signature === chatSignature) return;
  chatSignature = signature;
  const container = $('#chat-messages'); const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 100;
  if (!runs.length) {
    container.innerHTML = `<div class="chat-welcome"><span class="welcome-mark">${icon('spark')}</span><h3>혼자 시작해도, 팀으로 완성해요.</h3><p>하고 싶은 일을 편하게 말해 주세요.<br>필요한 팀원에게 맡기고, 확인한 결과를 모아 드릴게요.</p><div class="suggestions"><button class="suggestion" data-prompt="현재 프로젝트의 구조를 리서처에게 조사시키고, 체커에게 결과를 검증시킨 다음 핵심을 정리해 줘. 파일은 수정하지 마.">프로젝트 살펴보기 ${icon('arrow-right')}</button><button class="suggestion" data-prompt="우리 팀의 역할과 이 프로젝트에서 할 수 있는 일을 간단히 설명해 줘.">우리 팀 알아보기 ${icon('arrow-right')}</button></div></div>`;
    return;
  }
  container.innerHTML = runs.map(run => {
    const task = run.tasks.find(item => item.agentId === 'main');
    const ongoing = ['running','stopping'].includes(run.status);
    const text = run.answer || (ongoing ? task?.liveText : '') || '';
    const plan = quotaResumePlan(run);
    const extendedResume = extendResumeButton(run, plan);
    return `<article class="message user"><span class="message-avatar">ME</span><div class="message-content"><div class="message-header">나<time>${date(run.startedAt)}</time></div><div class="message-body">${esc(run.message)}</div>${runImages(run)}${refinementSummary(run)}</div></article><article class="message"><span class="message-avatar">${icon('spark')}</span><div class="message-content"><div class="message-header">메인 AI ${badge(run.status)}</div><div class="message-body">${markdown(text)}</div>${ongoing ? `<div class="thinking"><span><i></i> <i></i> <i></i></span> ${task?.status === 'waiting' ? '팀원의 보고를 기다리고 있어요' : '요청을 처리하고 있어요'}</div>` : ''}${run.error ? `<p class="error-text">${esc(run.error)}</p>` : ''}<div class="run-meta"><span>${delegatedCount(run)}개 위임 · ${format(run.usage.totalTokens)} tokens</span><button class="text-button" data-detail="${esc(run.id)}">작업 상세</button>${resumeButton(run)}</div>${plan ? `<div class="quota-resume">${extendedResume}<small>${esc(plan.additional ? `현재 누적 ${format(plan.consumed)}%p · 이번 작업 한도 ${format(plan.base)} → ${format(plan.limit)}%p` : plan.message)}</small></div>` : ''}</div></article>`;
  }).join('');
  if (atBottom || latest?.status === 'running' && !mainTask?.liveText) container.scrollTop = container.scrollHeight;
}

function renderActivity() {
  const run = projectRuns()[0];
  const signature = JSON.stringify([selectedProject,run?.events]);
  if (signature === lastActivitySignature) return;
  lastActivitySignature = signature;
  $('#activity-caption').textContent = run ? `${run.events.length}개 이벤트 · ${date(run.startedAt)}` : '실제 실행 이벤트가 표시됩니다';
  $('#activity-list').innerHTML = run?.events.length ? run.events.slice(-35).reverse().map(event => `<div class="activity-row ${esc(event.kind)}"><time>${clock(event.at)}</time><span class="event-symbol">${event.kind === 'success' ? '✓' : event.kind === 'error' ? '!' : '↳'}</span><span class="event-agent">${esc(state.agents.find(item => item.id === event.agentId)?.name || '팀원')}</span><span class="event-message">${esc(event.message)}</span></div>`).join('') : `<div class="empty-activity">${icon('activity')}<span>아직 진행 중인 작업이 없어요.<small>메인 AI에게 첫 요청을 보내면 팀의 활동이 여기에 나타납니다.</small></span></div>`;
}

function renderApprovals() {
  const signature = JSON.stringify([state.approvals,state.activeRunId,state.allowAllApprovalsForRun]);
  if (signature === lastApprovalSignature) return;
  lastApprovalSignature = signature;
  const canBulkApprove = state.approvals.filter(approval => ['item/commandExecution/requestApproval','item/fileChange/requestApproval','item/permissions/requestApproval'].includes(approval.method)).length;
  const bulkControls = state.activeRunId && (canBulkApprove || state.allowAllApprovalsForRun) ? `<section class="approval-bulk"><div><strong>${state.allowAllApprovalsForRun ? '이번 요청 전체 허용 켜짐' : '팀원 승인 한 번에 처리'}</strong><small>현재 대기 중인 실행 승인과 이번 요청에서 이어지는 실행 승인을 자동 허용합니다. 질문 답변과 외부 앱 요청은 포함하지 않으며 다음 요청에는 적용되지 않습니다.</small></div><button class="button ${state.allowAllApprovalsForRun ? 'secondary' : 'primary'}" type="button" data-allow-all-approvals="${!state.allowAllApprovalsForRun}">${state.allowAllApprovalsForRun ? '전체 허용 끄기' : `모두 허용 (${canBulkApprove}건 대기)`}</button></section>` : '';
  $('#approval-list').innerHTML = bulkControls + state.approvals.map(approval => {
    const p = approval.params;
    const question = approval.method.includes('requestUserInput');
    const unsupported = approval.method === 'mcpServer/elicitation/request';
    const canAllowSession = !question && !unsupported && ['item/commandExecution/requestApproval','item/fileChange/requestApproval','item/permissions/requestApproval'].includes(approval.method);
    return `<form class="approval-card" data-approval="${esc(approval.id)}"><h3>${esc(approval.agentName)} · ${question ? '답변이 필요해요' : '실행 확인이 필요해요'}</h3>${question ? (p.questions || []).map(q => `<label>${esc(q.question)}${q.options?.length ? `<small>${esc(q.options.map(option => `${option.label}: ${option.description || ''}`).join(' / '))}</small>` : ''}<input name="${esc(q.id)}" placeholder="답변 입력" maxlength="10000"></label>`).join('') : `<pre>${esc(p.command || p.reason || p.message || JSON.stringify(p.permissions || p, null, 2))}</pre>`}${unsupported ? '<p>외부 앱의 양식 확인은 현재 지원하지 않습니다. 거절하고 계속할 수 있습니다.</p>' : ''}<div class="approval-actions">${!unsupported ? `<button class="button primary" type="submit">${question ? '답변 보내기' : '이번 실행 허용'}</button>${canAllowSession ? `<button class="button secondary" type="button" data-allow-session="${esc(approval.id)}">현재 팀원 실행에서 허용</button>` : ''}` : ''}<button type="button" class="button secondary" data-decline="${esc(approval.id)}">${question ? '건너뛰기' : '거절'}</button></div>${canAllowSession ? '<small class="approval-scope-note">이 팀원의 현재 실행에만 적용됩니다. 다른 팀원이나 다음 요청에는 다시 확인할 수 있습니다.</small>' : ''}</form>`;
  }).join('');
}

function renderAgents() {
  $('#agents-grid').innerHTML = state.agents.map(agent => { const skillCount = (state.skills || []).filter(skill => skill.enabled && skill.agentIds.includes(agent.id)).length; return `<article class="panel agent-large"><div class="card-head">${avatar(agent)}<div><h3>${esc(agent.name)}</h3><span class="agent-role">${esc(agent.role)}</span></div><button class="icon-button" data-edit-agent="${esc(agent.id)}" aria-label="${esc(agent.name)} 설정">${icon('edit')}</button></div><p>${esc(agent.description)}</p><div class="agent-card-footer"><div><button type="button" class="agent-model-button" data-edit-agent="${esc(agent.id)}" aria-label="${esc(agent.name)} 모델과 추론 수준 변경"><strong>${esc(effortName(agent.effort))}</strong><span>${esc(modelName(agent))} ›</span></button><br><small>${agent.access === 'workspace-write' ? '프로젝트 권한에 따라 파일 수정' : '읽기 전용'}${agent.optimizationGuidance ? ' · 운영 지침 적용됨' : ''}${skillCount ? ` · 스킬 ${skillCount}개` : ''}</small></div>${badge(runtime(agent.id).status)}</div></article>`; }).join('');
}
function renderSkills() {
  const agents = new Map(state.agents.map(agent => [agent.id, agent.name]));
  const skills = state.skills || [];
  $('#skills-grid').innerHTML = skills.length ? skills.map(skill => {
    const assigned = skill.agentIds.map(id => agents.get(id) || id).join(' · ');
    return `<article class="panel skill-card ${skill.enabled ? '' : 'disabled-skill'}"><div class="skill-card-head"><span class="skill-mark">${icon('spark')}</span><div><h3>${esc(skill.name)}</h3><small>Codex SKILL.md · ${skill.enabled ? '활성' : '꺼짐'} · ${skill.agentIds.length}명에게 연결</small></div><div class="skill-card-actions"><button class="button secondary" type="button" data-edit-skill="${esc(skill.id)}">편집</button></div></div><p>${esc(skill.description)}</p><div class="skill-assignees"><strong>사용 에이전트</strong><span>${esc(assigned || '연결된 팀원이 없습니다.')}</span></div></article>`;
  }).join('') : `<div class="panel empty-panel"><h3>등록된 스킬이 없습니다</h3><p>반복해서 쓸 작업 절차를 만들어 팀원에게 연결하세요.</p></div>`;
}
function renderHistory() {
  const filter = $('#history-filter').value;
  const runs = projectRuns().filter(run => filter === 'all' || filter === 'failed' && ['failed','interrupted'].includes(run.status) || filter === 'running' && ['running','stopping'].includes(run.status) || run.status === filter);
  $('#history-list').innerHTML = runs.length ? runs.map(run => `<button class="panel history-card" data-detail="${esc(run.id)}"><span class="folder-box">${icon('history')}</span><div class="history-text"><h3>${esc(run.message || "이미지 요청")}</h3><p>${date(run.startedAt)} · ${delegatedCount(run)}개 위임 · ${format(run.usage.totalTokens)} tokens${run.promptRefinement?.enabled ? ' · 요청 정리 사용' : ''}</p></div>${badge(run.status)}${icon('arrow-right')}</button>`).join('') : `<div class="panel empty-panel">${icon('history')}<h3>아직 작업 기록이 없어요</h3><p>대시보드에서 메인 AI에게 요청을 보내 보세요.</p></div>`;
}
function renderProjects() {
  $('#projects-grid').innerHTML = state.projects.map(item => `<article class="panel project-large"><span class="folder-box">${icon('folder')}</span><h3>${esc(item.name)}</h3><p>${esc(item.path)}</p><div class="project-actions"><span class="status ${item.allowWrites ? 'queued' : 'idle'}">${icon(item.allowWrites ? 'edit' : 'lock')}${item.allowWrites ? '파일 수정 허용' : '읽기 전용'}</span>${item.autoApproveCommands ? '<span class="status completed">명령 자동 실행</span>' : ''}<div><button class="button secondary" data-edit-project="${esc(item.id)}">설정</button> <button class="button primary" data-project="${esc(item.id)}">열기 ${icon('arrow-right')}</button></div></div></article>`).join('');
}

const viewInfo = { overview:['대시보드','나의 AI 팀, 한눈에','메인 AI에게 맡기고, 팀이 일하는 과정을 확인하세요.'], agents:['에이전트','나만의 AI 팀을 구성하세요','프로젝트가 바뀌어도, 함께 일할 팀은 그대로.'], skills:['스킬','반복 작업 절차를 재사용하세요','필요한 스킬만 선택한 에이전트에게 전달합니다.'], history:['작업 기록','팀이 해온 일을 돌아보세요','담당자부터 검증 결과까지, 요청 하나의 모든 기록.'], projects:['프로젝트','어떤 프로젝트든, 같은 팀으로','내 PC의 작업 폴더를 연결하고 바로 시작하세요.'], settings:['환경 설정','나에게 맞는 작업 방식','실행 범위와 사용량을 직접 조절하세요.'] };
function changeView(next) {
  view = next;
  document.querySelectorAll('section[id$="-view"]').forEach(element => element.classList.toggle('hidden', element.id !== `${view}-view`));
  document.querySelectorAll('.nav-item').forEach(element => element.classList.toggle('active', element.dataset.view === view));
  $('#page-label').textContent = viewInfo[view][0]; $('#page-title').innerHTML = `${esc(viewInfo[view][1])}<span class="accent">.</span>`; $('#page-description').textContent = viewInfo[view][2];
  settingsPopulated = false; render();
}
function selectProject(id) {
  if (state.activeRunId) { toast('진행 중인 요청이 끝난 뒤 프로젝트를 바꿔 주세요.', true); render(); return; }
  selectedProject = id; chatSignature = ''; lastActivitySignature = ''; render();
}

function modelOptions(value = '') { return `<option value="">Codex 기본 모델 (계정 기본값)</option>${state.models.map(model => `<option value="${esc(model.id)}" ${value === model.id ? 'selected' : ''}>${esc((model.name || model.id).replace(/^(GPT-\d+(?:\.\d+)?)-/, '$1 '))}${model.isDefault ? ' · 기본' : ''}</option>`).join('')}`; }
function modelControl(agent) {
  return `<div class="model-control"><div class="model-control-head"><span class="model-bolt" aria-hidden="true">ϟ</span><div class="model-control-choice"><strong id="effort-value">${esc(effortName(agent.effort))}</strong><label class="model-select-shell"><span class="sr-only">사용할 모델</span><span id="model-selected">${esc(modelName(agent))}</span><span aria-hidden="true">›</span><select name="model" id="agent-model" aria-label="사용할 모델">${modelOptions(agent.model)}</select></label></div><button type="button" id="reset-effort" class="reset-effort" title="추론 수준을 High로 설정" aria-label="추론 수준을 High로 설정">↶</button></div><input type="hidden" name="effort" value="${esc(agent.effort)}"><div class="effort-control"><div class="effort-track" id="effort-track"><div id="effort-ticks" class="effort-ticks"></div></div><input id="effort-range" class="effort-range" type="range" min="0" max="4" step="1" aria-label="추론 수준"></div><div class="effort-endpoints"><span>빠름 · 적은 사용량</span><span>깊은 추론</span></div><small>모델과 추론 수준은 이 팀원의 다음 작업부터 적용됩니다.</small></div>`;
}
function syncEffortControl() {
  const form = $('#editor-form');
  const modelId = form.elements.model.value || state.models.find(item => item.isDefault)?.id;
  const model = state.models.find(item => item.id === modelId);
  $('#model-selected').textContent = modelName({ model:modelId });
  const allowed = effortOrder.filter(effort => model?.efforts?.includes(effort));
  const efforts = allowed.length ? allowed : ['low','medium','high'];
  const slider = $('#effort-range');
  let index = efforts.indexOf(form.elements.effort.value);
  if (index < 0) index = Math.max(0, efforts.indexOf('high'));
  slider.max = String(efforts.length - 1);
  slider.dataset.efforts = JSON.stringify(efforts);
  slider.value = String(index);
  $('#effort-ticks').innerHTML = efforts.map((_,i) => `<i style="left:${efforts.length === 1 ? 50 : 3 + 94 * i / (efforts.length - 1)}%"></i>`).join('');
  setEffortFromSlider();
}
function setEffortFromSlider() {
  const slider = $('#effort-range');
  const efforts = JSON.parse(slider.dataset.efforts);
  const index = Number(slider.value);
  const effort = efforts[index];
  $('#editor-form').elements.effort.value = effort;
  $('#effort-value').textContent = effortName(effort);
  $('#effort-track').style.setProperty('--progress', `${efforts.length === 1 ? 100 : index / (efforts.length - 1) * 100}%`);
  slider.setAttribute('aria-valuetext', effortName(effort));
}
const rolePresets = {
  backend: { name:'백엔드 에이전트', role:'백엔드 · API', description:'서버 로직, API, 인증과 연동 코드를 구현합니다.', access:'workspace-write', color:'blue', instructions:'백엔드 구현을 담당합니다. 요청된 API와 서버 로직 범위에 집중하고, 기존 구조와 프로젝트 지침을 먼저 확인하세요. 인증·권한·입력 검증·오류 처리를 살펴보세요. 필요한 파일만 수정하고 비밀키나 실제 자격 증명을 출력하지 마세요. 실행한 테스트와 변경 파일, 미검증 항목을 근거와 함께 보고하세요.' },
  frontend: { name:'프론트엔드 에이전트', role:'프론트엔드 · UI', description:'화면, 상호작용, 반응형 동작을 구현합니다.', access:'workspace-write', color:'blue', instructions:'프론트엔드 구현을 담당합니다. 요청된 화면과 상호작용만 작업하고 기존 컴포넌트·디자인 규칙을 따르세요. 로딩·오류·빈 상태와 키보드 접근성, 작은 화면을 확인하세요. UI 버그는 실제 실행 화면에서 재현하고, 수정 뒤 같은 주소·화면 크기에서 낮은 값과 높은 값 등 문제가 드러나는 상태를 눈으로 확인하세요. CSP·캐시·기존 서버처럼 코드와 화면이 달라지는 원인도 점검하고, 확인하지 못한 화면은 미검증으로 보고하세요. 필요한 파일만 수정하고 실행한 빌드나 테스트, 변경 파일과 미검증 항목을 보고하세요.' },
  design: { name:'웹디자인 에이전트', role:'웹디자인 · UX', description:'정보 구조, 시각적 일관성과 사용 흐름을 개선합니다.', access:'workspace-write', color:'violet', instructions:'웹디자인과 UX를 담당합니다. 먼저 현재 화면과 디자인 시스템을 살펴보고 사용자의 목표, 정보 우선순위, 반응형 동작을 정리하세요. 프로젝트에 맞는 컴포넌트와 색상·간격 규칙을 재사용하고 과도한 장식을 피하세요. 수정한 화면과 확인한 뷰포트, 남은 디자인 판단을 보고하세요.' },
  server: { name:'서버 · 인프라 에이전트', role:'서버 · 인프라', description:'실행 환경, 배포 설정, 컨테이너와 운영 구성을 다룹니다.', access:'workspace-write', color:'amber', instructions:'서버와 인프라 설정을 담당합니다. 요청된 범위의 실행·배포 구성을 조사하고 최소 변경으로 작업하세요. 파괴적인 명령과 외부 배포는 사용자가 명시적으로 요청하지 않으면 실행하지 마세요. 사용자가 명시적으로 요청한 로컬 서비스 시작·재시작은 수행하되, 지정한 IP·호스트·포트의 실제 상태 응답을 확인하기 전에는 성공이라고 보고하지 마세요. EPERM/EACCES/권한 거부가 발생하면 같은 명령을 반복하거나 권한·샌드박스를 바꾸지 말고 멈춰서 차단된 경로와 확인된 결과를 보고하세요. EPERM/EACCES만으로 OS 권한, 샌드박스 정책, 파일 잠금 중 무엇이 원인인지 단정하지 마세요. 재확인 요청에는 과거 보고를 근거로 쓰지 말고 요청 주소를 다시 검사하세요. 오래 실행하는 서비스는 작업 명령이 끝난 뒤와 잠시 기다린 뒤에도 프로세스 및 요청 주소가 살아 있는지 확인하세요. 일시 확인만 했으면 지속 실행 여부는 확인되지 않았다고 보고하세요. 비밀값을 읽거나 출력하지 말고 샘플 설정은 안전한 자리표시자를 사용하세요. 설정 검사 결과와 운영상 위험, 미검증 항목을 보고하세요.' },
  database: { name:'DB 에이전트', role:'데이터베이스 · 스키마', description:'데이터 모델, 쿼리, 마이그레이션과 무결성을 다룹니다.', access:'workspace-write', color:'amber', instructions:'데이터베이스 구조와 쿼리를 담당합니다. 기존 스키마와 데이터 접근 방식을 먼저 확인하고 요청된 범위만 수정하세요. 마이그레이션은 되돌릴 수 있는지와 기존 데이터 호환성을 점검하고, 실제 데이터베이스에 접속하거나 데이터를 변경하지 마세요. 스키마 검사·테스트 결과, 영향 범위와 미검증 항목을 보고하세요.' },
  qa: { name:'QA 에이전트', role:'QA · 테스트', description:'요구사항을 테스트 시나리오로 바꾸고 동작을 확인합니다.', access:'read-only', color:'violet', instructions:'QA와 테스트 검증을 담당합니다. 사용자 요구사항을 확인 가능한 시나리오로 나누고 기존 테스트를 실행하세요. UI·서비스 버그는 실제 사용 중인 주소와 버전에서 재현 조건을 다시 확인하세요. 표시 값뿐 아니라 눈에 보이는 결과를 낮은 값·중간 값·제한 근처 상태에서 점검하고, 미확인 상태는 통과로 기록하지 마세요. 실패를 재현하는 단계와 실제 결과를 기록하며, 테스트가 없는 부분은 검증되지 않았다고 분명히 적으세요. 파일은 수정하지 말고 명령·통과/실패 결과·재현 근거를 보고하세요.' },
  security: { name:'보안 리뷰 에이전트', role:'보안 · 권한 검토', description:'권한, 비밀정보 노출, 입력 검증과 위험한 변경을 점검합니다.', access:'read-only', color:'violet', instructions:'독립적인 보안 리뷰를 담당합니다. 변경된 부분의 권한 검사, 입력 검증, 비밀정보 노출, 위험한 명령과 의존성을 살펴보세요. 비밀값을 열거나 결과에 복사하지 마세요. 확인된 문제만 심각도와 파일 위치, 재현 근거를 붙여 보고하고 파일은 수정하지 마세요.' },
};
function applyRolePreset(key) {
  const preset = rolePresets[key]; if (!preset) return;
  const form = $('#editor-form');
  for (const field of ['name','role','description','access','instructions']) form.elements[field].value = preset[field];
}
function openEditor(type, id) {
  if (state.activeRunId) return toast('진행 중인 요청이 끝난 뒤 설정을 변경해 주세요.', true);
  editorType = type; editorId = id;
  $('#editor-error').textContent = '';
  const isAgent = type === 'agent';
  $('#delete-agent').classList.toggle('hidden', !isAgent || !id || ['main', 'prompt_refiner'].includes(id));
  if (isAgent) {
    const agent = state.agents.find(item => item.id === id) || { name:'',role:'',description:'',model:'gpt-6-luna',effort:'high',access:'read-only',instructions:'',optimizationGuidance:'',enabled:true };
    $('#editor-title').textContent = id ? '에이전트 설정' : '새로운 팀원 만들기';
    $('#editor-fields').innerHTML = `${id ? '' : `<label>역할 템플릿<select id="agent-preset"><option value="">직접 설정</option><option value="backend">백엔드</option><option value="frontend">프론트엔드</option><option value="design">웹디자인 · UX</option><option value="server">서버 · 인프라</option><option value="database">DB · 데이터</option><option value="qa">QA · 테스트</option><option value="security">보안 리뷰</option></select><small>템플릿은 이름·소개·권한·작업 지침을 채웁니다. 저장 전에 모두 수정할 수 있어요.</small></label>`}${modelControl(agent)}<div class="form-row"><label>이름<input name="name" value="${esc(agent.name)}" maxlength="50" placeholder="예: 문서 에디터" required></label><label>역할<input name="role" value="${esc(agent.role)}" maxlength="80" placeholder="예: 문서 · 편집" required></label></div><label>한 줄 소개<input name="description" value="${esc(agent.description)}" maxlength="300" required></label><label>작업 권한<select name="access" ${['main', 'prompt_refiner'].includes(id) ? 'disabled' : ''}><option value="read-only" ${agent.access === 'read-only' ? 'selected' : ''}>읽기 전용</option><option value="workspace-write" ${agent.access === 'workspace-write' ? 'selected' : ''}>프로젝트 내 파일 수정</option></select><small>수정 권한은 여기와 프로젝트 설정이 모두 허용해야 합니다. 요청 정리 AI는 항상 읽기 전용입니다.</small></label><label>작업 지침<textarea name="instructions" maxlength="8000" required placeholder="이 팀원이 맡을 일과 보고 기준을 적어 주세요.">${esc(agent.instructions)}</textarea></label><label class="check-label"><input type="checkbox" name="enabled" ${agent.enabled ? 'checked' : ''} ${['main', 'prompt_refiner'].includes(id) ? 'disabled' : ''}>팀원 활성화</label>`;
    $('#editor-fields').querySelector('label.check-label').insertAdjacentHTML('beforebegin', `<label>AI 모니터가 추가한 운영 지침<textarea name="optimizationGuidance" maxlength="400" placeholder="운영 점검 후 필요한 경우에만 저장됩니다.">${esc(agent.optimizationGuidance || '')}</textarea><small>기본 작업 지침과 별도로 저장됩니다. 여기서 수정하거나 지울 수 있습니다.</small></label>`);
    $('#agent-preset')?.addEventListener('change', event => applyRolePreset(event.target.value));
    $('#agent-model').addEventListener('change', syncEffortControl);
    $('#effort-range').addEventListener('input', setEffortFromSlider);
    $('#reset-effort').addEventListener('click', () => { $('#editor-form').elements.effort.value = 'high'; syncEffortControl(); });
    syncEffortControl();
  } else {
    const item = state.projects.find(item => item.id === id) || { name:'',path:'',allowWrites:false };
    $('#editor-title').textContent = id ? '프로젝트 설정' : '프로젝트 연결';
    $('#editor-fields').innerHTML = `<label>프로젝트 이름<input name="name" value="${esc(item.name)}" maxlength="80" placeholder="예: 나의 웹사이트" required></label><div class="path-field"><label for="project-folder-path">이 PC의 폴더 경로</label><div class="path-picker"><input id="project-folder-path" name="path" value="${esc(item.path)}" placeholder="C:\\work\\my-project" required><button class="button secondary" id="browse-project" type="button">${icon('folder')}폴더 찾아보기</button></div><small>폴더 찾아보기로 프로젝트 폴더를 선택하거나 경로를 직접 입력하세요.</small></div><label class="check-label"><input type="checkbox" name="allowWrites" ${item.allowWrites ? 'checked' : ''}>실행 담당 에이전트의 파일 수정 허용</label><label class="check-label"><input type="checkbox" name="autoApproveCommands" ${item.autoApproveCommands ? 'checked' : ''}>이 프로젝트에서 명령 자동 실행</label><p class="muted">자동 실행을 켜면 수정 담당은 프로젝트 내부 명령을 매번 묻지 않고 실행합니다. 읽기 전용 담당의 명령은 자동 검토합니다. 프로젝트 밖 파일과 네트워크 제한은 유지되며, 범위를 벗어난 작업은 실패하거나 확인이 필요할 수 있습니다.</p><p class="muted">프로젝트 자료는 각 요청에 필요한 부분만 읽습니다. 메인 AI와 검증 담당은 읽기 전용으로 실행됩니다.</p>`;
  }
  $('#editor').showModal();
}
function openSkillEditor(id) {
  if (state.activeRunId) return toast('진행 중인 요청이 끝난 뒤 스킬을 변경해 주세요.', true);
  skillEditorId = id || '';
  const skill = (state.skills || []).find(item => item.id === id) || { name:'', description:'', instructions:'', agentIds:[], enabled:true };
  $('#skill-editor-title').textContent = id ? '스킬 편집' : '재사용 스킬 만들기';
  $('#skill-error').textContent = '';
  $('#delete-skill').classList.toggle('hidden', !id);
  const eligible = state.agents.filter(agent => !['main','prompt_refiner'].includes(agent.id));
  $('#skill-fields').innerHTML = `<label>스킬 이름<input name="name" value="${esc(skill.name)}" maxlength="80" placeholder="예: API 변경 검증" required></label><label>한 줄 설명<input name="description" value="${esc(skill.description)}" maxlength="300" placeholder="어떤 반복 절차를 담는지 적어 주세요." required></label><label>스킬 지침<textarea name="instructions" maxlength="4000" required placeholder="이 스킬이 선택된 에이전트가 따를 구체적인 절차를 적어 주세요.">${esc(skill.instructions)}</textarea><small>반복 절차와 전문 기준을 적으세요. 권한이나 공통 보호 규칙은 바꾸지 않습니다.</small></label><fieldset class="skill-agent-picker"><legend>이 스킬을 사용할 에이전트</legend><div>${eligible.map(agent => `<label class="check-label"><input type="checkbox" name="agentIds" value="${esc(agent.id)}" ${skill.agentIds.includes(agent.id) ? 'checked' : ''}>${esc(agent.name)} <small>${esc(agent.role)}</small></label>`).join('')}</div></fieldset><label class="check-label"><input type="checkbox" name="enabled" ${skill.enabled ? 'checked' : ''}>스킬 활성화</label>`;
  $('#skill-editor').showModal();
}
function renderDetail() {
  const run = state.runs.find(item => item.id === selectedRunId); if (!run) return;
  const gate = run.qualityGate || { required:false,status:'not_required',reason:'이전 실행에는 검증 게이트 기록이 없습니다.' };
  const gateLabel = { pending:'검증 대기',passed:'검증 통과',failed:'검증 실패',needs_review:'검토 필요',not_required:'변경 검증 불필요' }[gate.status] || '확인 필요';
  const gateTone = gate.status === 'passed' ? 'passed' : ['failed','needs_review'].includes(gate.status) ? 'needs-review' : 'pending';
  const nonMain = run.tasks.filter(task => !task.consultation && !['main', 'prompt_refiner'].includes(task.agentId));
  const workStatus = nonMain.some(task => ['queued','working','waiting'].includes(task.status)) ? '진행 중' : nonMain.some(task => task.status === 'failed') ? '실패 확인' : nonMain.length ? '완료' : '필요 없음';
  const reportStatus = ['running','stopping'].includes(run.status) ? '작성 중' : run.answer ? '완료' : '확인 필요';
  $('#detail-content').innerHTML = `<div class="run-status-line">${badge(run.status)}<span>${date(run.startedAt)} · ${format(run.usage.totalTokens)} tokens · ${esc(run.projectName)}</span></div><div class="detail-workflow" aria-label="작업 흐름"><div><small>1단계</small><b>요청 분석</b><span>${run.tasks.some(task => task.agentId === 'main') ? '기록됨' : '대기'}</span></div><i>›</i><div><small>2단계</small><b>팀 작업</b><span>${esc(workStatus)}</span></div><i>›</i><div class="${gateTone}"><small>3단계</small><b>검증</b><span>${esc(gateLabel)}</span></div><i>›</i><div><small>4단계</small><b>최종 보고</b><span>${esc(reportStatus)}</span></div></div><section class="quality-gate ${gateTone}"><div><strong>품질 확인</strong><span>${gate.required ? '파일을 변경한 작업은 체커의 판정을 확인합니다.' : '파일을 변경하지 않은 읽기 전용 작업입니다.'}</span></div><b>${esc(gateLabel)}</b><p>${esc(gate.reason || '검증 판정이 아직 없습니다.')}</p></section><div class="detail-prompt"><strong>사용자 원문</strong><p>${esc(run.message)}</p>${runImages(run)}</div>${refinementSummary(run)}${run.tasks.map(task => `<article class="detail-task"><div class="detail-task-header"><div><h3>${esc(task.agentName)} · ${esc(task.title)}</h3><small>${task.startedAt ? clock(task.startedAt) : '대기'}${task.finishedAt ? ` → ${clock(task.finishedAt)}` : ''} · ${format(task.usage?.totalTokens)} tokens${task.writable ? ' · 파일 수정 권한 사용' : ''}</small></div>${badge(task.status)}</div>${task.plan?.length ? `<p class="muted">${task.plan.map(item => `${item.status === 'completed' ? '✓' : '○'} ${esc(item.step)}`).join('<br>')}</p>` : ''}<div class="detail-output">${esc(task.output || task.liveText || '작업 시작을 기다리고 있어요.')}</div>${task.error ? `<p class="error-text">${esc(task.error)}</p>` : ''}</article>`).join('')}${run.error ? `<p class="error-text">${esc(run.error)}</p>` : ''}`;
  $('#detail-content').querySelector('.run-status-line').insertAdjacentHTML('afterend', runDiagnostics(run));
  const discussions = run.discussions || [];
  if (discussions.length) {
    const markup = `<section class="discussion-section"><h3>팀원 간 협의 · ${discussions.length}건</h3>${discussions.map(item => `<article class="discussion-card"><div class="discussion-heading"><strong>${esc(item.fromName)} → ${esc(item.toName)}</strong><span>${item.status === 'completed' ? '답변 완료' : item.status === 'pending' ? '답변 중' : '답변 실패'} · ${clock(item.createdAt)}</span></div><p class="discussion-question">${esc(item.question)}</p>${item.context ? `<p class="discussion-context">맥락: ${esc(item.context)}</p>` : ''}${item.answer ? `<div class="discussion-answer"><b>${esc(item.toName)}의 답변</b><p>${esc(item.answer)}</p></div>` : ''}${item.error ? `<p class="error-text">${esc(item.error)}</p>` : ''}</article>`).join('')}</section>`;
    const firstTask = $('#detail-content').querySelector('.detail-task');
    if (firstTask) firstTask.insertAdjacentHTML('beforebegin', markup);
    else $('#detail-content').insertAdjacentHTML('beforeend', markup);
  }
  $('#detail-content').querySelectorAll('.detail-task-header').forEach((header,index) => {
    const handoffs = run.tasks[index]?.handoffFrom || [];
    if (handoffs.length) header.insertAdjacentHTML('afterend', `<div class="detail-handoff">인계받음: ${handoffs.map(source => esc(source.agentName)).join(', ')} · 선행 보고 ${handoffs.length}개</div>`);
  });
}

const monitoringPrompt = 'AI 모니터링 에이전트에게 이 프로젝트의 최근 작업 흐름과 사용량을 점검시켜 줘. 중복되거나 불필요한 위임, 반복 실패가 실제 기록으로 확인될 때만 짧은 운영 지침을 해당 에이전트에 저장해 줘. 개선 근거가 없으면 변경하지 말고 그 이유를 알려줘.';
document.addEventListener('click', async event => {
  const button = event.target.closest('button'); if (!button) return;
  if (button.dataset.view) changeView(button.dataset.view);
  if (button.dataset.editAgent) openEditor('agent',button.dataset.editAgent);
  if (button.dataset.editProject) openEditor('project',button.dataset.editProject);
  if (button.dataset.editSkill) openSkillEditor(button.dataset.editSkill);
  if (button.dataset.project) { selectProject(button.dataset.project); changeView('overview'); }
  if (button.hasAttribute('data-monitor-request')) { changeView('overview'); $('#message').value = monitoringPrompt; resizeMessageInput(); $('#message').focus(); }
  if (button.dataset.prompt) { changeView('overview'); $('#message').value = button.dataset.prompt; resizeMessageInput(); $('#message').focus(); }
  if (button.dataset.detail) { selectedRunId = button.dataset.detail; renderDetail(); $('#detail').showModal(); }
  if (button.dataset.resume) {
    button.disabled = true;
    try {
      const oldRun = state.runs.find(run => run.id === button.dataset.resume);
      const additionalUsagePercent = Number(button.dataset.resumeExtra || 0);
      if (additionalUsagePercent) {
        await api('usage-limits/refresh',{});
        await refresh();
        const currentPlan = quotaResumePlan(oldRun);
        if (currentPlan?.additional !== additionalUsagePercent) throw new Error('계정 사용률이 바뀌어 필요한 추가량이 달라졌습니다. 새로 표시된 버튼을 확인해 주세요.');
      }
      await api('runs/resume', { id: button.dataset.resume, additionalUsagePercent });
      if ($('#detail').open) $('#detail').close();
      if (oldRun) selectProject(oldRun.projectId);
      changeView('overview'); await refresh(); toast(additionalUsagePercent ? `이번 작업의 한도를 ${additionalUsagePercent}%p 높여 이어서 실행합니다.` : '이전 작업을 이어서 실행합니다.');
    } catch (error) { await refresh().catch(() => {}); toast(error.message, true); button.disabled = false; }
  }
  if (button.dataset.decline) { try { await api('approvals',{ id:button.dataset.decline, allow:false }); } catch(error) { toast(error.message,true); } }
  if (button.dataset.allowSession) { try { await api('approvals',{ id:button.dataset.allowSession, allow:true, scope:'session' }); toast('현재 팀원 실행에서 허용했습니다.'); } catch(error) { toast(error.message,true); } }
  if (button.dataset.allowAllApprovals) {
    const enabled = button.dataset.allowAllApprovals === 'true';
    button.disabled = true;
    try {
      const result = await api('approvals/allow-all',{ enabled });
      toast(enabled ? `이번 요청의 대기 중인 실행 승인 ${result.approved}건을 처리했고, 이어지는 실행 승인도 자동 허용합니다.` : '이후 실행 승인부터 직접 확인합니다. 이미 허용한 작업은 취소되지 않습니다.');
    } catch(error) { toast(error.message,true); button.disabled = false; }
  }
});
$('#project-select').addEventListener('change',event => selectProject(event.target.value));
$('#project-permission').addEventListener('click',() => openEditor('project',selectedProject));
for (const selector of ['#add-project','#new-project']) $(selector).addEventListener('click',() => openEditor('project'));
$('#new-agent').addEventListener('click',() => openEditor('agent'));
$('#new-skill').addEventListener('click',() => openSkillEditor());
for (const selector of ['#close-editor','#cancel-editor']) $(selector).addEventListener('click',() => $('#editor').close());
for (const selector of ['#close-skill-editor','#cancel-skill-editor']) $(selector).addEventListener('click',() => $('#skill-editor').close());
$('#close-detail').addEventListener('click',() => $('#detail').close());
$('#history-filter').addEventListener('change',renderHistory);
const resizeMessageInput = () => {
  const input = $('#message');
  input.style.height = 'auto';
  const maxHeight = 360;
  input.style.height = `${Math.min(Math.max(input.scrollHeight, 136), maxHeight)}px`;
  input.style.overflowY = input.scrollHeight > maxHeight ? 'auto' : 'hidden';
};
$('#message').addEventListener('input', resizeMessageInput);
resizeMessageInput();
$('#message').addEventListener('keydown',event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); if (!state?.activeRunId) $('#chat-form').requestSubmit(); } });
$('#message').addEventListener('paste', async event => {
  const files = [...(event.clipboardData?.items || [])].filter(item => item.kind === 'file' && item.type.startsWith('image/')).map(item => item.getAsFile()).filter(Boolean);
  if (!files.length) return;
  event.preventDefault();
  const text = event.clipboardData.getData('text/plain');
  if (text) $('#message').setRangeText(text, $('#message').selectionStart, $('#message').selectionEnd, 'end');
  try { await addImages(files); } catch (error) { toast(error.message, true); }
});
$('#attach-image').addEventListener('click', () => $('#image-input').click());
$('#image-input').addEventListener('change', async event => {
  try { await addImages(event.target.files || []); } catch (error) { toast(error.message, true); }
  event.target.value = '';
});
$('#refine-prompt').addEventListener('change', event => { localStorage.setItem('agent-desk-refine', String(event.target.checked)); if (state) renderFlow(); });
$('#chat-form').addEventListener('submit',async event => {
  event.preventDefault(); const message = $('#message').value.trim();
  if (!message && !draftImages.length) return toast('요청 문장이나 이미지를 입력해 주세요.', true);
  if (state.activeRunId || pendingImageReads || sendingRequest) return;
  sendingRequest = true; render();
  try { await api('runs',{ projectId:selectedProject, message, images:draftImages.map(image => image.dataUrl), refinePrompt:$('#refine-prompt').checked }); $('#message').value = ''; resizeMessageInput(); draftImages = []; renderDraftImages(); await refresh(); }
  catch(error) { toast(error.message,true); } finally { sendingRequest = false; render(); }
});
$('#stop').addEventListener('click',async () => { try { $('#stop').disabled = true; await api('cancel',{ id:state.activeRunId }); toast('중단을 요청했습니다.'); } catch(error) { toast(error.message,true); } finally { $('#stop').disabled = false; } });
$('#editor-form').addEventListener('submit',async event => {
  event.preventDefault(); const form = event.currentTarget; const input = Object.fromEntries(new FormData(form));
  if (editorId) input.id = editorId;
  if (editorType === 'agent') { input.enabled = ['main', 'prompt_refiner'].includes(editorId) || form.elements.enabled.checked; input.access = ['main', 'prompt_refiner'].includes(editorId) ? 'read-only' : form.elements.access.value; }
  else { input.allowWrites = form.elements.allowWrites.checked; input.autoApproveCommands = form.elements.autoApproveCommands.checked; }
  const submit = form.querySelector('[type="submit"]'); submit.disabled = true;
  try { const result = await api(editorType === 'agent' ? 'agents' : 'projects',input); if (editorType === 'project') selectedProject = result.id; $('#editor').close(); await refresh(); toast('저장했습니다.'); }
  catch(error) { $('#editor-error').textContent = error.message; } finally { submit.disabled = false; }
});
$('#skill-form').addEventListener('submit',async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const input = Object.fromEntries(new FormData(form));
  input.agentIds = new FormData(form).getAll('agentIds');
  input.enabled = form.elements.enabled.checked;
  if (skillEditorId) input.id = skillEditorId;
  const submit = form.querySelector('[type="submit"]'); submit.disabled = true;
  try { await api('skills', input); $('#skill-editor').close(); await refresh(); toast('스킬을 저장했습니다.'); }
  catch(error) { $('#skill-error').textContent = error.message; }
  finally { submit.disabled = false; }
});
$('#delete-skill').addEventListener('click',async () => {
  try { await api('skills/delete', { id:skillEditorId }); $('#skill-editor').close(); await refresh(); toast('스킬을 삭제했습니다.'); }
  catch(error) { $('#skill-error').textContent = error.message; }
});
$('#editor-fields').addEventListener('click', async event => {
  const button = event.target.closest('#browse-project');
  if (!button) return;
  button.disabled = true;
  $('#editor-error').textContent = '';
  try {
    const result = await api('projects/browse', { path:$('#editor-form').elements.path.value || project()?.path || '' });
    if (result.path) $('#editor-form').elements.path.value = result.path;
  } catch (error) { $('#editor-error').textContent = error.message; }
  finally { button.disabled = false; }
});
$('#delete-agent').addEventListener('click',async () => { try { await api('agents/delete',{ id:editorId }); $('#editor').close(); await refresh(); toast('에이전트를 삭제했습니다.'); } catch(error) { $('#editor-error').textContent = error.message; } });
$('#settings-form').addEventListener('submit',async event => {
  event.preventDefault();
  try { await api('settings',Object.fromEntries(new FormData(event.currentTarget))); settingsPopulated = false; await refresh(); toast('실행 설정을 저장했습니다.'); } catch(error) { toast(error.message,true); }
});
$('#approval-list').addEventListener('submit',async event => { event.preventDefault(); const form = event.target; try { await api('approvals',{ id:form.dataset.approval, allow:true, answers:Object.fromEntries(new FormData(form)) }); } catch(error) { toast(error.message,true); } });
$('#reconnect').addEventListener('click',async () => { const button = $('#reconnect'); button.disabled = true; try { await api('reconnect',{}); await refresh(); toast(state.connection.message,state.connection.status !== 'connected'); } catch(error) { toast(error.message,true); } finally { button.disabled = false; } });
$('#usage-refresh').addEventListener('click', async () => {
  const button = $('#usage-refresh'); button.disabled = true;
  try { state.usageLimits = await api('usage-limits/refresh', {}); renderUsageLimits(); }
  catch (error) { toast(error.message, true); }
  finally { button.disabled = false; }
});
async function refresh() { const response = await fetch('/api/state',{ cache:'no-store' }); if (!response.ok) throw new Error('서버에 연결할 수 없습니다.'); const result = await response.json(); csrf = result.csrf; state = result; render(); }
try {
  await refresh();
  const events = new EventSource('/api/events');
  events.addEventListener('state',event => { state = JSON.parse(event.data); render(); });
  events.onerror = () => { $('#connection').className = 'connection error'; $('#connection').innerHTML = '<i></i>서버 재연결 중'; $('#send').disabled = true; };
  events.onopen = () => refresh().catch(() => {});
} catch(error) { toast('서버 연결에 실패했습니다. 시작 스크립트가 실행 중인지 확인해 주세요.',true); }
