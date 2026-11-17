import { getEnvConfig } from '../config/env.js';
import { AppError, badRequest, conflict, notFound, serviceUnavailable } from '../utils/errors.js';

const CACHE_TTL_MS = 45_000;
const resourceCache = new Map();
const resourceEpoch = new Map();
const inFlightRequests = new Map();
let lastMetaState = { hasRgToken: false };

const RELATED_RESOURCES = {
  employees: ['users'],
  users: ['employees'],
  problems: ['issues'],
  issues: ['problems'],
};

function cacheKey(gasUrl, resource) {
  return `${String(gasUrl || '').trim()}::${String(resource || '').trim().toLowerCase()}`;
}

function getEpoch(key) {
  return resourceEpoch.get(key) || 0;
}

function bumpEpoch(key) {
  resourceEpoch.set(key, (resourceEpoch.get(key) || 0) + 1);
  resourceCache.delete(key);
}

function getFreshCachedItems(gasUrl, resource) {
  const key = cacheKey(gasUrl, resource);
  const entry = resourceCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > CACHE_TTL_MS) {
    resourceCache.delete(key);
    return null;
  }
  return entry.items;
}

function setCachedItems(gasUrl, resource, items, expectedEpoch) {
  if (!Array.isArray(items)) return;
  const key = cacheKey(gasUrl, resource);
  if (expectedEpoch !== undefined && getEpoch(key) !== expectedEpoch) return;
  resourceCache.set(key, {
    items,
    cachedAt: Date.now(),
  });
}

function invalidateResourceAndRelated(gasUrl, resource) {
  const norm = String(resource || '').trim().toLowerCase();
  if (!norm) return;
  bumpEpoch(cacheKey(gasUrl, norm));
  const related = RELATED_RESOURCES[norm] || [];
  for (const rel of related) {
    bumpEpoch(cacheKey(gasUrl, rel));
  }
}

function runSingleflight(flightKey, factory) {
  const existing = inFlightRequests.get(flightKey);
  if (existing) return existing;
  const promise = Promise.resolve()
    .then(factory)
    .finally(() => {
      if (inFlightRequests.get(flightKey) === promise) {
        inFlightRequests.delete(flightKey);
      }
    });
  inFlightRequests.set(flightKey, promise);
  return promise;
}

function mapGasError(message, code) {
  const msg = String(message || 'خطأ في الاتصال بقاعدة بيانات Google Sheets.');
  const cleanCode = String(code || '');

  if (msg.startsWith('DUPLICATE_RECORD:') || cleanCode === 'DUPLICATE_RECORD') {
    return conflict(msg.replace(/^DUPLICATE_RECORD:\s*/, ''));
  }
  if (msg.startsWith('NOT_FOUND:') || cleanCode === 'NOT_FOUND') {
    return notFound(msg.replace(/^NOT_FOUND:\s*/, ''));
  }
  if (msg.startsWith('VALIDATION:') || cleanCode === 'VALIDATION') {
    return badRequest(msg.replace(/^VALIDATION:\s*/, ''));
  }
  if (msg.startsWith('UNAUTHORIZED:') || cleanCode === 'UNAUTHORIZED') {
    return new AppError(502, 'GAS_UNAUTHORIZED', 'فشل التحقق مع خادم Google Apps Script (تحقق من GAS_API_SECRET).');
  }
  return new AppError(502, cleanCode || 'GAS_ERROR', msg);
}

