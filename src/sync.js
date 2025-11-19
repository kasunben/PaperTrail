// Lightweight offline-first persistence for PaperTrail.
// We cache snapshots locally and sync to the server when online.

const CACHE_PREFIX = "papertrail-board";
// Sovereign expects /api/plugins/{pluginName}/...
const DEFAULT_ENDPOINT = "/api/plugins/papertrail";

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function cacheKey(projectId) {
  return `${CACHE_PREFIX}:${projectId}`;
}

export async function loadCache(projectId) {
  try {
    const raw = localStorage.getItem(cacheKey(projectId));
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function saveCache(projectId, snapshot) {
  try {
    localStorage.setItem(cacheKey(projectId), JSON.stringify(snapshot));
  } catch {
    /* ignore quota errors */
  }
}

async function jsonFetch(url, options = {}) {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    try {
      err.body = await res.json();
    } catch {
      err.body = null;
    }
    throw err;
  }
  return res.json();
}

export async function fetchBoard(projectId, endpoint = DEFAULT_ENDPOINT) {
  return jsonFetch(`${endpoint}/boards/${encodeURIComponent(projectId)}`);
}

export async function createBoard(projectId, payload, endpoint = DEFAULT_ENDPOINT) {
  return jsonFetch(`${endpoint}/boards/${encodeURIComponent(projectId)}`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function saveBoard(projectId, payload, endpoint = DEFAULT_ENDPOINT) {
  return jsonFetch(`${endpoint}/boards/${encodeURIComponent(projectId)}`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

// Retry helper for online resume
export function onOnline(cb) {
  window.addEventListener("online", cb);
  return () => window.removeEventListener("online", cb);
}

// Debounced saver with retry queue
export function createSaver({ projectId, endpoint = DEFAULT_ENDPOINT, debounceMs = 1200, onConflict }) {
  let timer = null;
  let lastVersion = null;
  let pending = null;
  let busy = false;
  let retryTimer = null;

  const flush = async () => {
    if (!pending || busy) return;
    busy = true;
    const snapshot = pending;
    pending = null;
    const payload = {
      ...snapshot,
      version: lastVersion || snapshot.version,
    };
    try {
      const res = await saveBoard(projectId, payload, endpoint);
      lastVersion = res.version;
      await saveCache(projectId, { ...res, cachedAt: new Date().toISOString() });
    } catch (err) {
      if (err?.status === 409 && typeof onConflict === "function") {
        await onConflict(err, payload, { setVersion, saveCache, lastVersion });
      }
      // Put back to pending and retry when online
      pending = payload;
      if (!retryTimer) {
        retryTimer = setTimeout(() => {
          retryTimer = null;
          flush();
        }, 5000);
      }
      if (process.env.NODE_ENV !== "production") {
        console.warn("[papertrail] save failed, will retry", err);
      }
      busy = false;
      return;
    }
    busy = false;
    if (pending) flush();
  };

  const schedule = (snapshot) => {
    pending = {
      ...snapshot,
      version: lastVersion || snapshot.version,
    };
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, debounceMs);
  };

  const setVersion = (v) => {
    lastVersion = v;
  };

  const forceFlush = async () => {
    if (timer) clearTimeout(timer);
    await flush();
  };

  return { schedule, forceFlush, setVersion };
}
