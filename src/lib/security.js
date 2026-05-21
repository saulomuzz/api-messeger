const { getPublicSettings } = require('./settings');
const { isIpInList, normalizeIp, nowIso, parsePositiveInt, sha256 } = require('./utils');

function createWindowLimiter() {
  const buckets = new Map();
  return {
    check(key, limit, windowMs) {
      const now = Date.now();
      const current = buckets.get(key);
      if (!current || current.resetAt <= now) {
        buckets.set(key, { count: 1, resetAt: now + windowMs });
        return { ok: true, remaining: limit - 1 };
      }
      if (current.count >= limit) {
        return { ok: false, remaining: 0 };
      }
      current.count += 1;
      return { ok: true, remaining: limit - current.count };
    },
  };
}

function createSecurityService({ db }) {
  const limiter = createWindowLimiter();

  async function getRuntimeSettings() {
    const settings = await getPublicSettings(db);
    return {
      globalAllowlist: settings.security.global_allowlist,
      yellowThreshold: settings.security.yellow_threshold,
      blockThreshold: settings.security.block_threshold,
      reputationTtlMinutes: settings.security.reputation_ttl_minutes,
      globalRateLimitPerMinute: settings.security.global_rate_limit_per_minute,
      abuseKey: settings.abuseipdb.api_key,
    };
  }

  function _whitelistEntry(ip, ttlMinutes) {
    return {
      ip,
      abuseScore: 0,
      category: 'whitelist',
      source: 'disabled',
      payload: {},
      checkedAt: nowIso(),
      expiresAt: new Date(Date.now() + ttlMinutes * 60000).toISOString(),
    };
  }

  async function getOrRefreshIpReputation(ip) {
    const normalized = normalizeIp(ip);
    const settings = await getRuntimeSettings();
    return _whitelistEntry(normalized, settings.reputationTtlMinutes);
  }

  async function lookupIp(ip) {
    const normalized = normalizeIp(ip);
    const reputation = await getOrRefreshIpReputation(normalized);
    return {
      blocked: await db.getBlockedIp(normalized),
      reputation,
    };
  }

  async function recheckIp(ip) {
    return getOrRefreshIpReputation(ip, { force: true });
  }

  async function allowIpForClient({ clientId, ip, notes }) {
    await db.setClientAllowedIp({
      clientId,
      ipOrCidr: normalizeIp(ip),
      notes,
    });
  }

  async function blockIp({ ip, reason, source }) {
    await db.blockIp({
      ip: normalizeIp(ip),
      reason,
      source,
    });
  }

  async function authenticateClient({ token, ip }) {
    const normalizedIp = normalizeIp(ip);
    const client = await db.findApiClientByTokenHash(sha256(token));
    if (!client) {
      return {
        ok: false,
        httpStatus: 401,
        errorCode: 'INVALID_TOKEN',
        message: 'Invalid bearer token.',
        authStatus: 'invalid_token',
        securityDecision: 'deny_invalid_token',
      };
    }
    if (client.status !== 'active') {
      return {
        ok: false,
        httpStatus: 403,
        errorCode: 'CLIENT_DISABLED',
        message: 'Client is disabled.',
        authStatus: 'client_disabled',
        securityDecision: 'deny_client_disabled',
      };
    }

    const settings = await getRuntimeSettings();
    const rateLimit = parsePositiveInt(client.rate_limit_per_minute, 60);
    const rateByClient = limiter.check(`client:${client.id}`, rateLimit, 60000);
    const rateByIp = limiter.check(`client:${client.id}:ip:${normalizedIp}`, settings.globalRateLimitPerMinute, 60000);
    if (!rateByClient.ok || !rateByIp.ok) {
      return {
        ok: false,
        httpStatus: 429,
        errorCode: 'RATE_LIMITED',
        message: 'Too many requests for this client or IP.',
        authStatus: 'rate_limited',
        securityDecision: 'deny_rate_limit',
      };
    }

    const blocked = await db.getBlockedIp(normalizedIp);
    if (blocked) {
      return {
        ok: false,
        httpStatus: 403,
        errorCode: 'IP_BLOCKED',
        message: 'Source IP is blocked.',
        details: blocked,
        authStatus: 'blocked_ip',
        securityDecision: 'deny_blocked_ip',
      };
    }

    const clientAllowedIps = (await db.listClientAllowedIps(client.id)).map((row) => row.ip_or_cidr);
    if (isIpInList(normalizedIp, clientAllowedIps) || isIpInList(normalizedIp, settings.globalAllowlist)) {
      await db.touchApiClient(client.id);
      return {
        ok: true,
        client,
        ipDecision: {
          ip: normalizedIp,
          category: 'whitelist',
          source: 'allowlist',
        },
        authStatus: 'ok',
        securityDecision: 'allow_allowlist',
      };
    }

    const reputation = await getOrRefreshIpReputation(normalizedIp);
    if (reputation.category === 'blacklist') {
      return {
        ok: false,
        httpStatus: 403,
        errorCode: 'IP_BLOCKED_BY_REPUTATION',
        message: 'Source IP blocked by reputation policy.',
        details: reputation,
        authStatus: 'blocked_reputation',
        securityDecision: 'deny_blacklist',
      };
    }

    await db.touchApiClient(client.id);
    return {
      ok: true,
      client,
      ipDecision: reputation,
      authStatus: 'ok',
      securityDecision: reputation.category === 'yellowlist' ? 'allow_yellowlist' : 'allow_whitelist',
    };
  }

  return {
    allowIpForClient,
    authenticateClient,
    blockIp,
    getRuntimeSettings,
    lookupIp,
    recheckIp,
  };
}

module.exports = {
  createSecurityService,
};
