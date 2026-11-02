// Audited service contracts. Numeric units follow each provider, not model-name heuristics.
import type { ProviderModelConfig } from '@earendil-works/pi-coding-agent';
import type { PiEngine } from '@cockpit/shared-utils';

export type PiChatDefinition = Extract<ProviderModelConfig, { reasoning: boolean; maxTokens: number }>;
export type PiModelOverride = Pick<PiChatDefinition, 'id' | 'contextWindow' | 'maxTokens' | 'input' | 'reasoning'> & Partial<PiChatDefinition>;
type Compat = NonNullable<PiChatDefinition['compat']>;
export interface PiModelCapabilities {
  contextWindow: number;
  /** Documented maximum entitlement when the default is a lower subscription tier. */
  contextCeiling?: number;
  /** null means the service has not published an independent output maximum. */
  maxOutputTokens: number | null;
  input: ('text' | 'image')[];
  tools: boolean;
  thinking: 'optional' | 'required' | 'none';
  defaultThinking: 'off' | 'low' | 'high';
  compat: Compat;
  thinkingLevelMap?: PiChatDefinition['thinkingLevelMap'];
  source: string;
  verifiedAt: string;
}
export const PI_REQUEST_OUTPUT_BUDGET = 32768;
const verifiedAt = '2026-11-02';
const common: Compat = { supportsStore: false, supportsDeveloperRole: false, maxTokensField: 'max_tokens' };
const effort: PiChatDefinition['thinkingLevelMap'] = { off: null, minimal: null, low: 'low', medium: null, high: 'high', xhigh: null, max: 'max' };
const deepseek = (vision: boolean): PiModelCapabilities => ({
  contextWindow: 1000000, maxOutputTokens: 384000, input: vision ? ['text', 'image'] : ['text'], tools: true,
  thinking: 'optional', defaultThinking: 'off', verifiedAt,
  source: 'https://api-docs.deepseek.com/quick_start/pricing/',
  compat: { ...common, thinkingFormat: 'deepseek', requiresReasoningContentOnAssistantMessages: true, supportsStrictMode: true },
  thinkingLevelMap: { minimal: null, low: null, medium: null, high: 'high', max: 'max' },
});
const kimi = (contextWindow: number, highspeed = false, contextCeiling = contextWindow): PiModelCapabilities => ({
  contextWindow, contextCeiling, maxOutputTokens: null, input: ['text', 'image'], tools: true,
  thinking: 'required', defaultThinking: 'high', verifiedAt,
  // Coding Plan does not publish an independent output maximum here. The explicit
  // request budget above is policy, not a claim about the model's maximum output.
  source: 'https://www.kimi.com/code/docs/kimi-code/models.html',
  compat: { ...common, supportsReasoningEffort: !highspeed, thinkingFormat: highspeed ? 'deepseek' : 'openai',
    requiresReasoningContentOnAssistantMessages: !highspeed, supportsMidConvoSystemMessages: true },
  thinkingLevelMap: highspeed ? { off: null } : effort,
});
const glm = (contextWindow: number, output: number, version: string, required = false, vision = false): PiModelCapabilities => ({
  contextWindow, maxOutputTokens: output, input: vision ? ['text', 'image'] : ['text'], tools: true,
  thinking: required ? 'required' : 'optional', defaultThinking: required ? 'low' : 'off', verifiedAt,
  source: `https://docs.z.ai/guides/${vision ? 'vlm' : 'llm'}/${version}`,
  compat: { ...common, thinkingFormat: 'zai', supportsReasoningEffort: required || version === 'glm-5.2', supportsStrictMode: true, zaiToolStream: true },
  thinkingLevelMap: required ? effort : undefined,
});
/** Kimi's 256K entry is the documented lower-tier entitlement, enlarged only by live service metadata or an explicit override. */
export const PI_MODEL_CAPABILITIES: Partial<Record<PiEngine, Readonly<Record<string, PiModelCapabilities>>>> = {
  deepseek: { 'deepseek-flash': deepseek(true), 'deepseek-v4-pro': deepseek(false) },
  kimi: { k3: kimi(262144, false, 1048576), 'k3-256k': kimi(262144), 'k3.1-pro': kimi(262144, false, 1048576), 'k3.1-pro-highspeed': kimi(1048576),
    'kimi-for-coding': kimi(1048576), 'kimi-for-coding-highspeed': kimi(262144, true) },
  glm: {
    'glm-4.5': glm(131072, 98304, 'glm-4.5'), 'glm-4.5-air': glm(131072, 98304, 'glm-4.5'),
    'glm-4.6': glm(204800, 131072, 'glm-4.6'), 'glm-4.7': glm(204800, 131072, 'glm-4.7'),
    'glm-5': glm(200000, 131072, 'glm-5'), 'glm-5-turbo': glm(200000, 131072, 'glm-5-turbo'),
    'glm-5.1': glm(200000, 131072, 'glm-5.1'), 'glm-5.2': glm(1000000, 131072, 'glm-5.2'),
    'glm-5.3': glm(1000000, 131072, 'glm-5.3', true),
    'glm-5.3-flash': glm(1000000, 131072, 'glm-5.3-flash', true, true),
    // FlashX shares the documented Flash architecture/capabilities; output ceiling
    // remains unknown until its service contract publishes it (no inferred limit).
    'glm-5.3-flashx': { ...glm(1000000, 131072, 'glm-5.3-flash', true, true), maxOutputTokens: null },
  },
};
export const PI_MODEL_ALIASES: Partial<Record<PiEngine, Readonly<Record<string, string>>>> = {
  deepseek: { 'deepseek-v4-flash': 'deepseek-flash', 'deepseek-v4-flash-vision-exp': 'deepseek-flash' },
};
