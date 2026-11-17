import { getEnvConfig } from '../config/env.js';
import { core } from '../config/permissions.js';
import { badRequest, serviceUnavailable } from '../utils/errors.js';
import { formatDisplayDate, nowIso, todayDateStr, currentTime24Str } from '../utils/dateUtils.js';
import { normalizeStr, toNumber } from '../utils/validators.js';
import { gasClient } from './gasClient.js';

const FIRST_PAGE = 0;
const PAGE_SIZE = 50;
const MAX_PAGES = 200;
const PARALLEL_PAGE_BATCH = 8;

let runtimeRgToken = '';

function pickValue(obj, keys) {
  if (!obj || typeof obj !== 'object') return '';
  for (const key of keys) {
    const val = obj[key];
    if (val !== undefined && val !== null && String(val).trim() !== '') {
      return val;
    }
  }
  return '';
}

async function resolveActiveRgToken() {
  if (runtimeRgToken) return runtimeRgToken;
  const envCfg = getEnvConfig();
  if (envCfg.rgApiToken) return envCfg.rgApiToken;

  const settingsRes = await gasClient.list('settings').catch(() => ({ items: [] }));
  const tokenRec = (settingsRes?.items || []).find((s) => s.key === 'rg_api_token');
  const fromSettings = normalizeStr(tokenRec?.value);
  if (fromSettings) return fromSettings;

  // Fallback to RG_TOKEN stored in Google Apps Script Script Properties (server-to-server)
  const gasFallback = await gasClient.getRgTokenFallback();
  const fromGas = normalizeStr(gasFallback?.token);
  if (fromGas) {
    runtimeRgToken = fromGas;
    return fromGas;
  }
  return '';
}

function extractPagePayload(body, pageIndex) {
  let rows = [];
  let container = body;

  if (Array.isArray(body)) {
    rows = body;
  } else if (body && typeof body === 'object') {
    if (Array.isArray(body.content)) rows = body.content;
    else if (Array.isArray(body.items)) rows = body.items;
    else if (Array.isArray(body.results)) rows = body.results;
    else if (Array.isArray(body.reservations)) rows = body.reservations;
    else {
      const nested = body.data || body.result || body.payload;
      if (Array.isArray(nested)) {
        rows = nested;
      } else if (nested && typeof nested === 'object') {
        container = nested;
        if (Array.isArray(nested.content)) rows = nested.content;
        else if (Array.isArray(nested.items)) rows = nested.items;
        else if (Array.isArray(nested.data)) rows = nested.data;
        else if (Array.isArray(nested.results)) rows = nested.results;
      }
    }
  }

  const rawTotalPages =
    container?.totalPages ??
    container?.page?.totalPages ??
    container?.meta?.last_page ??
    container?.pagination?.last_page ??
    container?.last_page ??
    body?.totalPages ??
    body?.page?.totalPages ??
    body?.meta?.last_page ??
    body?.pagination?.last_page ??
    body?.last_page;

  const hasExplicitTotalPages =
    rawTotalPages !== undefined &&
    rawTotalPages !== null &&
    !Number.isNaN(Number(rawTotalPages)) &&
    Number(rawTotalPages) > 0;

  const totalPages = hasExplicitTotalPages ? Number(rawTotalPages) : 0;
  const isLast =
    container?.last === true ||
    body?.last === true ||
    rows.length === 0 ||
    (hasExplicitTotalPages && pageIndex + 1 >= totalPages);

  return { rows, totalPages, isLast };
}

async function fetchRgEndpoint(url, token, page = FIRST_PAGE, size = PAGE_SIZE) {
  const fullUrl = new URL(url);
  fullUrl.searchParams.set('page', String(page));
  fullUrl.searchParams.set('size', String(size));

  const res = await fetch(fullUrl.toString(), {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      lang: 'ar',
    },
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`خطأ من Rental Gate API (${res.status}): ${text.slice(0, 200)}`);
  }
  return JSON.parse(text);
}

