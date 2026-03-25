const https = require('https');
const { Redis } = require('@upstash/redis');

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// ============================================================
// RAW BODY READER
// ============================================================
function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk.toString(); });
    req.on('end', () => resolve(data));
    req.on('error', (err) => reject(err));
  });
}

// ============================================================
// JSON CLEANING AND EXTRACTION
// ============================================================
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

function findJSONEnd(str, startPos) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  let lastValidEnd = -1;

  for (let i = startPos; i < str.length; i++) {
    const char = str[i];
    const code = str.charCodeAt(i);

    if (!inString && code < 32 &&
        code !== 9 && code !== 10 && code !== 13) {
      continue;
    }
    if (escaped) { escaped = false; continue; }
    if (char === '\\' && inString) { escaped = true; continue; }
    if (char === '"') { inString = !inString; continue; }

    if (!inString) {
      if (char === '{' || char === '[') {
        depth++;
      } else if (char === '}' || char === ']') {
        depth--;
        if (depth === 0) return i;
        if (depth < 0) return lastValidEnd;
        lastValidEnd = i;
      }
    }
  }
  return lastValidEnd;
}

function repairJSON(str) {
  console.log('Attempting JSON repair...');
  let inString = false;
  let escaped = false;
  let structureStack = [];

  for (let i = 0; i < str.length; i++) {
    const char = str[i];
    if (escaped) { escaped = false; continue; }
    if (char === '\\' && inString) { escaped = true; continue; }
    if (char === '"') { inString = !inString; continue; }
    if (!inString) {
      if (char === '{') structureStack.push('}');
      else if (char === '[') structureStack.push(']');
      else if (char === '}' || char === ']') structureStack.pop();
    }
  }

  let repaired = str;
  if (inString) repaired += '"';
  repaired += structureStack.reverse().join('');
  console.log('Added closers:', structureStack.reverse().join(''));
  return repaired;
}

function extractClaudeJSON(rawBody) {
  console.log('Starting JSON extraction...');
  console.log('Total body length:', rawBody.length);

  let cleaned = rawBody
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  cleaned = fixJSONStringValues(cleaned);
  console.log('Body cleaned, length:', cleaned.length);

  // Try direct parse first
  try {
    const parsed = JSON.parse(cleaned);
    console.log('Full body parsed directly');
    const rawContent = parsed.content;
    const type = parsed.type || 'json';

    if (typeof rawContent === 'object') {
      return { content: rawContent, type };
    }
    try {
      return { content: JSON.parse(rawContent), type };
    } catch {
      const firstBrace = rawContent.indexOf('{');
      const lastBrace = rawContent.lastIndexOf('}');
      if (firstBrace !== -1 && lastBrace !== -1) {
        const jsonStr = rawContent.substring(firstBrace, lastBrace + 1);
        return {
          content: JSON.parse(fixJSONStringValues(jsonStr)),
          type
        };
      }
    }
  } catch {
    console.log('Full body parse failed, extracting manually...');
  }

  // Manual extraction
  const typeMatch = cleaned.match(/"type"\s*:\s*"([^"]+)"/);
  const type = typeMatch ? typeMatch[1] : 'json';

  const contentKeyPos = cleaned.indexOf('"content"');
  const colonPos = cleaned.indexOf(':', contentKeyPos);
  const openQuotePos = cleaned.indexOf('"', colonPos + 1);
  const claudeTextStart = openQuotePos + 1;
  const firstBrace = cleaned.indexOf('{', claudeTextStart);

  console.log('Claude JSON starts at:', firstBrace);

  if (firstBrace === -1) {
    throw new Error('No JSON found in Claude response');
  }

  const claudeJsonEnd = findJSONEnd(cleaned, firstBrace);
  console.log('Claude JSON ends at:', claudeJsonEnd);

  if (claudeJsonEnd === -1) {
    throw new Error('Could not find end of Claude JSON');
  }

  let claudeJSON = cleaned.substring(firstBrace, claudeJsonEnd + 1);
  console.log('Claude JSON length:', claudeJSON.length);

  try {
    const content = JSON.parse(claudeJSON);
    console.log('Claude JSON parsed successfully');
    return { content, type };
  } catch (parseErr) {
    console.log('Parse failed, attempting repair:', parseErr.message);

    const repaired = repairJSON(claudeJSON);
    try {
      const content = JSON.parse(repaired);
      console.log('Repaired JSON parsed successfully');
      return { content, type };
    } catch (repairErr) {
      console.log('Attempting truncation repair...');
      let truncatePos = claudeJSON.length - 1;
      let attempts = 0;

      while (attempts < 50) {
        const lastCompleteObj = Math.max(
          claudeJSON.lastIndexOf('}},', truncatePos),
          claudeJSON.lastIndexOf('}]', truncatePos),
          claudeJSON.lastIndexOf(']}', truncatePos)
        );

        if (lastCompleteObj === -1) break;

        const truncated = claudeJSON.substring(0, lastCompleteObj + 2);
        const repairAttempt = repairJSON(truncated);

        try {
          const content = JSON.parse(repairAttempt);
          console.log('Truncation repair succeeded at:', lastCompleteObj);
          return { content, type };
        } catch {
          truncatePos = lastCompleteObj - 1;
          attempts++;
        }
      }

      throw new Error(
        `Could not parse Claude JSON: ${repairErr.message}`
      );
    }
  }
}

