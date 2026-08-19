-- The issue taxonomy.
--
-- Every name here is a **subject area, not a position.** That distinction is
-- the whole point and it is not pedantry: "reproductive health policy" and
-- "the right to life" describe the same bills, and choosing between them
-- announces a side before a single word of copy is written. The same trap
-- sits in "voting access" versus "election integrity", "firearms policy"
-- versus "gun rights", "immigration policy" versus "border security".
--
-- So the rule, enforced by test/nonpartisan.js against a list of
-- position-coded phrases: an issue is named the way a librarian would name
-- it, not the way an advocate would. Where a neutral name exists in the
-- Congressional Research Service's own policy-area vocabulary, that one wins,
-- since CRS is already the neutral summary source the Bills page relies on.
--
-- The matching patterns that map bills and headlines onto these slugs live in
-- src/data/issues.js. A test asserts the two lists carry identical slugs, so
-- they cannot drift apart.

INSERT INTO issues (slug, name, description, sort_order) VALUES
  ('voting-access', 'Voting access and registration',
   'How people register, when and where they can vote, absentee and mail voting, and polling place operations.', 10),

  ('election-administration', 'Election administration',
   'How elections are run and certified: equipment, audits, poll workers, and the officials responsible.', 20),

  ('campaign-finance', 'Campaign finance',
   'How campaigns are funded and what must be disclosed: contribution limits, super PACs, and independent spending.', 30),

  ('redistricting', 'Redistricting and apportionment',
   'How district lines are drawn, the census that drives them, and legal challenges to maps.', 40),

  ('courts-judiciary', 'Courts and the judiciary',
   'Judicial nominations, court structure, and rulings that affect elections and policy.', 50),

  ('civil-rights', 'Civil rights and liberties',
   'Constitutional rights, discrimination law, privacy, and speech.', 60),

  ('health-care', 'Health care',
   'Coverage, cost, prescription drugs, public health, and health insurance programs.', 70),

  ('social-insurance', 'Social Security and Medicare',
   'Retirement and health programs for older Americans, their financing, and proposed changes.', 80),

  ('economy-jobs', 'Economy and jobs',
   'Employment, wages, inflation, trade, and business regulation.', 90),

  ('taxes-budget', 'Taxes and the federal budget',
   'Tax law, federal spending, the deficit, and the appropriations process.', 100),

  ('housing', 'Housing',
   'Housing supply and affordability, mortgages, rental policy, and homelessness.', 110),

  ('education', 'Education',
   'Schools, curriculum policy, higher education, and student loans.', 120),

  ('immigration', 'Immigration',
   'Visas, asylum, border enforcement, and legal status. Named as a policy area, not as a position on it.', 130),

  ('public-safety', 'Public safety and criminal justice',
   'Policing, courts, sentencing, corrections, and crime policy.', 140),

  ('firearms', 'Firearms policy',
   'Laws governing the sale, ownership, and carrying of firearms.', 150),

  ('reproductive-health', 'Reproductive health policy',
   'Laws governing abortion, contraception, and fertility care. Named as a policy area, not as a position on it.', 160),

  ('energy-environment', 'Energy and the environment',
   'Energy production, emissions, conservation, and climate policy.', 170),

  ('transportation-infrastructure', 'Transportation and infrastructure',
   'Roads, transit, rail, aviation, water systems, and broadband.', 180),

  ('agriculture-rural', 'Agriculture and rural policy',
   'Farm programs, food assistance, and rural development.', 190),

  ('labor', 'Labor and the workplace',
   'Wages, workplace safety, organizing rights, and benefits.', 200),

  ('technology-privacy', 'Technology and privacy',
   'Data privacy, artificial intelligence, online platforms, and telecommunications.', 210),

  ('foreign-policy-defense', 'Foreign policy and defense',
   'Diplomacy, treaties, foreign aid, the armed forces, and national security.', 220),

  ('veterans', 'Veterans',
   'Veterans'' health care, benefits, and services.', 230);
