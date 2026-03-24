const Ably = require('ably');

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

// Extract and clean JSON from Claude's response
function extractAndCleanJSON(str) {
  console.log('Extracting JSON from:', str.substring(0, 200));

  // Step 1: Remove markdown code blocks
  str = str
    .replace(/```json\n?/gi, '')
    .replace(/```\n?/gi, '');

  // Step 2: Find the first { and last }
  const firstBrace = str.indexOf('{');
  const lastBrace = str.lastIndexOf('}');

  if (firstBrace === -1 || lastBrace === -1) {
    throw new Error('No JSON object found in Claude response');
  }

  // Extract just the JSON part
  str = str.substring(firstBrace, lastBrace + 1);

  // Step 3: Remove all bad control characters
  str = str.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');

  // Step 4: Process character by character to fix
  // newlines and tabs inside string values
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
      if (char === '\n' || char === '\r') {
        result += ' ';
      } else if (char === '\t') {
        result += ' ';
      } else {
        result += char;
      }
    } else {
      if (char === '\n' || char === '\r' || char === '\t' || char === ' ') {
        // skip whitespace outside strings
      } else {
        result += char;
      }
    }
  }

  console.log('Cleaned JSON:', result.substring(0, 200));
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

    // Clean outer wrapper
    const outerCleaned = rawBody
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');

    // Extract type field
    const typeMatch = outerCleaned.match(/"type"\s*:\s*"([^"]+)"/);
    type = typeMatch ? typeMatch[1] : 'json';

    // Extract raw content value
    const contentMatch = outerCleaned.match(/"content"\s*:\s*"([\s\S]*?)"\s*(?:,\s*"type"|,\s*"timestamp"|\s*\})/);

    let rawContent;
    if (contentMatch) {
      rawContent = contentMatch[1];
      console.log('Content extracted via regex:', rawContent.substring(0, 200));
    } else {
      const outerParsed = JSON.parse(outerCleaned);
      rawContent = outerParsed.content;
      type = outerParsed.type || 'json';
    }

    if (!rawContent) {
      throw new Error('Could not extract content from body');
    }

    // Extract and clean JSON from Claude's response
    const cleanJSON = extractAndCleanJSON(rawContent);

    // Parse the cleaned JSON
    content = JSON.parse(cleanJSON);
    console.log('Successfully parsed JSON content');

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

  // Initialize Ably
  const ably = new Ably.Rest(process.env.ABLY_API_KEY);
  const channel = ably.channels.get('agent-channel');

  try {
    await channel.publish('agent-update', {
      content: content,
      type: type || 'json',
      timestamp: new Date().toISOString()
    });

    console.log(`Webhook received and published at ${new Date().toISOString()}`);
    return res.status(200).json({ success: true });

  } catch (error) {
    console.error('Ably error:', error.message);
    return res.status(500).json({ error: error.message });
  }
};
