import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModelV3 } from '@ai-sdk/provider';

export function createOllamaModel(modelName: string): LanguageModelV3 {
  const provider = createOpenAI({
    apiKey: process.env.OLLAMA_API_KEY || 'ollama',
    baseURL: process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434/v1/',
  });
  return provider.chat(modelName);
}
