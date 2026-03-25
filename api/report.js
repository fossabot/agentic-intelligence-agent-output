const { Redis } = require('@upstash/redis');

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

module.exports = async function handler(req, res) {

  // GET — load last report
  if (req.method === 'GET') {
    try {
      const report = await redis.get('last_report');
      if (!report) {
        return res.status(200).json({ report: null });
      }
      return res.status(200).json({ report });
    } catch (error) {
      console.error('Redis get error:', error.message);
      return res.status(500).json({ error: error.message });
    }
  }

  // POST — save report
  if (req.method === 'POST') {
    const authHeader = req.headers['authorization'];
    const expectedAuth = `Bearer ${process.env.WEBHOOK_SECRET}`;

    if (authHeader !== expectedAuth) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
      const { report } = req.body;
      // Store with 24 hour expiry
      await redis.set('last_report', report, { ex: 86400 });
      console.log('Report saved to Redis');
      return res.status(200).json({ success: true });
    } catch (error) {
      console.error('Redis set error:', error.message);
      return res.status(500).json({ error: error.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
