const Ably = require('ably');

module.exports = async function handler(req, res) {
  try {
    const client = new Ably.Rest({ key: process.env.ABLY_API_KEY });

    const tokenParams = {
      capability: JSON.stringify({ 'agent-channel': ['subscribe'] })
    };

    client.auth.requestToken(tokenParams, function(err, token) {
      if (err) {
        console.error('Token error:', err.message);
        return res.status(500).json({ error: err.message });
      }
      return res.status(200).json(token);
    });

  } catch (error) {
    console.error('Auth error:', error.message);
    res.status(500).json({ error: error.message });
  }
};
