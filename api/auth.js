const Ably = require('ably');

module.exports = async function handler(req, res) {
  try {
    const ably = new Ably.Rest(process.env.ABLY_API_KEY);
    
    const tokenRequest = await ably.auth.createTokenRequest({
      capability: { 'agent-channel': ['subscribe'] }
    });
    
    res.status(200).json(tokenRequest);
  } catch (error) {
    console.error('Auth error:', error.message);
    res.status(500).json({ error: 'Could not generate token' });
  }
};

