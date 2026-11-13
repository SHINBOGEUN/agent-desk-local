// The harness tools every runtime sees. One definition, used by the stdio MCP
// server (tools/list) and by tests. The model never delegates work through
// these tools; they only hand results and questions back to the harness.

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const TOOL_NAMES = ['submit_report', 'request_user_input', 'approve'] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export const TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  {
    name: 'submit_report',
    description:
      'Submit the structured result of this step to the Agent Desk harness. Call it exactly once, as the last thing you do. '
      + 'Pass the report object exactly as the step instructions describe it. If the harness answers that the report was rejected, '
      + 'fix the listed fields and call this tool again with the complete corrected report.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: true },
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
