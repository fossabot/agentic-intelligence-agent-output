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

// Fix literal newlines and tabs inside JSON string values
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
      if (char === '\n' || char === '\r') {
        result += ' ';
      } else if (char === '\t') {
        result += ' ';
      } else {
        result += char;
      }
    } else {
      result += char;
    }
  }

  return result;
}

// Find the end of a JSON object/array starting at startPos
// Uses a more robust approach that handles edge cases
function findJSONEnd(str, startPos) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  let lastValidEnd = -1;

  for (let i = startPos; i < str.length; i++) {
    const char = str[i];
    const code = str.charCodeAt(i);

    // Skip non-printable characters that slipped through
    if (!inString && code < 32 && code !== 9 && code !== 10 && code !== 13) {
      continue;
    }

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === '\\' && inString) {
      escaped = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (!inString) {
      if (char === '{' || char === '[') {
        depth++;
      } else if (char === '}' || char === ']') {
        depth--;
        if (depth === 0) {
          return i;
        }
        if (depth < 0) {
          // Something went wrong, return last valid end
          return lastValidEnd;
        }
        lastValidEnd = i;
      }
    }
  }

  return lastValidEnd;
}

// Attempt to repair truncated JSON by finding
// the last complete value and closing open structures
function repairJSON(str) {
  console.log('Attempting JSON repair...');

  // Find all unclosed structures
  let depth = 0;
  let inString = false;
  let escaped = false;
  let lastCompletePos = 0;
  let structureStack = [];

  for (let i = 0; i < str.length; i++) {
    const char = str[i];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === '\\' && inString) {
      escaped = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      if (!inString) lastCompletePos = i;
      continue;
    }

    if (!inString) {
      if (char === '{') {
        structureStack.push('}');
        depth++;
      } else if (char === '[') {
        structureStack.push(']');
        depth++;
      } else if (char === '}' || char === ']') {
        structureStack.pop();
        depth--;
        lastCompletePos = i;
      } else if (char === ',' || char === ':') {
        // Don't update lastCompletePos here
      } else if (char !== ' ' && char !== '\n' && char !== '\r' && char !== '\t') {
        // Some other character
      }
    }
  }

  console.log('Structure stack remaining:', structureStack);
  console.log('Last complete position:', lastCompletePos);

  // If we're inside a string, close it first
  let repaired = str;
  if (inString) {
    repaired += '"';
    console.log('Closed unclosed string');
  }

  // Close any open structures in reverse order
  const closers = structureStack.reverse().join('');
  repaired += closers;
  console.log('Added closers:', closers);
  console.log('Repaired JSON last 150 chars:', repaired.substring(repaired.length - 150));

  return repaired;
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
    console.log('Total body length:', rawBody.length);

    // Step 1: Remove bad control characters
    let cleaned = rawBody
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');

    // Step 2: Fix literal newlines inside string values
    cleaned = fixJSONStringValues(cleaned);
    console.log('Body cleaned, length:', cleaned.length);

    // Step 3: Try parsing entire body as JSON directly
    try {
      const parsed = JSON.parse(cleaned);
      console.log('Full body parsed directly');
      type = parsed.type || 'json';
      const rawContent = parsed.content;

      if (typeof rawContent === 'object') {
        content = rawContent;
      } else {
        // Content is a string — try to parse it
        try {
          content = JSON.parse(rawContent);
        } catch {
          // Has extra text — extract JSON from it
          const firstBrace = rawContent.indexOf('{');
          const lastBrace = rawContent.lastIndexOf('}');
          if (firstBrace !== -1 && lastBrace !== -1) {
            const jsonStr = rawContent.substring(firstBrace, lastBrace + 1);
            content = JSON.parse(fixJSONStringValues(jsonStr));
          }
        }
      }
      console.log('Content parsed successfully via direct parse');

    } catch {
      // Step 4: Manual extraction
      console.log('Full body parse failed, extracting manually...');

      // Extract type
      const typeMatch = cleaned.match(/"type"\s*:\s*"([^"]+)"/);
      type = typeMatch ? typeMatch[1] : 'json';

      // Find where Claude's JSON starts
      const contentKeyPos = cleaned.indexOf('"content"');
      const colonPos = cleaned.indexOf(':', contentKeyPos);
      const openQuotePos = cleaned.indexOf('"', colonPos + 1);
      const claudeTextStart = openQuotePos + 1;
      const firstBrace = cleaned.indexOf('{', claudeTextStart);

      console.log('Claude JSON starts at:', firstBrace);

      if (firstBrace === -1) {
        throw new Error('No JSON found in Claude response');
      }

      // Find end using robust brace counter
      const claudeJsonEnd = findJSONEnd(cleaned, firstBrace);
      console.log('Claude JSON ends at:', claudeJsonEnd);
      console.log('Total cleaned length:', cleaned.length);

      if (claudeJsonEnd === -1) {
        throw new Error('Could not find end of Claude JSON');
      }

      let claudeJSON = cleaned.substring(firstBrace, claudeJsonEnd + 1);
      console.log('Claude JSON length:', claudeJSON.length);
      console.log('Claude JSON last 200 chars:', claudeJSON.substring(claudeJSON.length - 200));

      // Step 5: Try parsing extracted JSON
      try {
        content = JSON.parse(claudeJSON);
        console.log('Claude JSON parsed successfully');
      } catch (parseErr) {
        console.log('Parse failed, attempting repair:', parseErr.message);

        // Step 6: Repair and retry
        const repaired = repairJSON(claudeJSON);
        try {
          content = JSON.parse(repaired);
          console.log('Repaired JSON parsed successfully');
        } catch (repairErr) {
          console.error('Repair failed:', repairErr.message);

          // Step 7: Last resort — find last complete top-level field
          // and truncate there
          console.log('Attempting truncation repair...');

          // Find the last }, or }] that indicates end of a complete object
          // Work backwards from the end
          let truncatePos = claudeJSON.length - 1;
          let attempts = 0;

          while (attempts < 50) {
            // Find last occurrence of ]} or }} or },
            const lastCompleteObj = Math.max(
              claudeJSON.lastIndexOf('}},', truncatePos),
              claudeJSON.lastIndexOf('}]', truncatePos),
              claudeJSON.lastIndexOf(']}', truncatePos)
            );

            if (lastCompleteObj === -1) break;

            // Try to close the JSON at this point
            const truncated = claudeJSON.substring(0, lastCompleteObj + 2);
            const repairAttempt = repairJSON(truncated);

            try {
              content = JSON.parse(repairAttempt);
              console.log('Truncation repair succeeded at position:', lastCompleteObj);
              break;
            } catch {
              truncatePos = lastCompleteObj - 1;
              attempts++;
            }
          }

          if (!content) {
            throw new Error(`Could not parse Claude JSON after all repair attempts: ${repairErr.message}`);
          }
        }
      }
    }

    if (content) {
      console.log('Content ready, type:', type);
      console.log('Content keys:', Object.keys(content).join(', '));
    }

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
