#!/usr/bin/env node
/**
 * Confirms the configured FEC API key works, without starting the server.
 *
 *   npm run check:fec
 *   FEC_API_KEY=... npm run check:fec
 *
 * Reads FEC_API_KEY from the environment (or a local .env on Node 20.6+).
 * Never prints the key itself.
 */

const fs = require('node:fs');
const path = require('node:path');

// Minimal .env support so `npm run check:fec` works right after copying
// .env.example, without requiring a dependency.
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/i);
    if (!m) continue;
    const value = m[2].replace(/^["']|["']$/g, '').trim();
    if (value && !process.env[m[1]]) process.env[m[1]] = value;
  }
}

const fec = require('../src/sources/fec');

(async () => {
  const configured = Boolean(process.env.FEC_API_KEY);
  console.log(`FEC_API_KEY: ${configured ? 'configured' : 'not set — will use shared DEMO_KEY'}`);
  if (configured && /^["']|["']$/.test(process.env.FEC_API_KEY)) {
    console.warn('⚠  The key value has surrounding quotes — most hosts treat those as part of the key.');
  }
  process.stdout.write('Contacting api.open.fec.gov… ');

  const result = await fec.checkKey();
  console.log(result.ok ? 'ok' : 'failed');
  console.log(`\n${result.ok ? '✓' : '✗'} ${result.message}`);

  if (result.ok && result.usingOwnKey) {
    // Prove the key is doing real work, not just returning 200.
    try {
      const found = await fec.searchCandidates('Ossoff', { limit: 3 });
      console.log(`\nSample live query returned ${found.length} candidate(s):`);
      for (const c of found) console.log(`  • ${c.name} — ${c.officeFull || c.office}${c.state ? `, ${c.state}` : ''}`);
    } catch (err) {
      console.warn(`\n⚠  Key works but a sample query failed: ${err.message}`);
    }
  }
  process.exit(result.ok ? 0 : 1);
})();