async function callGasEndpoint(method, paramsOrBody) {
  const { gasWebAppUrl, gasApiSecret } = getEnvConfig();
  if (!gasWebAppUrl) {
    throw serviceUnavailable(
      'لم يتم ضبط رابط Google Apps Script Web App (GAS_WEB_APP_URL) في متغيرات البيئة الخاصة بالخادم.',
      'GAS_NOT_CONFIGURED'
    );
  }

  let res;
  try {
    if (method === 'GET') {
      const url = new URL(gasWebAppUrl);
      const queryObj = { ...(paramsOrBody || {}) };
      if (gasApiSecret) queryObj.secret = gasApiSecret;
      for (const [k, v] of Object.entries(queryObj)) {
        if (v !== undefined && v !== null && v !== '') {
          url.searchParams.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
        }
      }
      res = await fetch(url.toString(), {
        method: 'GET',
        redirect: 'follow',
        headers: { Accept: 'application/json' },
      });
    } else {
      const payloadBody = {
        ...(paramsOrBody || {}),
        _method: method,
        secret: gasApiSecret || undefined,
      };
      res = await fetch(gasWebAppUrl, {
        method: 'POST',
        redirect: 'follow',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payloadBody),
      });
    }
  } catch (err) {
    throw serviceUnavailable(
      `تعذر الاتصال بخادم Google Apps Script: ${err?.message || String(err)}`,
      'GAS_NETWORK_ERROR'
    );
  }

  const text = await res.text();
  if (!text || text.trim().startsWith('<')) {
    throw new AppError(
      502,
      'GAS_INVALID_RESPONSE',
      'أعاد خادم Google Apps Script استجابة HTML أو استجابة فارغة. تحقق من رابط /exec وصلاحيات النشر (Anyone).'
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new AppError(502, 'GAS_INVALID_JSON', 'تعذر قراءة استجابة JSON من Google Apps Script.');
  }

  if (!parsed || !parsed.success) {
    throw mapGasError(parsed?.message || parsed?.error, parsed?.error);
  }

  return parsed.data;
}