async function fetchAllRgPages(url, token, idKeys) {
  const all = [];
  const seen = new Set();

  const appendUniqueRows = (rows) => {
    let added = 0;
    for (const item of rows) {
      const id = normalizeStr(pickValue(item, idKeys));
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      all.push(item);
      added++;
    }
    return added;
  };

  const first = await fetchRgEndpoint(url, token, FIRST_PAGE, PAGE_SIZE);
  const info0 = extractPagePayload(first, FIRST_PAGE);
  appendUniqueRows(info0.rows);
  let pagesFetched = 1;

  if (info0.isLast || info0.rows.length === 0) {
    return { items: all, pagesFetched };
  }

  if (info0.totalPages > 1) {
    const lastPage = Math.min(FIRST_PAGE + info0.totalPages - 1, FIRST_PAGE + MAX_PAGES - 1);
    for (let start = FIRST_PAGE + 1; start <= lastPage; start += PARALLEL_PAGE_BATCH) {
      const end = Math.min(start + PARALLEL_PAGE_BATCH - 1, lastPage);
      const pageNums = [];
      for (let p = start; p <= end; p++) pageNums.push(p);

      const bodies = await Promise.all(
        pageNums.map((p) => fetchRgEndpoint(url, token, p, PAGE_SIZE))
      );
      pagesFetched += bodies.length;

      let shouldStop = false;
      for (let i = 0; i < bodies.length; i++) {
        const info = extractPagePayload(bodies[i], pageNums[i]);
        if (info.rows.length === 0) {
          shouldStop = true;
          break;
        }
        const added = appendUniqueRows(info.rows);
        if (added === 0 || info.isLast) {
          shouldStop = true;
          break;
        }
      }
      if (shouldStop) break;
    }
  } else {
    // Unknown totalPages: page sequentially until empty or duplicate page
    for (let p = FIRST_PAGE + 1; p < FIRST_PAGE + MAX_PAGES; p++) {
      const body = await fetchRgEndpoint(url, token, p, PAGE_SIZE);
      pagesFetched++;
      const info = extractPagePayload(body, p);
      if (info.rows.length === 0) break;
      const added = appendUniqueRows(info.rows);
      if (added === 0 || info.isLast) break;
    }
  }

  return { items: all, pagesFetched };
}

async function upsertInChunks(resource, keyField, records, chunkSize = 400) {
  for (let i = 0; i < records.length; i += chunkSize) {
    const slice = records.slice(i, i + chunkSize);
    await gasClient.upsertBatch(resource, keyField, slice);
  }
}

export async function saveRgApiToken(token, testAfterSave = false) {
  const clean = normalizeStr(token).replace(/^Bearer\s+/i, '');
  if (!clean || clean.length < 16 || /\s/.test(clean)) {
    throw badRequest('صيغة التوكن غير صالحة. يرجى لصق التوكن كاملاً بدون مسافات.');
  }

  runtimeRgToken = clean;
  await gasClient.upsertBatch('settings', 'key', [
    { key: 'rg_api_token', value: clean, updatedBy: 'server', updatedAt: nowIso() },
  ]);

  const result = { saved: true, hasToken: true, hasRgToken: true };
  if (testAfterSave) {
    result.connection = await testRgConnection();
  }
  return result;
}

export async function testRgConnection() {
  const token = await resolveActiveRgToken();
  if (!token) {
    return {
      connected: false,
      hasToken: false,
      message: 'مفتاح RG_API_TOKEN غير مضبوط في إعدادات الخادم.',
    };
  }
  const { rgReservationsApi } = getEnvConfig();
  try {
    await fetchRgEndpoint(rgReservationsApi, token, FIRST_PAGE, 2);
    return {
      connected: true,
      hasToken: true,
      checkedAt: nowIso(),
      message: 'الاتصال بواجهة Rental Gate API ناجح ويعمل بشكل سليم.',
    };
  } catch (err) {
    return {
      connected: false,
      hasToken: true,
      checkedAt: nowIso(),
      message: err?.message || String(err),
    };
  }
}

