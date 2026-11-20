// Korean for messages the server writes in English: project file checks (config, role files,
// skills), memory checks and skill lint findings. Lines may start with where the problem is
// ("builder-skill: ", ".agent-desk/agents/lead.md: ", "entry 2: "); that part is kept as it is.
// Messages not listed here are shown unchanged.

type Rule = [RegExp, (m: RegExpMatchArray) => string];

const RULES: Rule[] = [
  // memory
  [/^same as entry (\d+)$/, m => `${m[1]}번 항목과 같습니다.`],
  [/^entry (\d+)$/, m => `${m[1]}번 항목`],
  [/^the fact is empty$/, () => '내용이 비어 있습니다.'],
  [/^a memory entry is at most (\d+) characters; this one has (\d+)$/, m => `메모 한 항목은 ${m[1]}자까지입니다. 이 항목은 ${m[2]}자입니다.`],
  [/^this looks like a secret; memory is committed to git, so do not store secrets in it$/, () => '비밀번호나 키처럼 보입니다. 메모는 git에 올라가므로 비밀값을 넣지 마세요.'],
  [/^already in memory$/, () => '이미 메모에 있습니다.'],
  [/^memory would exceed (\d+) characters \(now (\d+)\); remove an old entry in (.+) first$/, m => `메모가 ${m[1]}자를 넘게 됩니다(지금 ${m[2]}자). 설정의 메모 탭에서 오래된 항목을 먼저 지우세요.`],
  [/^memory would be (\d+) characters; the limit is (\d+)$/, m => `메모가 ${m[1]}자가 됩니다. 한도는 ${m[2]}자입니다.`],
  [/^facts must be a list of strings$/, () => '메모 목록 형식이 올바르지 않습니다.'],
  // files
  [/^the file is too large \(over 200 KB\)$/, () => '파일이 너무 큽니다(200KB 초과).'],
  [/^not valid JSON: (.+)$/, m => `JSON 형식이 올바르지 않습니다: ${m[1]}`],
  [/^unknown role "(.+)"$/, m => `알 수 없는 역할입니다: "${m[1]}"`],
  [/^skill id must be lowercase letters, digits and hyphens \(up to 64\)$/, () => '스킬 이름은 소문자, 숫자, 하이픈만 쓸 수 있습니다(64자까지).'],
  [/^(.+) still list "(.+)"; remove it from those role files first$/, m => `${m[1]}에 아직 "${m[2]}"가 들어 있습니다. 그 역할 파일에서 먼저 빼세요.`],
  [/^unknown file kind$/, () => '알 수 없는 파일 종류입니다.'],
  [/^skill "(.+)" does not exist in \.agent-desk\/skills\/$/, m => `스킬 "${m[1]}"이(가) .agent-desk/skills/에 없습니다.`],
  [/^kind must be config, role or skill$/, () => '파일 종류는 config, role, skill 중 하나여야 합니다.'],
  // config.json
  [/^(config\.\S+): unknown key$/, m => `${m[1]}: 알 수 없는 항목입니다.`],
  [/^config\.mode: expected one of (.+)$/, m => `config.mode: 다음 중 하나여야 합니다: ${m[1]}`],
  [/^config\.mode and config\.runtimes both set; keep one$/, () => 'config.mode와 config.runtimes가 둘 다 있습니다. 하나만 남기세요.'],
  [/^config\.runtimes: expected an object like (.+)$/, m => `config.runtimes: ${m[1]} 같은 객체여야 합니다.`],
  [/^(config\.runtimes\.\S+): unknown name \(use "primary" or "review"\)$/, m => `${m[1]}: 알 수 없는 이름입니다("primary" 또는 "review").`],
  [/^(config\.runtimes\.\S+): expected "codex", "claude" or "fake"$/, m => `${m[1]}: "codex", "claude", "fake" 중 하나여야 합니다.`],
  [/^config\.roles: expected an object$/, () => 'config.roles: 객체여야 합니다.'],
  [/^(config\.roles\.\S+): unknown role$/, m => `${m[1]}: 알 수 없는 역할입니다.`],
  [/^(config\.roles\.\S+): expected an object$/, m => `${m[1]}: 객체여야 합니다.`],
  [/^(config\.roles\.\S+): unknown key \(access, effort and skills belong in (.+)\)$/, m => `${m[1]}: 알 수 없는 항목입니다. access, effort, skills는 ${m[2]}에 씁니다.`],
  [/^(config\.roles\.\S+\.runtime): expected "primary" or "review"$/, m => `${m[1]}: "primary" 또는 "review"여야 합니다.`],
  [/^config\.skills: expected a list of skill ids$/, () => 'config.skills: 스킬 이름 목록이어야 합니다.'],
  [/^config\.verify: expected a list of non-empty command strings$/, () => 'config.verify: 비어 있지 않은 명령 목록이어야 합니다.'],
  [/^config\.ignore: expected a list of path patterns$/, () => 'config.ignore: 경로 패턴 목록이어야 합니다.'],
  [/^config\.allowCommands: expected a list of command prefixes$/, () => 'config.allowCommands: 명령 앞부분 목록이어야 합니다.'],
  [/^config\.review: expected "always", "auto", "never" or "self"$/, () => 'config.review: "always", "auto", "never", "self" 중 하나여야 합니다.'],
  [/^config\.language: expected "en" or "ko"$/, () => 'config.language: "en" 또는 "ko"여야 합니다.'],
  [/^config\.limits: expected an object$/, () => 'config.limits: 객체여야 합니다.'],
  [/^(config\.limits\.\S+): expected a (non-negative|0-100|positive) number$/, m => `${m[1]}: ${m[2] === 'non-negative' ? '0 이상의' : m[2] === '0-100' ? '0~100 사이의' : '양의'} 숫자여야 합니다.`],
  // role files
  [/^frontmatter is not closed with "---"$/, () => '머리말(frontmatter)이 "---"로 닫히지 않았습니다.'],
  [/^cannot read frontmatter line "(.+)"$/, m => `머리말 줄을 읽을 수 없습니다: "${m[1]}"`],
  [/^unknown frontmatter key "(.+)"$/, m => `알 수 없는 머리말 항목입니다: "${m[1]}"`],
  [/^skills must be a list$/, () => 'skills는 목록이어야 합니다.'],
  [/^(\S+) must be a single value$/, m => `${m[1]}는 값 하나여야 합니다.`],
  [/^access must be "read-only" or "workspace-write"$/, () => 'access는 "read-only" 또는 "workspace-write"여야 합니다.'],
  [/^the (\S+) role is read-only; a file cannot grant write access$/, m => `${m[1]} 역할은 읽기 전용이라 파일에서 쓰기 권한을 줄 수 없습니다.`],
  [/^effort must be "low", "medium" or "high"$/, () => 'effort는 "low", "medium", "high" 중 하나여야 합니다.'],
  [/^No role file for (.+) in \.agent-desk\/agents\/; built-in defaults are used\. Run "agent-desk init" to create them\.$/, m => `${m[1]} 역할 파일이 .agent-desk/agents/에 없어 기본값을 씁니다. 설정의 "초안 만들기"로 만들 수 있습니다.`],
  [/^repeats what the harness already tells this role \((.+)\); keep only rules specific to this project$/, m => `하네스가 이미 이 역할에 알려 주는 내용(${m[1]})을 반복합니다. 이 프로젝트에만 해당하는 규칙만 남기세요.`],
  [/^(\d+) lines of project rules are sent on every turn of this role; move long procedures into a skill so they are read only when needed$/, m => `프로젝트 규칙 ${m[1]}줄이 이 역할의 매 호출에 들어갑니다. 긴 절차는 스킬로 옮겨 필요할 때만 읽게 하세요.`],
  [/^absolute rules without a reason; say why so the model can judge edge cases$/, () => '이유 없는 절대 규칙이 있습니다. 이유를 적어야 모델이 예외 상황을 판단할 수 있습니다.'],
  // skills
  [/^folder name must be lowercase letters, digits and hyphens$/, () => '폴더 이름은 소문자, 숫자, 하이픈만 쓸 수 있습니다.'],
  [/^missing SKILL\.md \(the file must be named exactly SKILL\.md\)$/, () => 'SKILL.md가 없습니다(파일 이름이 정확히 SKILL.md여야 합니다).'],
  [/^SKILL\.md: (.+)$/, m => `SKILL.md: ${translateLine(m[1]!)}`],
  [/^"(.+)" is read by Claude Code only; Codex ignores it$/, m => `"${m[1]}"는 Claude Code만 읽고 Codex는 무시합니다.`],
  [/^frontmatter needs "(name|description)"$/, m => `머리말에 "${m[1]}"가 필요합니다.`],
  [/^name "(.+)" must match the folder name "(.+)"$/, m => `name "${m[1]}"이(가) 폴더 이름 "${m[2]}"와 같아야 합니다.`],
  [/^description is very short; say what the skill does and when to use it$/, () => 'description이 너무 짧습니다. 스킬이 하는 일과 쓸 때를 적으세요.'],
  [/^description is over 600 characters; it is loaded into every session, so keep it tight$/, () => 'description이 600자를 넘습니다. 모든 세션에 들어가니 짧게 줄이세요.'],
  [/^description has no action verb that says what the skill does$/, () => 'description에 스킬이 하는 일을 말하는 동사가 없습니다.'],
  [/^description does not say when to use the skill/, () => 'description에 언제 쓰는지(예: "사용자가 ~를 요청할 때")가 없습니다.'],
  [/^description does not say when NOT to use it/, () => 'description에 쓰지 말아야 할 때가 없습니다. 제외 조건이 없으면 모델이 스킬을 건너뛰거나 과하게 씁니다.'],
  [/^SKILL\.md has no body$/, () => 'SKILL.md 본문이 비어 있습니다.'],
  [/^body is (\d+) lines; move detail into references\/ files that the body points to$/, m => `본문이 ${m[1]}줄입니다. 세부 내용은 references/ 파일로 옮기고 본문에서 가리키세요.`],
  [/^(\d+) absolute rules \(ALWAYS\/NEVER\/MUST\/반드시\/절대\) with no stated reason/, m => `이유 없는 절대 규칙(ALWAYS/NEVER/MUST/반드시/절대)이 ${m[1]}개 있습니다. 이유를 적어야 모델이 예외 상황을 판단할 수 있습니다.`],
  [/^body switches on (\d+) kinds of request but has no references\/ files/, m => `본문이 요청 종류 ${m[1]}가지로 나뉘는데 references/ 파일이 없습니다. SKILL.md에는 짧은 안내만 두고 경우별 내용은 references/로 옮기세요.`],
  [/^triggers\.json is not valid JSON$/, () => 'triggers.json의 JSON 형식이 올바르지 않습니다.'],
  [/^triggers\.json "(.+)" has (\d+) case\(s\); 8 to 10 give a usable hit rate$/, m => `triggers.json "${m[1]}"의 사례가 ${m[2]}개입니다. 8~10개는 있어야 적중률을 볼 수 있습니다.`],
  [/^triggers\.json "(.+)" is all (Korean|non-Korean); add cases in the other language/, m => `triggers.json "${m[1]}"이(가) 모두 ${m[2] === 'Korean' ? '한국어' : '한국어가 아닌 말'}입니다. 다른 언어 사례도 넣으세요.`],
  [/^body refers to "(.+)" which does not exist$/, m => `본문이 가리키는 "${m[1]}"이(가) 없습니다.`],
  [/^"(.+)" is never mentioned in SKILL\.md, so it would never be read$/, m => `"${m[1]}"이(가) SKILL.md에 언급되지 않아 읽히지 않습니다.`],
  [/^config\.skills lists "(.+)" but (.+) does not exist$/, m => `config.skills에 "${m[1]}"이(가) 있지만 ${m[2]}이(가) 없습니다.`],
  [/^(.+) lists skill "(.+)" which does not exist$/, m => `${m[1]}에 있는 스킬 "${m[2]}"이(가) 없습니다.`],
  [/^exists but is not listed in config\.skills, so it is not used$/, () => '있지만 config.skills에 없어서 쓰이지 않습니다.'],
  [/^description is identical to "(.+)"; the model cannot tell them apart$/, m => `description이 "${m[1]}"와 같아 모델이 둘을 구분할 수 없습니다.`],
  [/^descriptions add up to (\d+) characters; every session pays for them on every turn$/, m => `description을 합치면 ${m[1]}자입니다. 모든 세션의 매 호출에 들어갑니다.`],
];

function translateLine(line: string): string {
  for (const [pattern, build] of RULES) {
    const match = line.match(pattern);
    if (match) return build(match);
  }
  return line;
}

/**
 * A server message in Korean, or the message unchanged when no rule knows it.
 * "where: message" lines keep the "where" part (it can itself hold ": ", as in "role:builder").
 */
export function koServerText(line: string): string {
  const whole = translateLine(line);
  if (whole !== line) return whole;
  for (let at = line.indexOf(': '); at >= 0; at = line.indexOf(': ', at + 2)) {
    const head = line.slice(0, at);
    const rest = line.slice(at + 2);
    const translated = translateLine(rest);
    if (translated !== rest) return `${translateLine(head)}: ${translated}`;
  }
  return line;
}
