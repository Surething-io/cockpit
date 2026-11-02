// Explicit CLI extension: bridge the parent's effective model metadata into child Pi.
export default async function cockpitPiSubagentProvider(pi) {
  const { provider, config } = JSON.parse(process.env.COCKPIT_PI_SUBAGENT_MODEL);
  delete process.env.COCKPIT_PI_SUBAGENT_MODEL;
  pi.registerProvider(provider, { ...config, apiKey: 'cockpit-runtime-override' });
  if (provider === 'ollama') pi.on('before_provider_request', ({ payload }) => {
    if (!payload || !Array.isArray(payload.messages)) return;
    return { ...payload, messages: payload.messages.map((message) => message.content === null ? { ...message, content: '' } : message) };
  });
}
