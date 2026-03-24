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

    // Parse the outer JSON wrapper
