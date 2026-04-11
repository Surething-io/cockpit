import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModelV3 } from '@ai-sdk/provider';
import { getOpenAIBaseURL } from '@/lib/ollama-env';

export function createOllamaModel(modelName: string): LanguageModelV3 {
  const provider = createOpenAI({
    apiKey: process.env.OLLAMA_API_KEY || 'ollama',
    baseURL: getOpenAIBaseURL(),
  });
  return provider.chat(modelName);
}
