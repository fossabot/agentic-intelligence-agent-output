const Pusher = require('pusher');

module.exports = async function handler(req, res) {

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

  // Handle body parsing manually regardless of content-type
  let content, type;
  
  try {
    // If body is already parsed as object
    if (typeof req.body === 'object' && req.body !== null) {
      content = req.body.content;
      type = req.body.type;
    } 
    // If body came in as a string
    else if (typeof req.body === 'string') {
      const parsed = JSON.parse(req.body);
      content = parsed.content;
      type = parsed.type;
    }
    // If body is a Buffer
    else if (Buffer.isBuffer(req.body)) {
      const parsed = JSON.parse(req.body.toString());
      content = parsed.content;
      type = parsed.type;
    }
  } catch (parseError) {
    console.error('Body parse error:', parseError.message);
    return res.status(400).json({ error: 'Could not parse request body' });
  }

  if (!content) {
    return res.status(400).json({ 
      error: 'No content provided',
      receivedBody: JSON.stringify(req.body),
      bodyType: typeof req.body
    });
  }

  // Initialize Pusher
  const pusher = new Pusher({
    appId: process.env.PUSHER_APP_ID,
    key: process.env.PUSHER_KEY,
    secret: process.env.PUSHER_SECRET,
    cluster: process.env.PUSHER_CLUSTER,
    useTLS: true
  });

  try {
    await pusher.trigger('agent-channel', 'agent-update', {
      content: content,
      type: type || 'html',
      timestamp: new Date().toISOString()
    });

    console.log(`Webhook received at ${new Date().toISOString()}`);
    return res.status(200).json({ success: true });

  } catch (error) {
    console.error('Pusher error:', error.message);
    return res.status(500).json({ error: error.message });
  }
};
