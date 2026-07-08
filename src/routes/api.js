const express = require('express');
const service = require('../services/electionService');

const router = express.Router();

// GET /api/areas — states + localities available for browsing
router.get('/areas', async (req, res, next) => {
  try {
    res.json(await service.getAreas());
  } catch (err) { next(err); }
});

// GET /api/elections?state=GA&scope=local|state|national&upcoming=true
router.get('/elections', async (req, res, next) => {
  try {
    const { state, scope, upcoming } = req.query;
    res.json(await service.getElections({ state, scope, upcoming: upcoming !== 'false' }));
  } catch (err) { next(err); }
});

// GET /api/elections/:id — full election detail with races + candidates
router.get('/elections/:id', async (req, res, next) => {
  try {
    const election = await service.getElectionById(req.params.id);
    if (!election) return res.status(404).json({ error: 'Election not found' });
    res.json(election);
  } catch (err) { next(err); }
});

// GET /api/candidates/:id — candidate detail with values + articles
router.get('/candidates/:id', async (req, res, next) => {
  try {
    const candidate = await service.getCandidateById(req.params.id);
    if (!candidate) return res.status(404).json({ error: 'Candidate not found' });
    res.json(candidate);
  } catch (err) { next(err); }
});

// GET /api/stats?state=GA — turnout + registration data for the data view
router.get('/stats', async (req, res, next) => {
  try {
    res.json(await service.getStats(req.query.state));
  } catch (err) { next(err); }
});

router.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal error' });
});

module.exports = router;
