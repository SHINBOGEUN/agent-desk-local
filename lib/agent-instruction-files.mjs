import fs from 'node:fs';
import path from 'node:path';

const marker = '<!-- agent-instructions:start -->';

export class AgentInstructionFiles {
  constructor({ builtInDirectory, localDirectory, builtInAgentIds = [] }) {
    this.builtInDirectory = path.resolve(builtInDirectory);
    this.localDirectory = path.resolve(localDirectory);
    this.builtInAgentIds = new Set(builtInAgentIds);
  }

  fileFor(agent) {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(String(agent?.id || ''))) throw new Error('에이전트 ID가 Markdown 파일명 형식에 맞지 않습니다.');
    const directory = this.builtInAgentIds.has(agent.id) ? this.builtInDirectory : this.localDirectory;
    const file = path.resolve(directory, `${agent.id}.md`);
    if (!file.startsWith(`${directory}${path.sep}`)) throw new Error('에이전트 지침 파일 경로가 저장 폴더를 벗어납니다.');
    return file;
  }

  read(agent, fallback = '') {
    const file = this.fileFor(agent);
    if (!fs.existsSync(file)) return String(fallback || '').trim();
    const contents = fs.readFileSync(file, 'utf8');
    const markerIndex = contents.indexOf(marker);
    const body = markerIndex >= 0 ? contents.slice(markerIndex + marker.length) : contents;
    const instructions = body.trim();
    return instructions || String(fallback || '').trim();
  }

  exists(agent) { return fs.existsSync(this.fileFor(agent)); }

  write(agent) {
    const instructions = String(agent.instructions || '').trim();
    if (!instructions) throw new Error(`${agent.name || agent.id}의 Markdown 지침이 비어 있습니다.`);
    const file = this.fileFor(agent);
    const directory = path.dirname(file);
    fs.mkdirSync(directory, { recursive: true });
    if (fs.existsSync(file) && this.read(agent) === instructions) return file;
    const heading = `# ${String(agent.name || 'Agent').replace(/[\r\n#]/g, ' ').trim()} · ${String(agent.role || '').replace(/[\r\n#]/g, ' ').trim()}`;
    const contents = `${heading}\n\n${marker}\n${instructions}\n`;
    const temporary = `${file}.tmp`;
    fs.writeFileSync(temporary, contents, 'utf8');
    for (let attempt = 0; ; attempt++) {
      try { fs.renameSync(temporary, file); break; }
      catch (error) {
        if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || attempt >= 5) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (attempt + 1));
      }
    }
    return file;
  }

  removeCustom(agent) {
    if (this.builtInAgentIds.has(agent.id)) return;
    fs.rmSync(this.fileFor(agent), { force: true });
  }
}
