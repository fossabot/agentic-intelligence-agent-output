const Pusher = require('pusher');

const pusher = new Pusher({
  appId: process.env.PUSHER_APP_ID,
  key: process.env.PUSHER_KEY,
  secret: process.env.PUSHER_SECRET,
  cluster: process.env.PUSHER_CLUSTER,
  useTLS: true
});

export default async function handler(req, res) {
  // Only allow POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Check authorization
  const authHeader = req.headers['authorization'];
  const expectedAuth = `Bearer ${process.env.WEBHOOK_SECRET}`;

  if (authHeader !== expectedAuth) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { content, type } = req.body;

  if (!content) {
    return res.status(400).json({ error: 'No content provided' });
  }

  // Trigger Pusher event → updates the webpage in real time
  await pusher.trigger('agent-channel', 'agent-update', {
    content: content,
    type: type || 'html',
    timestamp: new Date().toISOString()
  });

  console.log(`Webhook received at ${new Date().toISOString()}`);
  return res.status(200).json({ success: true });
}
