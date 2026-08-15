const path = require('path');
const express = require('express');
const apiRoutes = require('./src/routes/api');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api', apiRoutes);

// SPA fallback — the frontend handles routing via hash, but keep this
// so deep links to / always resolve.
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  const provider = process.env.DATA_PROVIDER || 'live';
  console.log(`Pollbook running → http://localhost:${PORT}`);
  console.log(`Data provider: ${provider}`);

  if (provider !== 'live') {
    console.warn(`⚠  Serving ${provider} data — every candidate and dollar figure is fictional. Unset DATA_PROVIDER to use live FEC data.`);
    return;
  }

  // Never print the key itself, only whether one is present.
  if (process.env.FEC_API_KEY) {
    console.log('FEC API key: configured ✓  (verify with GET /api/health/fec)');
  } else {
    console.warn('⚠  FEC API key: using shared DEMO_KEY — 30 requests/hour across all users. Set FEC_API_KEY to your own free key from https://api.open.fec.gov/developers/');
  }
});
