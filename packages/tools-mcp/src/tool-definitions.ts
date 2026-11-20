// The harness tools every runtime sees. One definition, used by the stdio MCP
// server (tools/list) and by tests. The model never delegates work through
// these tools; they only hand results and questions back to the harness.

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const TOOL_NAMES = ['submit_report', 'request_user_input', 'read_history', 'read_notes', 'approve'] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export const TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  {
    name: 'submit_report',
    description:
      'Submit the structured result of this step to the Agent Desk harness. Call it exactly once, as the last thing you do. '
      + 'Pass the report object exactly as the step instructions describe it. If the harness answers that the report was rejected, '
      + 'fix the listed fields and call this tool again with the complete corrected report.',
    // Field types are declared so clients pass lists as real arrays (an empty schema made Claude Code send them as strings).
    // Which fields a step needs is stated in the step instructions; the harness validates the rest.
    inputSchema: {
      type: 'object',
      properties: {
        workflow: { type: 'string' }, reason: { type: 'string' }, answer: { type: 'string' }, summary: { type: 'string' },
        verdict: { type: 'string' }, approach: { type: 'string' }, angle: { type: 'string' },
        requirements: { type: 'array', items: { type: 'object' } },
        sources: { type: 'array', items: { type: 'string' } },
        changedFiles: { type: 'array', items: { type: 'string' } },
        commandsRun: { type: 'array', items: { type: 'object' } },
        unverified: { type: 'array', items: { type: 'string' } },
        memorySuggestions: { type: 'array', items: { type: 'string' } },
        blocking: { type: 'array', items: { type: 'object' } },
        optional: { type: 'array', items: { type: 'string' } },
        steps: { type: 'array', items: { type: 'string' } },
        files: { type: 'array', items: { type: 'string' } },
        risks: { type: 'array', items: { type: 'string' } },
        findings: { type: 'array', items: { type: 'object' } },
      },
      additionalProperties: true,
    },
  },
  {
    name: 'request_user_input',
    description:
      'Ask the user one question when the task cannot continue without information only they have '
      + '(an unclear target, a missing credential, a choice between valid options). Do not use it to ask permission for ordinary work.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'One concrete question.' },
        options: { type: 'array', items: { type: 'string' }, description: 'Optional answers to choose from.' },
      },
      required: ['question'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_history',
    description:
      'Read details of an earlier run in this project (its request, result, changed files, requirements and review). '
      + 'Give "runId" from the history in your instructions, or "search" with a word from the earlier request. Use it only when the summary is not enough.',
    inputSchema: {
      type: 'object',
      properties: {
        runId: { type: 'number', description: 'Run number, as shown in the history (#12 -> 12).' },
        search: { type: 'string', description: 'Words to find in earlier requests, results and reviews (plain text match). Give Korean and English forms together, e.g. "로그인 login", or a file name.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'read_notes',
    description:
      'Read the project notes the user keeps (specs of what to build, approved decisions with their reasons). '
      + 'Give "path" from the notes list in your instructions to read one note, or "search" with words to find notes. Use it when the request refers to a spec or a rule you have not seen.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Note path as listed, e.g. "specs/Login.md".' },
        search: { type: 'string', description: 'Words to find in note titles and text. Give Korean and English forms together, e.g. "마감일 due date".' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'approve',
    description:
      'Permission prompt for runtimes that delegate approvals to the harness. Not meant to be called by the model itself.',
    inputSchema: {
      type: 'object',
      properties: {
        tool_name: { type: 'string' },
        input: { type: 'object', additionalProperties: true },
        tool_use_id: { type: 'string' },
      },
      required: ['tool_name', 'input'],
      additionalProperties: true,
    },
  },
];
