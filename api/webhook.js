const https = require('https');

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

// Fix newlines and tabs inside JSON string values
function fixJSONStringValues(str) {
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
      // Inside string — replace literal newlines/tabs with space
      if (char === '\n' || char === '\r') {
        result += ' ';
      } else if (char === '\t') {
        result += ' ';
      } else {
        result += char;
      }
    } else {
      // Outside string — keep as is
      result += char;
    }
  }

  return result;
}

// Extract Claude's JSON from the full raw body
function extractClaudeJSON(rawBody) {
  console.log('Starting Claude JSON extraction...');
  console.log('Total body length:', rawBody.length);

  // Step 1: Remove all bad control characters from entire body
  let cleaned = rawBody
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');

  // Step 2: Fix literal newlines and tabs inside string values
  cleaned = fixJSONStringValues(cleaned);
  console.log('Body cleaned, length:', cleaned.length);

  // Step 3: Try parsing the whole thing as JSON directly
  try {
    const parsed = JSON.parse(cleaned);
    console.log('Full body parsed directly');
    return {
      content: parsed.content,
      type: parsed.type || 'json'
    };
  } catch {
    console.log('Full body parse failed, extracting manually...');
  }

  // Step 4: Extract type
  const typeMatch = cleaned.match(/"type"\s*:\s*"([^"]+)"/);
  const type = typeMatch ? typeMatch[1] : 'json';

  // Step 5: Find where Claude's JSON starts
  // Find "content": then find the first { after it
  const contentKeyPos = cleaned.indexOf('"content"');
  if (contentKeyPos === -1) {
    throw new Error('No content field found');
  }

  const colonPos = cleaned.indexOf(':', contentKeyPos);
  const openQuotePos = cleaned.indexOf('"', colonPos + 1);
  const claudeTextStart = openQuotePos + 1;

  // Find first { in Claude's response
  const firstBrace = cleaned.indexOf('{', claudeTextStart);
  if (firstBrace === -1) {
    throw new Error('No JSON object found in Claude response');
  }

  console.log('Claude JSON starts at:', firstBrace);

  // Step 6: Find the end of Claude's JSON by counting braces
  // Now that we have cleaned the string this should work correctly
  let braceCount = 0;
  let claudeJsonEnd = -1;
  let inStr = false;
  let esc = false;

  for (let i = firstBrace; i < cleaned.length; i++) {
    const char = cleaned[i];

    // Track escape sequences
    if (esc) {
      esc = false;
      continue;
    }

    if (char === '\\' && inStr) {
      esc = true;
      continue;
    }

    // Track string boundaries
    if (char === '"') {
      inStr = !inStr;
      continue;
    }

    // Only count braces outside strings
    if (!inStr) {
      if (char === '{') braceCount++;
      if (char === '}') {
        braceCount--;
        if (braceCount === 0) {
          claudeJsonEnd = i;
          break;
        }
      }
    }
  }

  console.log('Claude JSON ends at:', claudeJsonEnd);

  if (claudeJsonEnd === -1) {
    throw new Error('Could not find end of Claude JSON');
  }

  // Extract Claude's JSON
  const claudeJSON = cleaned.substring(firstBrace, claudeJsonEnd + 1);
  console.log('Claude JSON length:', claudeJSON.length);
  console.log('Claude JSON preview:', claudeJSON.substring(0, 200));

  // Step 7: Remove markdown code blocks if present
  const noMarkdown = claudeJSON
    .replace(/```json\n?/gi, '')
    .replace(/```\n?/gi, '');

  // Step 8: Parse it
  try {
    const parsed = JSON.parse(noMarkdown);
    console.log('Claude JSON parsed successfully');
    return { content: parsed, type };
  } catch (e) {
    console.error('Final parse error:', e.message);
    console.error('Failed JSON preview:', noMarkdown.substring(0, 500));
    throw new Error(`Could not parse Claude JSON: ${e.message}`);
  }
}

// Publish to Ably using direct REST API call
function publishToAbly(apiKey, channelName, eventName, data) {
  return new Promise((resolve, reject) => {
    const keyParts = apiKey.split(':');
    const keyId = keyParts[0];
    const keySecret = keyParts[1];
    const credentials = Buffer.from(`${keyId}:${keySecret}`).toString('base64');

    const payload = JSON.stringify({
      name: eventName,
      data: data
    });

    console.log('Publishing to Ably REST API...');
    console.log('Payload size:', payload.length, 'bytes');

    const options = {
      hostname: 'rest.ably.io',
      port: 443,
      path: `/channels/${encodeURIComponent(channelName)}/messages`,
      method: 'POST',
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    };

    const req = https.request(options, (res) => {
      let responseData = '';
      res.on('data', (chunk) => {
        responseData += chunk;
      });
      res.on('end', () => {
        console.log('Ably REST response status:', res.statusCode);
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(responseData);
        } else {
          reject(new Error(`Ably REST API error: ${res.statusCode} ${responseData}`));
        }
      });
    });

    req.on('error', (err) => {
      console.error('Ably REST request error:', err.message);
      reject(err);
    });

    req.write(payload);
    req.end();
  });
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
    console.log('Raw body received:', rawBody.substring(0, 300));

    const extracted = extractClaudeJSON(rawBody);
    content = extracted.content;
    type = extracted.type;

    console.log('Content ready, type:', type);
    console.log('Content keys:', Object.keys(content).join(', '));

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

  try {
    const messageData = {
      content: content,
      type: type || 'json',
      timestamp: new Date().toISOString()
    };

    await publishToAbly(
      process.env.ABLY_API_KEY,
      'agent-channel',
      'agent-update',
      messageData
    );

    console.log(`Successfully published at ${new Date().toISOString()}`);
    return res.status(200).json({ success: true });

  } catch (error) {
    console.error('Publish error:', error.message);
    return res.status(500).json({ error: error.message });
  }
};