// ============================================================
// PUBLISH TO ABLY
// ============================================================
function publishToAbly(apiKey, channelName, eventName, data) {
  return new Promise((resolve, reject) => {
    const keyParts = apiKey.split(':');
    const credentials = Buffer.from(
      `${keyParts[0]}:${keyParts[1]}`
    ).toString('base64');

    const payload = JSON.stringify({ name: eventName, data: data });

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
      res.on('data', chunk => responseData += chunk);
      res.on('end', () => {
        console.log('Ably response status:', res.statusCode);
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(responseData);
        } else {
          reject(new Error(
            `Ably error: ${res.statusCode} ${responseData}`
          ));
        }
      });
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ============================================================
// SEND TO ONUM
// ============================================================
function cleanString(str) {
  if (typeof str !== 'string') return str;
  return str
    .replace(/\n/g, ' ')
    .replace(/\r/g, ' ')
    .replace(/\t/g, ' ')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim();
}

function flattenForOnum(obj, prefix = '') {
  const result = {};

  for (const [key, value] of Object.entries(obj)) {
    const fieldName = prefix ? `${prefix}.${key}` : key;

    if (value === null || value === undefined) {
      result[fieldName] = '';
    } else if (Array.isArray(value)) {
      // Keep as JSON array string so Onum can unroll it
       result[fieldName] = JSON.stringify(
        value.map(item => {
          if (typeof item === 'object') {
          return cleanString(JSON.stringify(item));
          }
           return cleanString(String(item));
        })
      );
    }
 else if (typeof value === 'object') {
      const nested = flattenForOnum(value, fieldName);
      Object.assign(result, nested);
    } else if (typeof value === 'string') {
      result[fieldName] = cleanString(value);
    } else {
      result[fieldName] = value;
    }
  }

  return result;
}

function sendToOnum(content, timestamp) {
  return new Promise((resolve, reject) => {

    // Flatten and clean all fields
    const flatContent = flattenForOnum(content);

    // Build clean event
    const event = {
      timestamp: timestamp,
      source: 'intelligence-analyst-agent',
      sourcetype: 'crowdstrike:intelligence:agent',
      ...flatContent
    };

    // Stringify with final newline cleanup
    let payload = JSON.stringify(event);
    payload = payload
      .replace(/\\n/g, ' ')
      .replace(/\\r/g, ' ')
      .replace(/\\t/g, ' ');

    console.log('Onum auth: Basic', process.env.ONUM_USERNAME);
    console.log('Sending to Onum...');
    console.log('Onum payload size:', payload.length, 'bytes');
    console.log('Onum preview:', payload.substring(0, 300));

    const onumUrl = new URL(process.env.ONUM_URL);

    const credentials = Buffer.from(
        `${process.env.ONUM_USERNAME}:${process.env.ONUM_PASSWORD}`
      ).toString('base64');

      const options = {
        hostname: onumUrl.hostname,
        port: onumUrl.port || 8088,
        path: onumUrl.pathname,
        method: 'POST',
        headers: {
          'Authorization': `Basic ${credentials}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        },
        rejectUnauthorized: false
      };

    const req = https.request(options, (res) => {
      let responseData = '';
      res.on('data', chunk => responseData += chunk);
      res.on('end', () => {
        console.log('Onum response status:', res.statusCode);
        console.log('Onum response:', responseData);
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(responseData);
        } else {
          reject(new Error(
            `Onum error: ${res.statusCode} ${responseData}`
          ));
        }
      });
    });

    req.on('error', (err) => {
      console.error('Onum request error:', err.message);
      reject(err);
    });

    req.write(payload);
    req.end();
  });
}

// ============================================================
// MAIN HANDLER
// ============================================================
module.exports = async function handler(req, res) {

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

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

  const messageData = {
    content: content,
    type: type || 'json',
    timestamp: new Date().toISOString()
  };

  // 1. Save to Upstash Redis
  try {
    await redis.set('last_report', messageData, { ex: 86400 });
    console.log('Report saved to Redis ✅');
  } catch (redisError) {
    console.error('Redis save error:', redisError.message);
  }

  // 2. Publish to Ably
  try {
    await publishToAbly(
      process.env.ABLY_API_KEY,
      'agent-channel',
      'agent-update',
      messageData
    );
    console.log('Published to Ably ✅');
  } catch (ablyError) {
    console.error('Ably publish error:', ablyError.message);
  }

  // 3. Send to Onum
  try {
    await sendToOnum(content, messageData.timestamp);
    console.log('Sent to Onum ✅');
  } catch (onumError) {
    console.error('Onum send error:', onumError.message);
    // Don't fail the request if Onum send fails
  }

  console.log(`All outputs completed at ${new Date().toISOString()}`);
  return res.status(200).json({ success: true });
};
