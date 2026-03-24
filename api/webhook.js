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

// Clean and parse JSON from any string
function extractAndCleanJSON(str) {
  console.log('Extracting JSON from:', str.substring(0, 200));

  // Step 1: Try parsing directly first
  try {
    const direct = JSON.parse(str.trim());
    console.log('Direct JSON parse succeeded');
    return direct;
  } catch {
    // Not clean JSON, continue
  }

  // Step 2: Remove markdown code blocks
  str = str
    .replace(/```json\n?/gi, '')
    .replace(/```\n?/gi, '');

  // Step 3: Try parsing again after removing markdown
  try {
    const afterMarkdown = JSON.parse(str.trim());
    console.log('JSON parse succeeded after markdown removal');
    return afterMarkdown;
  } catch {
    // Still not clean, continue
  }

  // Step 4: Find the first { and last }
  const firstBrace = str.indexOf('{');
  const lastBrace = str.lastIndexOf('}');

  if (firstBrace === -1 || lastBrace === -1) {
    throw new Error('No JSON object found in Claude response');
  }

  str = str.substring(firstBrace, lastBrace + 1);

  // Step 5: Remove bad control characters
  str = str.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');

  // Step 6: Fix newlines and tabs inside string values
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
        // skip
      } else {
        result += char;
      }
    }
  }

  console.log('Cleaned JSON string:', result.substring(0, 200));
  return JSON.parse(result);
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
        console.log('Ably REST response:', responseData);
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
    console.log('Raw body received:', rawBody.substring(0, 500));
    console.log('Total raw body length:', rawBody.length);

    // Step 1: Extract type
    const typeMatch = rawBody.match(/"type"\s*:\s*"([^"]+)"/);
    type = typeMatch ? typeMatch[1] : 'json';
    console.log('Type:', type);

    // Step 2: Find where Claude's JSON starts in the raw body
    // Look for the LAST occurrence of { before the closing of the outer JSON
    // Claude's JSON will be the largest JSON object in the string
    
    // Find all { positions in the raw body
    const allBraces = [];
    for (let i = 0; i < rawBody.length; i++) {
      if (rawBody[i] === '{') {
        allBraces.push(i);
      }
    }
    console.log('Found', allBraces.length, 'opening braces');

    // Find the last } in the raw body before the outer closing
    // The outer JSON ends with }\n or just }
    // Claude's JSON will be the content between the first { after "content": 
    // and the last } before the outer wrapper closes

    // Find position of "content": in raw body
    const contentKeyPos = rawBody.indexOf('"content"');
    console.log('Content key position:', contentKeyPos);

    // Find the first { that appears after some text following "content":
    // This is where Claude's JSON begins
    let claudeJsonStart = -1;
    for (let i = contentKeyPos; i < rawBody.length; i++) {
      if (rawBody[i] === '{') {
        // Skip the outer wrapper's { if it's right at the start
        if (i > 5) {
          claudeJsonStart = i;
          break;
        }
      }
    }

    // Actually find the { that is Claude's JSON
    // It comes after "content": "some text {
    // Find the position after "content": "
    const contentValueStart = rawBody.indexOf('"content"');
    const afterContentColon = rawBody.indexOf(':', contentValueStart) + 1;
    const afterContentQuote = rawBody.indexOf('"', afterContentColon) + 1;
    
    console.log('Content value starts at position:', afterContentQuote);
    
    // Now find the first { after the content opening quote
    claudeJsonStart = rawBody.indexOf('{', afterContentQuote);
    console.log('Claude JSON starts at position:', claudeJsonStart);

    if (claudeJsonStart === -1) {
      throw new Error('No JSON found in Claude response');
    }

    // Find the matching last } 
    // We need to find the last } that is part of Claude's JSON
    // not the outer wrapper's }
    // The outer wrapper ends with: }\n} or just }}
    // So we want everything from claudeJsonStart to the second-to-last }
    
    // Find the last } in the entire raw body
    let lastBrace = rawBody.lastIndexOf('}');
    
    // Step back to find Claude's closing }
    // The outer wrapper has its own closing }
    // So Claude's JSON ends at the } before the outer wrapper's }
    let claudeJsonEnd = lastBrace;
    
    // Check if there's another } close to the end
    // that belongs to the outer wrapper
    const afterClaudeJson = rawBody.substring(claudeJsonEnd + 1).trim();
    if (afterClaudeJson === '}' || afterClaudeJson === '}\n' || afterClaudeJson.startsWith('}')) {
      // The last } is the outer wrapper, go back one more
      claudeJsonEnd = rawBody.lastIndexOf('}', claudeJsonEnd - 1);
    }

    console.log('Claude JSON ends at position:', claudeJsonEnd);

    // Extract Claude's raw JSON string
    const claudeRawJSON = rawBody.substring(claudeJsonStart, claudeJsonEnd + 1);
    console.log('Claude raw JSON length:', claudeRawJSON.length);
    console.log('Claude raw JSON start:', claudeRawJSON.substring(0, 200));

    // Now clean and parse Claude's JSON
    content = extractAndCleanJSON(claudeRawJSON);
    console.log('Successfully parsed content');

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
