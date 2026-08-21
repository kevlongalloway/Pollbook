# Pollbook Portal

The staff-facing frontend: subscriber support, broadcast drafting and
approval, deliverability, and the audit log.

**Nothing is built here yet — this directory is a scaffold.** The API it calls
exists and is documented below.

## How it is served

The portal is its own frontend project, but it is served **from the same
origin** as the public site: `server.js` mounts `portal/dist/` (or `portal/`
if there is no build step) at `/admin`, and the SPA fallback for `/admin/*`
serves the portal's own `index.html`.

That is a deliberate choice. Same-origin means the session cookie just works:
no CORS preflights, no bearer tokens, no refresh-token rotation, and no access
token sitting in `localStorage` waiting for an XSS. If the portal ever needs
its own subdomain, add a CORS allowlist and `SameSite=None; Secure` then — but
there is no reason to pay that cost now.

The mount is guarded: until this directory contains an `index.html`, the mount
is a no-op and `/admin` falls through to the public SPA. You can build here
without touching `server.js`.

## Building it

There is no prescribed stack. The public site is deliberately dependency-free
vanilla JS with no bundler, and you are welcome to do the same here — but the
portal has genuinely different needs (tables, forms, an approval queue), so a
build step is reasonable. Two rules:

1. **Output to `portal/dist/`** (add it to `.gitignore`) or write plain files
   directly in `portal/`. `server.js` prefers `dist/` when it exists.
2. **Do not import from `public/`.** If you want the design tokens, copy the
   `:root` block out of `public/css/styles.css`. A shared import would couple
   two projects that should be able to move independently.

## Talking to the API

Every request needs the session cookie and, for anything that changes state,
the CSRF header:

```js
const res = await fetch('/api/admin/broadcasts', {
  method: 'POST',
  credentials: 'same-origin',
  headers: {
    'content-type': 'application/json',
    'x-pollbook-csrf': document.cookie.match(/(?:^|;\s*)pb_csrf=([^;]+)/)?.[1] ?? '',
  },
  body: JSON.stringify(draft),
});
```

Sign-in is the same flow as the public site — send the user to
`/api/auth/email/start` or the OAuth entry points, with
`redirect_to=/admin`. There is no separate staff login.

`401` means no session. `403` means the session is real but the account lacks
the permission — the body names which one, so the UI can say "you need
`broadcast.approve`" instead of "forbidden". `428` means the action needs
step-up authentication: send the user back through sign-in and retry.

## Permissions the UI has to respect

`GET /api/me` returns `permissions: []` for the signed-in account. Render
against that rather than against role names — roles are a grouping, permissions
are the contract.

| Role | Holds | Notably does **not** hold |
|---|---|---|
| `viewer` | aggregates, drafts, read-only | anything that writes |
| `editor` | `broadcast.draft`, `template.draft`, `taxonomy.propose` | any subscriber data; cannot send or approve |
| `analyst` | `metrics.export_aggregate`, `deliverability.read` | any subscriber data |
| `support` | `pii.read_single`, `subscription.edit_on_behalf`, `suppression.add` | listing or exporting subscribers; sending |
| `approver` | `broadcast.approve`, `template.approve` | **`broadcast.draft`** — cannot approve their own words |
| `sender` | `broadcast.send`, `send.killswitch` | drafting, approving |
| `compliance` | `consent.read`, `audit.read`, `dsar.*`, `taxonomy.approve` | sending anything |
| `admin` | config, jobs, `roles.grant`, `audit.read` | **sending broadcasts, and subscriber PII** |
| `owner` | `roles.grant_any` | — |

Two of those are load-bearing and the UI should not paper over them:

- **`admin` cannot send or read subscriber data.** A compromised engineering
  account must not be able to text the list or download it.
- **`approver` cannot draft.** The two-person rule is a CHECK constraint on
  `broadcasts` (`approved_by <> created_by`); the role split is what stops one
  person holding both legs.

`pii.export_bulk` is granted to **no role**. Getting it requires an `owner` to
make a deliberate, time-boxed, audited grant, and `lib/permissions.js` refuses
to resolve it from a grant with no expiry. Build the UI assuming there is no
"download all subscribers" button, because there isn't one.

## The endpoints

Read:

- `GET /api/admin/metrics` — aggregate counts. Cells below a minimum size are
  suppressed rather than rounded.
- `GET /api/admin/deliverability` — bounce, complaint, delivery rates by
  channel and provider.
- `GET /api/admin/subscribers/lookup?email=` / `?phone=` — **exact match
  only**, one record. There is no listing endpoint and no wildcard. Every call
  writes an `audit_log` row naming the actor and the subject.
- `GET /api/admin/broadcasts`, `GET /api/admin/broadcasts/:id`
- `GET /api/admin/audit` — the log, filterable by actor, action, subject.
- `GET /api/admin/jobs` — scheduler state and last-run results.

Write:

- `POST /api/admin/broadcasts` — create a draft. The response carries the
  neutrality report; a `block` finding means it cannot be submitted.
- `POST /api/admin/broadcasts/:id/lint` — re-run the linter and the
  candidate-balance rule without saving.
- `POST /api/admin/broadcasts/:id/submit` — move to `pending_approval`.
- `POST /api/admin/broadcasts/:id/approve` — needs `broadcast.approve`, a
  different account from the author, and an acknowledgement for every `warn`
  finding. Records the hash of exactly what was read.
- `POST /api/admin/broadcasts/:id/send` — needs `broadcast.send`. Re-renders
  and re-hashes; a body that changed since approval aborts the send.
- `POST /api/admin/send/pause`, `POST /api/admin/send/killswitch`
- `POST /api/admin/suppressions`
- `POST /api/admin/issues` — taxonomy changes. `taxonomy.propose` creates a
  proposal; `taxonomy.approve` applies it.
- `POST /api/admin/roles` — grants. `admin` can grant below `admin`; only
  `owner` can grant `admin`.

## The audience selector

`broadcast_audience` has exactly six columns: `subject_keys`,
`include_seat_rollup`, `issue_slugs`, `state_codes`, `channels`,
`active_since_days`. There is no free-form filter field, no saved-segment
table, and no raw-SQL escape hatch.

This is not an oversight to work around — **it is the mechanism that makes the
nonpartisan claim structurally true.** There is no way to express "Republicans
in Georgia" because there is nowhere to type it and, since `users` has no
party column, nothing to type it against. If a request arrives to add
targeting the schema cannot express, that request is the thing to push back
on.

Build the audience UI as: pick races/elections, pick issues, pick states, pick
channels. Show the estimated reach from `POST /api/admin/broadcasts/:id/preview`.

## What the approval screen owes the approver

The approval flow is the last place a mistake is cheap, so show all of it:

- The rendered message, exactly as it will arrive, per channel.
- The neutrality report — every finding, its severity, and the span it matched.
- The **balance report**: which candidates the copy names, which ones the rule
  required, and in what order they appear. Names must be alphabetical by
  surname; ordering by odds or by incumbency is a thumb on the scale that
  nobody notices.
- The audience criteria in words, and the recipient count.
- Who wrote it, and when.
