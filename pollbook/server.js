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
  console.log(`Pollbook running → http://localhost:${PORT}`);
  console.log(`Data provider: ${process.env.DATA_PROVIDER || 'mock'}`);
});