export async function syncRentalGateReservations(actor) {
  const startedAt = Date.now();
  const token = await resolveActiveRgToken();
  if (!token) {
    throw serviceUnavailable('لم يتم ضبط توكن Rental Gate API (RG_API_TOKEN) في إعدادات الخادم.');
  }

  const { rgReservationsApi, rgExtendsApi } = getEnvConfig();
  const [resFetch, extFetch, existingSnap] = await Promise.all([
    fetchAllRgPages(rgReservationsApi, token, ['reservationId', 'reservationNumber', 'reservation_number', 'id']),
    fetchAllRgPages(rgExtendsApi, token, ['extendId', 'extensionNumber', 'extension_number', 'id']),
    gasClient.snapshot(['reservations', 'settings'], true),
  ]);

  const settingsMap = {};
  (existingSnap.settings || []).forEach((s) => { settingsMap[s.key] = s.value; });
  let excludedStatuses = ['draft', 'test', 'abandoned'];
  try {
    const parsedExcl = JSON.parse(settingsMap.excluded_statuses || '[]');
    if (Array.isArray(parsedExcl)) excludedStatuses = parsedExcl.map((x) => normalizeStr(x).toLowerCase());
  } catch {}

  const existingByResNum = {};
  (existingSnap.reservations || []).forEach((r) => {
    existingByResNum[normalizeStr(r.reservationNumber)] = r;
  });

  const acceptedExtByRes = {};
  const extRecords = [];
  const rawExts = core.dedupeExtensionsByNumber(extFetch.items);
  for (const ext of rawExts) {
    const ok = core.isExtensionAcceptedAndPaid(ext);
    const resNum = normalizeStr(ext.reservationNumber || ext.reservation_number || ext.reservationId);
    const extIdVal = normalizeStr(ext.extendId || ext.extensionNumber || ext.extension_number || ext.id);
    const extRec = {
      id: `EXT_${extIdVal}`,
      extensionNumber: extIdVal,
      reservationId: resNum ? `RES_${resNum}` : '',
      reservationNumber: resNum,
      statusCode: normalizeStr(ext.reservationStatus || ext.status),
      statusAr: core.translateOriginalStatus(ext.reservationStatus || ext.status),
      paymentStatus: normalizeStr(ext.paymentStatus || ext.paymentResult || (ok ? 'paid' : 'unpaid')),
      extendDays: toNumber(ext.extendDays || ext.days, 0),
      startDate: formatDisplayDate(ext.extendDate || ext.startDate || ext.createdAt),
      endDate: formatDisplayDate(ext.endDate),
      amount: toNumber(ext.total ?? ext.amount, 0),
      isAcceptedAndPaid: ok ? 'true' : 'false',
      syncedAt: nowIso(),
    };
    extRecords.push(extRec);
    if (ok && resNum) {
      if (!acceptedExtByRes[resNum]) acceptedExtByRes[resNum] = [];
      acceptedExtByRes[resNum].push(extRec);
    }
  }

  const rawRes = core.dedupeReservationsByNumber(resFetch.items);
  const mergedList = [];
  let importedCount = 0;
  let updatedCount = 0;

  for (const item of rawRes) {
    const stCode = normalizeStr(item.reservationStatus || item.status).toLowerCase();
    if (excludedStatuses.includes(stCode)) continue;
    const resNum = normalizeStr(item.reservationNumber || item.reservation_number || item.reservationId || item.code || item.reference || item.id);
    if (!resNum) continue;
    const existing = existingByResNum[resNum] || null;
    if (existing) updatedCount++;
    else importedCount++;

    const merged = core.mergeSyncedReservation(existing, item, acceptedExtByRes[resNum] || [], actor);
    merged.rawJson = '';
    mergedList.push(merged);
  }

  const writeOps = [];
  if (mergedList.length > 0) {
    writeOps.push(upsertInChunks('reservations', 'reservationNumber', mergedList));
  }
  if (extRecords.length > 0) {
    writeOps.push(upsertInChunks('extensions', 'id', extRecords));
  }
  await Promise.all(writeOps);

  const finishedAt = nowIso();
  const syncLog = {
    triggeredById: actor.id,
    triggeredByName: actor.name,
    status: 'success',
    importedCount,
    updatedCount,
    extensionsCount: extRecords.filter((x) => x.isAcceptedAndPaid === 'true').length,
    pagesFetched: resFetch.pagesFetched + extFetch.pagesFetched,
    errorMessage: '',
    durationMs: Date.now() - startedAt,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt,
  };

  await Promise.all([
    gasClient.create('sync_log', syncLog, { allowDuplicate: true }).catch(() => {}),
    gasClient.create('activity_log', {
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      actionType: 'مزامنة Rental Gate',
      entityType: 'Reservation',
      entityId: `SYNC_${importedCount + updatedCount}`,
      details: `تمت المزامنة: ${importedCount} جديد، ${updatedCount} محدث (المسحوب من API: ${rawRes.length})`,
      logDate: todayDateStr(),
      logTime: currentTime24Str(),
    }, { allowDuplicate: true }).catch(() => {}),
  ]);

  return {
    importedCount,
    updatedCount,
    extensionsCount: syncLog.extensionsCount,
    fetchedCount: rawRes.length,
    pagesFetched: syncLog.pagesFetched,
    finishedAt,
  };
}
