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

// Clean a raw JSON string by fixing control characters
// and newlines inside string values
function cleanJSONString(str) {
  // Remove bad control characters
  str = str.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');

  // Remove markdown code blocks
  str = str
    .replace(/```json\n?/gi, '')
    .replace(/```\n?/gi, '');

  // Find the first { and last }
  const firstBrace = str.indexOf('{');
  const lastBrace = str.lastIndexOf('}');

  if (firstBrace === -1 || lastBrace === -1) {
    throw new Error('No JSON object found in Claude response');
  }

  str = str.substring(firstBrace, lastBrace + 1);

  // Fix newlines and tabs inside string values
  // character by character
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

  return result;
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
    console.log('Raw body received:', rawBody.substring(0, 500));
    console.log('Total body length:', rawBody.length);

    // APPROACH: Clean the entire raw body first
    // then parse the outer wrapper
    // then extract and clean Claude's JSON from content

    // Step 1: Clean the entire raw body of control characters
    // but preserve the structure
    const bodyNoControlChars = rawBody
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');

    // Step 2: Try to parse outer wrapper directly
    // This works when content is clean (Reqbin tests)
    try {
      const outerParsed = JSON.parse(bodyNoControlChars);
      console.log('Outer wrapper parsed directly');
      
      type = outerParsed.type || 'json';
      const rawContent = outerParsed.content;

      if (!rawContent) {
        throw new Error('No content field in body');
      }

      // Content is already a parsed object
      if (typeof rawContent === 'object') {
        content = rawContent;
        console.log('Content is already an object');
      } else {
        // Content is a string - try to parse it as JSON
        try {
          content = JSON.parse(rawContent);
          console.log('Content parsed directly as JSON');
        } catch {
          // Content has extra text - extract JSON from it
          console.log('Content has extra text, extracting JSON...');
          const cleaned = cleanJSONString(rawContent);
          content = JSON.parse(cleaned);
          console.log('Content extracted and cleaned successfully');
        }
      }

    } catch (outerParseError) {
      // Step 3: Outer wrapper parse failed
      // This means Claude's response has unescaped characters
      // that break the outer JSON
      // Solution: manually split the body to get the content value
      console.log('Outer parse failed:', outerParseError.message);
      console.log('Attempting manual content extraction...');

      // Extract type
      const typeMatch = bodyNoControlChars.match(/"type"\s*:\s*"([^"]+)"/);
      type = typeMatch ? typeMatch[1] : 'json';

      // The raw body looks like:
      // {"content": "CLAUDE_TEXT_HERE {JSON_HERE}", "type": "json"}
      // We need to find Claude's JSON directly in the raw body
      // by finding the FIRST { that is part of Claude's JSON
      // (not the outer wrapper's {)

      // Find the position right after "content": "
      const contentKeyPos = bodyNoControlChars.indexOf('"content"');
      const colonPos = bodyNoControlChars.indexOf(':', contentKeyPos);
      const openQuotePos = bodyNoControlChars.indexOf('"', colonPos + 1);
      
      // Everything from openQuotePos+1 is Claude's raw response
      // Find the first { in Claude's response
      const claudeResponseStart = openQuotePos + 1;
      const firstBraceInClaude = bodyNoControlChars.indexOf('{', claudeResponseStart);
      
      console.log('Claude response starts at:', claudeResponseStart);
      console.log('First { in Claude response at:', firstBraceInClaude);

      if (firstBraceInClaude === -1) {
        throw new Error('No JSON found in Claude response');
      }

      // Now find the end of Claude's JSON
      // We need to find the matching } by counting braces
      let braceCount = 0;
      let claudeJsonEnd = -1;

      for (let i = firstBraceInClaude; i < bodyNoControlChars.length; i++) {
        const char = bodyNoControlChars[i];
        
        if (char === '{') braceCount++;
        if (char === '}') {
          braceCount--;
          if (braceCount === 0) {
            claudeJsonEnd = i;
            break;
          }
        }
      }

      console.log('Claude JSON ends at:', claudeJsonEnd);

      if (claudeJsonEnd === -1) {
        throw new Error('Could not find end of Claude JSON');
      }

      // Extract Claude's JSON
      const claudeRawJSON = bodyNoControlChars.substring(
        firstBraceInClaude, 
        claudeJsonEnd + 1
      );
      
      console.log('Claude raw JSON length:', claudeRawJSON.length);
      console.log('Claude raw JSON preview:', claudeRawJSON.substring(0, 200));

      // Clean and parse it
      const cleaned = cleanJSONString(claudeRawJSON);
      content = JSON.parse(cleaned);
      console.log('Successfully extracted and parsed Claude JSON');
    }

    console.log('Content ready, type:', type);

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