export const gasClient = {
  isConfigured() {
    return Boolean(getEnvConfig().gasWebAppUrl);
  },

  clearCache() {
    resourceCache.clear();
    inFlightRequests.clear();
    for (const k of resourceEpoch.keys()) {
      resourceEpoch.set(k, (resourceEpoch.get(k) || 0) + 1);
    }
  },

  primeResourceCache(resource, items) {
    const { gasWebAppUrl } = getEnvConfig();
    if (!gasWebAppUrl || !Array.isArray(items)) return;
    setCachedItems(gasWebAppUrl, resource, items);
  },

  async health() {
    return callGasEndpoint('POST', { action: 'engine_health' });
  },

  async getRgTokenFallback() {
    return callGasEndpoint('POST', { action: 'engine_rg_token' }).catch(() => ({ token: '' }));
  },

  async initDatabase() {
    this.clearCache();
    return callGasEndpoint('POST', { action: 'engine_init' });
  },

  async snapshot(resources = [], skipCache = false) {
    const { gasWebAppUrl } = getEnvConfig();
    const wanted = Array.isArray(resources) && resources.length > 0
      ? resources
      : [
          'employees', 'customers', 'reservations', 'extensions',
          'followups', 'followup_history', 'problems', 'problem_updates',
          'tasks', 'activity_log', 'notifications', 'settings', 'roles', 'permissions', 'sync_log',
        ];

    const result = {};
    const missing = [];

    if (!skipCache) {
      for (const resName of wanted) {
        const cached = getFreshCachedItems(gasWebAppUrl, resName);
        if (cached !== null) {
          result[resName] = cached;
        } else {
          missing.push(resName);
        }
      }
      if (missing.length === 0) {
        result._meta = {
          hasRgToken: Boolean(lastMetaState.hasRgToken),
          timestamp: new Date().toISOString(),
          fromCache: true,
        };
        return result;
      }
    } else {
      missing.push(...wanted);
    }

    const epochMap = {};
    for (const r of missing) {
      epochMap[r] = getEpoch(cacheKey(gasWebAppUrl, r));
    }

    const flightKey = `SNAP::${gasWebAppUrl}::${skipCache ? 'skip' : 'cached'}::${[...missing].sort().join(',')}`;
    const fetched = await runSingleflight(flightKey, () =>
      callGasEndpoint('POST', {
        action: 'engine_snapshot',
        payload: { resources: missing, skipCache },
      })
    );

    if (fetched?._meta) {
      lastMetaState = { ...fetched._meta };
    }

    for (const resName of missing) {
      const items = Array.isArray(fetched?.[resName]) ? fetched[resName] : [];
      result[resName] = items;
      setCachedItems(gasWebAppUrl, resName, items, epochMap[resName]);
    }

    result._meta = fetched?._meta || {
      hasRgToken: Boolean(lastMetaState.hasRgToken),
      timestamp: new Date().toISOString(),
    };
    return result;
  },

  async list(resource, query = {}) {
    const { gasWebAppUrl } = getEnvConfig();
    const cleanQuery = { ...(query || {}) };
    const wantsSkip = cleanQuery.skipCache === true || cleanQuery.skipCache === 'true';
    const hasFilter = Object.keys(cleanQuery).some(
      (k) => k !== 'skipCache' && cleanQuery[k] !== undefined && cleanQuery[k] !== null && cleanQuery[k] !== ''
    );

    if (!wantsSkip && !hasFilter) {
      const cached = getFreshCachedItems(gasWebAppUrl, resource);
      if (cached !== null) {
        return { items: cached, total: cached.length };
      }
      const key = cacheKey(gasWebAppUrl, resource);
      const epochBefore = getEpoch(key);
      return runSingleflight(`LIST::${key}`, async () => {
        const res = await callGasEndpoint('GET', { resource });
        const items = Array.isArray(res?.items) ? res.items : [];
        setCachedItems(gasWebAppUrl, resource, items, epochBefore);
        return { items, total: res?.total ?? items.length };
      });
    }

    const key = cacheKey(gasWebAppUrl, resource);
    const epochBefore = !hasFilter ? getEpoch(key) : undefined;
    const res = await callGasEndpoint('GET', { resource, ...cleanQuery });
    if (!hasFilter && Array.isArray(res?.items)) {
      setCachedItems(gasWebAppUrl, resource, res.items, epochBefore);
    }
    return res;
  },

  async get(resource, id) {
    const { gasWebAppUrl } = getEnvConfig();
    const cached = getFreshCachedItems(gasWebAppUrl, resource);
    const idField = resource === 'settings' || resource === 'permissions'
      ? 'key'
      : resource === 'sessions'
        ? 'tokenHash'
        : 'id';

    if (cached !== null) {
      const match = cached.find((item) => String(item?.[idField] || '') === String(id));
      if (match) return { item: match };
    }

    // For employees (used frequently in auth middleware), fetch & cache the full sheet once
    if (String(resource).toLowerCase() === 'employees') {
      const listRes = await this.list('employees');
      const match = (listRes?.items || []).find((item) => String(item?.id || '') === String(id));
      if (!match) {
        throw notFound('السجل غير موجود.');
      }
      return { item: match };
    }

    return callGasEndpoint('GET', { resource, id });
  },

  async create(resource, payload, options = {}) {
    const { gasWebAppUrl } = getEnvConfig();
    const res = await callGasEndpoint('POST', {
      resource,
      allowDuplicate: Boolean(options.allowDuplicate),
      payload,
    });
    invalidateResourceAndRelated(gasWebAppUrl, resource);
    return res;
  },

  async update(resource, id, payload) {
    const { gasWebAppUrl } = getEnvConfig();
    const res = await callGasEndpoint('PUT', {
      resource,
      id,
      payload,
    });
    invalidateResourceAndRelated(gasWebAppUrl, resource);
    return res;
  },

  async remove(resource, id) {
    const { gasWebAppUrl } = getEnvConfig();
    const res = await callGasEndpoint('DELETE', {
      resource,
      id,
    });
    invalidateResourceAndRelated(gasWebAppUrl, resource);
    return res;
  },

  async upsertBatch(resource, keyField, records) {
    const { gasWebAppUrl } = getEnvConfig();
    const res = await callGasEndpoint('POST', {
      action: 'engine_upsert_batch',
      resource,
      payload: { keyField, records },
    });
    invalidateResourceAndRelated(gasWebAppUrl, resource);
    return res;
  },
};
