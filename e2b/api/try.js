const COOLDOWN_MS = 5 * 60 * 1000;
const E2B_API = 'https://api.e2b.dev';

export default async function handler(req, res) {
  // Simple cooldown: cookie-based
  const lastTry = parseInt(req.cookies?.cockpit_demo || '0', 10);
  const now = Date.now();
  if (lastTry && now - lastTry < COOLDOWN_MS) {
    const waitSec = Math.ceil((COOLDOWN_MS - (now - lastTry)) / 1000);
    return res.status(429).json({
      error: `Please wait ${waitSec}s before trying again.`,
    });
  }

  try {
    // Create sandbox via E2B REST API
    const response = await fetch(`${E2B_API}/sandboxes`, {
      method: 'POST',
      headers: {
        'X-API-Key': process.env.E2B_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        templateID: 'cockpit-demo',
        timeout: 300, // 5 minutes
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      console.error('E2B API error:', response.status, error);
      throw new Error(error);
    }

    const sandbox = await response.json();
    console.log('E2B sandbox response:', JSON.stringify(sandbox));
    // URL pattern: https://{port}-{sandboxId}.e2b.dev
    const domain = sandbox.domain || 'e2b.dev';
    const url = `https://3457-${sandbox.sandboxID}.${domain}/?cwd=${encodeURIComponent('/home/user/demo-project')}`;

    // Set cooldown cookie
    res.setHeader('Set-Cookie', `cockpit_demo=${now}; Path=/; Max-Age=300; SameSite=Lax`);
    res.redirect(302, url);
  } catch (error) {
    console.error('Failed to create sandbox:', error);
    res.status(500).json({ error: 'Failed to create demo sandbox.' });
  }
}
