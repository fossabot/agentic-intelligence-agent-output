module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { password } = req.body;

  if (!password) {
    return res.status(400).json({ error: 'Password required' });
  }

  if (password === process.env.DASHBOARD_PASSWORD) {
    return res.status(200).json({ success: true });
  }

  // Add small delay to prevent brute force
  await new Promise(resolve => setTimeout(resolve, 1000));
  return res.status(401).json({ error: 'Incorrect password' });
};
