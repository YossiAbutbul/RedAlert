const ALERT_URL = "https://www.oref.org.il/warningMessages/alert/alerts.json";
const ALARM_NAME = "red-alert-wake";

const POLL = {
  fastMs: 5000,
  normalMs: 15000,
  slowMs: 30000,
  activeWindowMs: 2 * 60 * 1000,
  fetchTimeoutMs: 7000,
  notifyCooldownMs: 90 * 1000
};

const runtimeState = {
  isPolling: false,
  timerId: null,
  activeUntil: 0,
  etag: "",
  lastModified: "",
  lastFeedSignature: "",
  consecutiveNoChange: 0,
  lastResult: "init"
};

function normalize(text) {
  return (text || "")
    .toLowerCase()
    .replace(/[\u0591-\u05C7]/g, "")
    .replace(/["'`.,]/g, "")
    .replace(/[-–—_/\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(text) {
  return normalize(text)
    .split(" ")
    .map((t) => t.trim())
    .filter(Boolean);
}

async function getConfig() {
  const state = await chrome.storage.sync.get({
    manualLocation: "",
    lastAlertSignature: "",
    lastNotificationAt: 0
  });

  return {
    location: state.manualLocation || "",
    lastAlertSignature: state.lastAlertSignature || "",
    lastNotificationAt: Number(state.lastNotificationAt || 0)
  };
}

function parseAlertPayload(rawText) {
  const text = (rawText || "").trim().replace(/^\uFEFF/, "");
  if (!text) {
    return { data: [], title: "", id: "", alertDate: "" };
  }

  try {
    return JSON.parse(text);
  } catch {
    const firstBrace = text.indexOf("{");
    const lastBrace = text.lastIndexOf("}");
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      const candidate = text.slice(firstBrace, lastBrace + 1);
      try {
        return JSON.parse(candidate);
      } catch {
      }
    }
    throw new Error("Alert feed response is not valid JSON");
  }
}

function buildFeedSignature(alertData) {
  const items = Array.isArray(alertData?.data) ? [...alertData.data].sort() : [];
  return `${alertData?.id || ""}|${alertData?.alertDate || ""}|${items.join(",")}`;
}

async function fetchAlerts() {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), POLL.fetchTimeoutMs);

  try {
    const headers = {
      Accept: "application/json, text/plain, */*",
      "X-Requested-With": "XMLHttpRequest"
    };

    if (runtimeState.etag) {
      headers["If-None-Match"] = runtimeState.etag;
    }
    if (runtimeState.lastModified) {
      headers["If-Modified-Since"] = runtimeState.lastModified;
    }

    const response = await fetch(ALERT_URL, {
      headers,
      cache: "no-store",
      signal: controller.signal
    });

    if (response.status === 304) {
      return { notModified: true };
    }

    if (!response.ok) {
      throw new Error(`Alert fetch failed: ${response.status}`);
    }

    runtimeState.etag = response.headers.get("etag") || runtimeState.etag;
    runtimeState.lastModified = response.headers.get("last-modified") || runtimeState.lastModified;

    const payloadText = await response.text();
    const data = parseAlertPayload(payloadText);
    return { notModified: false, data };
  } finally {
    clearTimeout(timeoutId);
  }
}

function findLocationHit(alertData, selectedLocation) {
  const items = Array.isArray(alertData?.data) ? alertData.data : [];
  const selectedNorm = normalize(selectedLocation);
  if (!selectedNorm) {
    return false;
  }

  const stopWords = new Set(["העיר", "מרכז", "דרום", "צפון", "מזרח", "מערב"]);
  const selectedTokens = tokenize(selectedNorm).filter((t) => t.length > 1 && !stopWords.has(t));

  return items.some((item) => {
    const itemNorm = normalize(item);

    if (itemNorm.includes(selectedNorm) || selectedNorm.includes(itemNorm)) {
      return true;
    }

    const itemTokens = new Set(tokenize(itemNorm));
    let overlap = 0;

    for (const token of selectedTokens) {
      if (itemTokens.has(token) || itemNorm.includes(token)) {
        overlap += 1;
      }
    }

    // For multi-word locations (e.g. "תל אביב יפו"), require at least 2 matching tokens.
    const needed = selectedTokens.length >= 2 ? 2 : 1;
    return overlap >= needed;
  });
}

function createNotification(options) {
  return new Promise((resolve, reject) => {
    chrome.notifications.create(options, (notificationId) => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error(err.message));
        return;
      }
      resolve(notificationId);
    });
  });
}

