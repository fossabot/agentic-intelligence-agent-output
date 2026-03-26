const { Redis } = require('@upstash/redis');

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    await redis.del('last_report');
    console.log('Report cleared from Redis ✅');
    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('Clear report error:', error.message);
    return res.status(500).json({ error: error.message });
  }
};
