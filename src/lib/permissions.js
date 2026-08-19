/**
 * Resolving what an account is allowed to do.
 *
 * Roles group permissions; permissions are the contract. Everything in the
 * codebase and in the portal checks a permission, never a role name, so
 * regrouping roles later is a data change rather than a code change.
 *
 * Two rules here are not conveniences and should not be relaxed:
 *
 *   - **An expired grant confers nothing.** `user_roles.expires_at` is checked
 *     on every resolution, so surge staffing during a campaign season can be
 *     granted for ninety days and then simply stop working.
 *
 *   - **`pii.export_bulk` requires an expiry.** It is granted to no role at
 *     all, so reaching it takes a deliberate per-user grant — and a grant
 *     with no end date is refused here even if somebody inserts one. There is
 *     no standing ability to download the subscriber list, and making that
 *     true in code rather than in a policy document is the point.
 */

const db = require('../db');

const CACHE_TTL_MS = 60_000;
const cache = new Map(); // userId -> { permissions:Set, roles:[], expires }

/** Permissions that can only ever come from a time-boxed grant. */
const REQUIRE_EXPIRY = new Set(['pii.export_bulk']);

/** Permissions that additionally need a recent re-authentication. */
let stepUpCache = null;

async function stepUpPermissions() {
  if (stepUpCache) return stepUpCache;
  const rows = await db.rows('SELECT key FROM permissions WHERE needs_step_up');
  stepUpCache = new Set(rows.map((r) => r.key));
  return stepUpCache;
}

/**
 * Everything `userId` can do right now.
 *
 * Cached briefly. The window means a revoked role stays live for up to a
 * minute, which is the right trade for a check that would otherwise run on
 * every request — except for revocation, where `invalidate()` is called
 * directly and the wait is zero.
 */
async function resolve(userId) {
  if (!userId || !db.enabled()) return { permissions: new Set(), roles: [] };

  const hit = cache.get(userId);
  if (hit && hit.expires > Date.now()) return hit;

  const rows = await db.rows(
    `SELECT ur.role_key, ur.expires_at, rp.permission_key
       FROM user_roles ur
       JOIN role_permissions rp ON rp.role_key = ur.role_key
      WHERE ur.user_id = $1
        AND (ur.expires_at IS NULL OR ur.expires_at > now())`,
    [userId]
  );

  const permissions = new Set();
  const roles = new Set();
  for (const row of rows) {
    roles.add(row.role_key);
    if (REQUIRE_EXPIRY.has(row.permission_key) && !row.expires_at) continue;
    permissions.add(row.permission_key);
  }

  // Direct per-user grants of a single permission, for the ones no role
  // carries. Same expiry rule.
  const direct = await db.rows(
    `SELECT permission_key, expires_at FROM user_permissions
      WHERE user_id = $1 AND (expires_at IS NULL OR expires_at > now())`,
    [userId]
  ).catch(() => []);

  for (const row of direct) {
    if (REQUIRE_EXPIRY.has(row.permission_key) && !row.expires_at) continue;
    permissions.add(row.permission_key);
  }

  const entry = { permissions, roles: [...roles], expires: Date.now() + CACHE_TTL_MS };
  cache.set(userId, entry);
  return entry;
}

/** Drop a user's cached permissions. Called on every grant and revoke. */
function invalidate(userId) {
  if (userId === undefined) cache.clear();
  else cache.delete(userId);
}

const has = async (userId, permission) => (await resolve(userId)).permissions.has(permission);

/* ---------------- middleware ---------------- */

/**
 * Require a permission.
 *
 * Three distinct refusals, because collapsing them makes the portal unable to
 * say anything useful:
 *   401 — no session at all.
 *   403 — a real session that lacks the permission. The body names it.
 *   428 — has the permission, but it needs a fresh re-authentication.
 *
 * Every denial is audited. An account probing for permissions it does not
 * hold is precisely the pattern worth being able to see afterwards.
 */
function requirePermission(permission) {
  return async function permissionGate(req, res, next) {
    const audit = require('./audit');

    if (!req.user) {
      const err = new Error('Sign in to do that.');
      err.status = 401;
      return next(err);
    }

    try {
      const { permissions, roles } = await resolve(req.user.id);

      if (!permissions.has(permission)) {
        await audit.write({
          req,
          actorUserId: req.user.id,
          actorRole: roles.join(','),
          action: 'permission.denied',
          objectType: 'permission',
          objectId: permission,
          outcome: 'denied',
        });
        const err = new Error(`This action needs the "${permission}" permission, which your account does not have.`);
        err.status = 403;
        err.code = 'PB_FORBIDDEN';
        err.permission = permission;
        return next(err);
      }

      const stepUp = await stepUpPermissions();
      if (stepUp.has(permission) && !isElevated(req.session)) {
        const err = new Error('Confirm it is you before doing that. Sign in again to continue.');
        err.status = 428;
        err.code = 'PB_STEP_UP_REQUIRED';
        err.permission = permission;
        return next(err);
      }

      req.permissions = permissions;
      req.roles = roles;
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

const isElevated = (session) =>
  Boolean(session?.elevated_until && new Date(session.elevated_until) > new Date());

/** For tests, which must not inherit another suite's cached roles. */
function __reset() {
  cache.clear();
  stepUpCache = null;
}

module.exports = { resolve, has, invalidate, requirePermission, isElevated, __reset, REQUIRE_EXPIRY };
