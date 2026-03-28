import { Sandbox } from 'e2b';

export default async function handler(req, res) {
  try {
    // Create sandbox from pre-built template (5 min timeout)
    const sandbox = await Sandbox.create('cockpit-demo', {
      timeoutMs: 5 * 60 * 1000,
      apiKey: process.env.E2B_API_KEY,
    });

    // Start Cockpit server inside sandbox
    await sandbox.commands.run('cock /home/user/demo-project --no-open', {
      background: true,
    });

    // Wait for server to be ready
    await sandbox.commands.run(
      'for i in $(seq 1 30); do curl -s http://localhost:3457/api/version && break || sleep 1; done'
    );

    // Get public URL, open demo project directly
    const host = sandbox.getHost(3457);
    const url = `https://${host}/?cwd=${encodeURIComponent('/home/user/demo-project')}`;

    // Redirect user to Cockpit
    res.redirect(302, url);
  } catch (error) {
    console.error('Failed to create sandbox:', error);
    res.status(500).json({ error: 'Failed to create demo sandbox' });
  }
}
