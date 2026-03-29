const COOLDOWN_MS = 5 * 60 * 1000;
const E2B_API = 'https://api.e2b.dev';

export default async function handler(req, res) {
  // Block known bots
  const ua = (req.headers['user-agent'] || '').toLowerCase();
  if (!ua || /axios|curl|wget|python|bot|crawler|spider|scraper/.test(ua)) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  // Step 1: Show confirmation page (blocks link preview bots)
  if (req.method === 'GET' && !req.query.confirm) {
    res.setHeader('Content-Type', 'text/html');
    return res.send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Cockpit Demo</title>
<style>
  body { font-family: system-ui; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #0a0a0a; color: #fff; }
  .card { text-align: center; max-width: 400px; }
  h1 { font-size: 24px; margin-bottom: 8px; }
  p { color: #888; margin-bottom: 24px; }
  a { display: inline-block; padding: 12px 32px; background: #2563eb; color: #fff; text-decoration: none; border-radius: 8px; font-size: 16px; }
  a:hover { background: #1d4ed8; }
</style></head>
<body><div class="card">
  <h1>Cockpit Demo</h1>
  <p>5-minute sandbox with Explorer &amp; Terminal<br>(no AI chat)</p>
  <a href="?confirm=1">Start Demo</a>
</div></body></html>`);
  }

  // Step 2: Create sandbox (only when user clicks "Start Demo")
  const lastTry = parseInt(req.cookies?.cockpit_demo || '0', 10);
  const now = Date.now();
  if (lastTry && now - lastTry < COOLDOWN_MS) {
    const waitSec = Math.ceil((COOLDOWN_MS - (now - lastTry)) / 1000);
    return res.status(429).json({
      error: `Please wait ${waitSec}s before trying again.`,
    });
  }

  try {
    const response = await fetch(`${E2B_API}/sandboxes`, {
      method: 'POST',
      headers: {
        'X-API-Key': process.env.E2B_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        templateID: 'cockpit-demo',
        timeout: 300,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      console.error('E2B API error:', response.status, error);
      throw new Error(error);
    }

    const sandbox = await response.json();
    const domain = sandbox.domain || 'e2b.dev';
    const url = `https://3457-${sandbox.sandboxID}.${domain}/?cwd=${encodeURIComponent('/home/user/demo-project')}`;

    res.setHeader('Set-Cookie', `cockpit_demo=${now}; Path=/; Max-Age=300; SameSite=Lax`);
    res.redirect(302, url);
  } catch (error) {
    console.error('Failed to create sandbox:', error);
    res.status(500).json({ error: 'Failed to create demo sandbox.' });
  }
}
