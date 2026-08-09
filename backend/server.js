const express = require('express');
const app = express();

app.use(express.json());

// Proxy endpoint jo app.js se request lega aur World Chain RPC ko secure tarike se call karega
app.post('/api/proxy-request', async (req, res) => {
  try {
    const { action, to, data } = req.body;

    if (action === 'eth_call') {
      const response = await fetch('https://worldchain-mainnet.g.alchemy.com/public', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'eth_call',
          params: [{ to, data }, 'latest'],
          id: 1
        })
      });

      const result = await response.json();
      return res.json(result);
    }

    res.status(400).json({ error: 'Invalid action' });
  } catch (error) {
    res.status(500).json({ error: 'Proxy server error' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Proxy server running on port ${PORT}`));