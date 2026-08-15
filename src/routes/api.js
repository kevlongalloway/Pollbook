const express = require('express');
const service = require('../services/electionService');
const { askAboutCandidate } = require('../lib/candidateQa');
const { askAboutBill } = require('../lib/billQa');
const webSearch = require('../sources/webSearch');
const { BILL_TYPES } = require('../sources/congress');

const router = express.Router();

/**
 * Bill coordinates arrive as three path segments. Validating them here keeps
 * an arbitrary string out of the upstream URL — the type must be one Congress
 * recognises and the number must be digits.
 */
function billParams(req) {
  const congress = Number(req.params.congress);
  const type = String(req.params.type || '').toLowerCase();
  const number = String(req.params.number || '');
  if (!Number.isInteger(congress) || congress < 1 || congress > 200) return null;
  if (!BILL_TYPES.includes(type)) return null;
  if (!/^\d{1,5}$/.test(number)) return null;
  return { congress, type, number };
}

// GET /api/meta — which data provider is actually serving this instance.
// The frontend banners loudly when it isn't live, so seed data can never be
// mistaken for real filings.
router.get('/meta', (req, res) => {
  const provider = process.env.DATA_PROVIDER || 'live';
  res.json({
    provider,
    live: provider === 'live',
    fecKey: process.env.FEC_API_KEY ? 'configured' : 'DEMO_KEY',
    congressKey: process.env.CONGRESS_API_KEY ? 'configured' : 'DEMO_KEY',
    webSearch: webSearch.provider(),
  });
});

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

// POST /api/candidates/:id/ask — ask an AI question about this candidate.
// Scoped to U.S. elections/candidates by the system prompt in candidateQa;
// history comes from (and is stored only in) the caller's browser.
router.post('/candidates/:id/ask', async (req, res, next) => {
  try {
    const { question, history } = req.body || {};
    if (typeof question !== 'string' || !question.trim()) {
      return res.status(400).json({ error: 'A question is required.' });
    }
    if (question.length > 4000) {
      return res.status(400).json({ error: 'Question is too long.' });
    }

    const candidate = await service.getCandidateById(req.params.id);
    if (!candidate) return res.status(404).json({ error: 'Candidate not found' });

    const { answer, sources } = await askAboutCandidate(
      candidate, question.trim(), Array.isArray(history) ? history : []
    );
    res.json({ answer, sources });
  } catch (err) { next(err); }
});

// GET /api/stats?state=GA — campaign-finance snapshot for the data view
router.get('/stats', async (req, res, next) => {
  try {
    res.json(await service.getStats(req.query.state));
  } catch (err) { next(err); }
});

// GET /api/search?q=name — candidate search across all states (FEC-backed)
router.get('/search', async (req, res) => {
  try {
    res.json(await service.searchCandidates(req.query.q || ''));
  } catch (err) {
    // Search is wholly dependent on the live FEC connection — report that
    // plainly instead of a generic 500.
    res.status(503).json({ error: 'Candidate search is unavailable — the live FEC data source could not be reached.' });
  }
});

// GET /api/committees?q=aipac — PAC / super PAC / committee search
router.get('/committees', async (req, res) => {
  try {
    res.json(await service.searchCommittees(req.query.q || ''));
  } catch (err) {
    res.status(503).json({ error: 'Committee search is unavailable — the live FEC data source could not be reached.' });
  }
});

// GET /api/committees/:id — committee detail: totals, spending for/against
router.get('/committees/:id', async (req, res, next) => {
  try {
    const committee = await service.getCommitteeById(req.params.id);
    if (!committee) return res.status(404).json({ error: 'Committee not found' });
    res.json(committee);
  } catch (err) { next(err); }
});

// GET /api/bills?q=... — election-related bills before Congress, or a search.
// A query that parses as a bill number ("HR 22") resolves that bill directly.
router.get('/bills', async (req, res) => {
  try {
    res.json(await service.getBills({ q: req.query.q || '' }));
  } catch (err) {
    res.status(503).json({ error: `Live legislative data (Congress.gov) is unavailable right now — ${err.message}` });
  }
});

// GET /api/bills/:congress/:type/:number — full bill detail
router.get('/bills/:congress/:type/:number', async (req, res, next) => {
  try {
    const p = billParams(req);
    if (!p) return res.status(400).json({ error: 'Not a valid bill reference.' });
    const bill = await service.getBillById(p.congress, p.type, p.number);
    if (!bill) return res.status(404).json({ error: 'Bill not found' });
    res.json(bill);
  } catch (err) { next(err); }
});

// POST /api/bills/:congress/:type/:number/ask — AI answer about this bill.
// Scoped to U.S. legislation and elections by the system prompt in billQa;
// history comes from (and is stored only in) the caller's browser.
router.post('/bills/:congress/:type/:number/ask', async (req, res, next) => {
  try {
    const { question, history } = req.body || {};
    if (typeof question !== 'string' || !question.trim()) {
      return res.status(400).json({ error: 'A question is required.' });
    }
    if (question.length > 4000) {
      return res.status(400).json({ error: 'Question is too long.' });
    }

    const p = billParams(req);
    if (!p) return res.status(400).json({ error: 'Not a valid bill reference.' });
    const bill = await service.getBillById(p.congress, p.type, p.number);
    if (!bill) return res.status(404).json({ error: 'Bill not found' });

    const { answer, sources } = await askAboutBill(
      bill, question.trim(), Array.isArray(history) ? history : []
    );
    res.json({ answer, sources });
  } catch (err) { next(err); }
});

// GET /api/markets/national — balance-of-power prediction markets
router.get('/markets/national', async (req, res, next) => {
  try {
    res.json(await service.getNationalMarkets());
  } catch (err) { next(err); }
});

router.use((err, req, res, next) => {
  console.error(err);
  // Errors flagged with a status carry a user-safe message (e.g. an
  // upstream data source being down); everything else stays generic.
  if (err.status) return res.status(err.status).json({ error: err.message });
  res.status(500).json({ error: 'Internal error' });
});

module.exports = router;
