const Pusher = require('pusher');

export const config = {
  api: {
    bodyParser: false,
  },
};

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk.toString();
    });
    req.on('end', () => resolve(data));
    req.on('error', (err) => reject(err));
  });
}

// Extract just the JSON object from Claude's response
// Handles extra text, markdown code blocks, pretty printing etc.
function extractJSON(str) {
  // Step 1: Remove markdown code blocks
  str = str
    .replace(/```json\n?/gi, '')
    .replace(/```\n?/gi, '');

  // Step 2: Find the first { and last } to extract just the JSON object
  const firstBrace = str.indexOf('{');
  const lastBrace = str.lastIndexOf('}');

  if (firstBrace === -1 || lastBrace === -1) {
    throw new Error('No JSON object found in content');
  }

  str = str.substring(firstBrace, lastBrace + 1);

  // Step 3: Remove all control characters
  str = str.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');

  // Step 4: Fix newlines and tabs inside JSON string values
  // This replaces literal newlines with spaces only inside string values
  let result = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < str.length; i++) {
    const char = str[i];

    if (escaped) {
      result += char;
      escaped = false;
      continue;
    }

    if (char === '\\') {
      escaped = true;
      result += char;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      result += char;
      continue;
    }

    if (inString) {
      // Inside a string value - replace literal newlines/tabs with spaces
      if (char === '\n' || char === '\r') {
        result += ' ';
      } else if (char === '\t') {
        result += ' ';
      } else {
        result += char;
      }
    } else {
      // Outside string - remove whitespace
      if (char === '\n' || char === '\r' || char === '\t') {
        // skip
      } else {
        result += char;
      }
    }
  }

  return result;
}

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

  let content, type;

  try {
    const rawBody = await getRawBody(req);
    console.log('Raw body received:', rawBody.substring(0, 500));

    // First extract the outer wrapper to get content and type
    // Find content value start
    const contentKeyIndex = rawBody.indexOf('"content"');
    const typeMatch = rawBody.match(/"type"\s*:\s*"([^"]+)"/);
    type = typeMatch ? typeMatch[1] : 'json';

    if (contentKeyIndex === -1) {
      throw new Error('No content field found in body');
    }

    // Extract everything after "content": 
    const afterContentKey = rawBody.substring(contentKeyIndex + 9).trim();
    // Remove the colon
    const afterColon = afterContentKey.substring(
      afterContentKey.indexOf(':') + 1
    ).trim();

    // Get the raw content value (everything between first " and matching close)
    // Or if it starts with { it's a raw JSON object
    let rawContent;
    if (afterColon.trimStart().startsWith('"')) {
      // Content is a quoted string - find the end quote
      // accounting for escaped quotes
      let i = 1; // skip opening quote
      const inner = afterColon.trimStart().substring(1);
      rawContent = inner.substring(0, inner.lastIndexOf('"'));
    } else {
      // Content might be a raw object
      rawContent = afterColon;
    }

    console.log('Extracted raw content:', rawContent.substring(0, 300));

    // Now extract and clean the JSON from Claude's response
    const cleanJSON = extractJSON(rawContent);
    console.log('Cleaned JSON:', cleanJSON.substring(0, 300));

    content = JSON.parse(cleanJSON);

  } catch (parseError) {
    console.error('Body parse error:', parseError.message);
    return res.status(400).json({
      error: 'Could not parse body',
      details: parseError.message
    });
  }

  if (!content) {
    return res.status(400).json({ error: 'No content provided' });
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
      type: type || 'json',
      timestamp: new Date().toISOString()
    });

    console.log(`Webhook received at ${new Date().toISOString()}`);
    return res.status(200).json({ success: true });

  } catch (error) {
    console.error('Pusher error:', error.message);
    return res.status(500).json({ error: error.message });
  }
};
