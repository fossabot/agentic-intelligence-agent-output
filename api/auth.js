const Ably = require('ably');

module.exports = async function handler(req, res) {
  try {
    const client = new Ably.Rest({ key: process.env.ABLY_API_KEY });
    
    const tokenRequest = await new Promise((resolve, reject) => {
      client.auth.createTokenRequest(
        { capability: { 'agent-channel': ['subscribe'] } },
        (err, tokenRequest) => {
          if (err) reject(err);
          else resolve(tokenRequest);
        }
      );
    });

    res.status(200).json(tokenRequest);

  } catch (error) {
    console.error('Auth error:', error.message);
    res.status(500).json({ error: error.message });
  }
};
