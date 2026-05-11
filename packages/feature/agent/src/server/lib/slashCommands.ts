export const COMMAND_CONTENT: Record<string, Record<string, string>> = {
  qa: {
    zh: `进入需求澄清讨论模式
尝试理解用户的需求并给出你对需求的理解，有不明确的点需要向我确认，避免理解不一致而导致无效的代码修改
遵循 KISS 原则
输出理解，不改代码`,
    en: `Enter requirement clarification mode.
Understand the user's needs and state your understanding.
Ask for clarification on ambiguous points to avoid unnecessary code changes.
Follow the KISS principle.
Output your understanding only; do not modify code.`,
  },
  fx: {
    zh: `进入bug证据链分析模式，只分析不修改代码，给出详细推理过程`,
    en: `Enter bug evidence chain analysis mode.
Analyze only; do not modify code.
Provide a detailed reasoning process.`,
  },
};

export function resolveCommandPrompt(prompt: string, language = 'en'): string {
  const trimmed = prompt.trimStart();
  const match = trimmed.match(/^\/([a-zA-Z]+)(?:\s+|$)/);
  if (!match) return prompt;

  const cmd = match[1];
  const lang = language.startsWith('zh') ? 'zh' : 'en';
  const content = COMMAND_CONTENT[cmd]?.[lang];
  if (!content) return prompt;

  const rest = trimmed.slice(match[0].length).trimStart();
  return rest ? `${content}\n\n${rest}` : content;
}