async function showNotification(alertData, location, isTest = false) {
  const testPrefix = isTest ? "[TEST] " : "";
  await createNotification({
    type: "basic",
    iconUrl: "icon128.png",
    title: `${testPrefix}Red Alert`,
    message: `Alert in ${location}. ${alertData?.title || ""}`,
    priority: 2
  });
}

function decideNextIntervalMs() {
  const now = Date.now();

  if (now < runtimeState.activeUntil) {
    return POLL.fastMs;
  }

  if (runtimeState.lastResult === "error") {
    return POLL.normalMs;
  }

  if (runtimeState.consecutiveNoChange >= 4) {
    return POLL.slowMs;
  }

  return POLL.normalMs;
}

function scheduleNextPoll() {
  if (runtimeState.timerId) {
    clearTimeout(runtimeState.timerId);
    runtimeState.timerId = null;
  }

  const delay = decideNextIntervalMs();
  runtimeState.timerId = setTimeout(() => {
    pollAlerts({ source: "timer" }).catch((err) => {
      console.warn("Red Alert timer poll failed", err);
    });
  }, delay);
}

async function pollAlerts(options = {}) {
  const forceNotify = Boolean(options.forceNotify);

  if (runtimeState.isPolling && !forceNotify) {
    return { result: "busy" };
  }

  runtimeState.isPolling = true;
  try {
    const { location, lastAlertSignature, lastNotificationAt } = await getConfig();
    if (!location) {
      runtimeState.lastResult = "missing_location";
      runtimeState.consecutiveNoChange += 1;
      return { result: "missing_location" };
    }

    const fetchResult = await fetchAlerts();
    if (fetchResult.notModified) {
      runtimeState.lastResult = "not_modified";
      runtimeState.consecutiveNoChange += 1;
      return { result: "not_modified", location };
    }

    const alertData = fetchResult.data;
    const feedSignature = buildFeedSignature(alertData);

    if (feedSignature && feedSignature === runtimeState.lastFeedSignature) {
      runtimeState.lastResult = "unchanged_feed";
      runtimeState.consecutiveNoChange += 1;
      const hit = findLocationHit(alertData, location);
      return { result: hit ? "already_notified" : "not_matched", location };
    }

    runtimeState.lastFeedSignature = feedSignature;
    runtimeState.consecutiveNoChange = 0;

    const hit = findLocationHit(alertData, location);
    if (!hit) {
      runtimeState.lastResult = "not_matched";
      return { result: "not_matched", location };
    }

    const signature = `${alertData?.id || ""}|${alertData?.alertDate || ""}|${location}`;
    const now = Date.now();
    const stillInCooldown = now - lastNotificationAt < POLL.notifyCooldownMs;

    if (!forceNotify && signature && signature === lastAlertSignature && stillInCooldown) {
      runtimeState.lastResult = "already_notified";
      runtimeState.activeUntil = now + POLL.activeWindowMs;
      return { result: "already_notified", location };
    }

    await showNotification(alertData, location, forceNotify);
    await chrome.storage.sync.set({
      lastAlertSignature: signature,
      lastNotificationAt: now
    });

    runtimeState.activeUntil = now + POLL.activeWindowMs;
    runtimeState.lastResult = "matched";
    return { result: "matched", location };
  } catch (err) {
    runtimeState.lastResult = "error";
    runtimeState.consecutiveNoChange += 1;
    throw err;
  } finally {
    runtimeState.isPolling = false;
    scheduleNextPoll();
  }
}

async function ensureWakeAlarm() {
  const alarm = await chrome.alarms.get(ALARM_NAME);
  if (!alarm) {
    chrome.alarms.create(ALARM_NAME, { periodInMinutes: 1 });
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.alarms.clear(ALARM_NAME);
  await ensureWakeAlarm();
  try {
    await pollAlerts({ source: "install" });
  } catch (err) {
    console.warn("Red Alert first poll failed", err);
  }
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureWakeAlarm();
  scheduleNextPoll();
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_NAME) {
    return;
  }

  try {
    await pollAlerts({ source: "alarm" });
  } catch (err) {
    console.warn("Red Alert wake poll failed", err);
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "NOTIFICATION_PERMISSION") {
    chrome.notifications.getPermissionLevel((level) => {
      sendResponse({ ok: true, level });
    });
    return true;
  }

  if (message?.type === "TEST_NOTIFICATION") {
    showNotification({ title: "System test" }, "your selected location", true)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message || "Failed to send notification." }));
    return true;
  }

  if (message?.type === "POLL_NOW") {
    pollAlerts({ forceNotify: true, source: "manual" })
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((err) => sendResponse({ ok: false, error: err.message || "Server check failed." }));
    return true;
  }

  return false;
});

ensureWakeAlarm().catch((err) => {
  console.warn("Failed to initialize wake alarm", err);
});


