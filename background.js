const ALERT_URL = "https://www.oref.org.il/warningMessages/alert/alerts.json";
const ALARM_NAME = "red-alert-poll";
const POLL_MINUTES = 1;

function normalize(text) {
  return (text || "")
    .toLowerCase()
    .replace(/[\u0591-\u05C7]/g, "")
    .replace(/["'`.,]/g, "")
    .trim();
}

async function getConfig() {
  const state = await chrome.storage.sync.get({
    manualLocation: "",
    lastAlertSignature: ""
  });

  return {
    location: state.manualLocation || "",
    lastAlertSignature: state.lastAlertSignature || ""
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

async function fetchAlerts() {
  const response = await fetch(ALERT_URL, {
    headers: {
      Accept: "application/json, text/plain, */*",
      "X-Requested-With": "XMLHttpRequest"
    },
    cache: "no-store"
  });

  if (!response.ok) {
    throw new Error(`Alert fetch failed: ${response.status}`);
  }

  const payloadText = await response.text();
  return parseAlertPayload(payloadText);
}

function findLocationHit(alertData, selectedLocation) {
  const items = Array.isArray(alertData?.data) ? alertData.data : [];
  const selectedNorm = normalize(selectedLocation);
  if (!selectedNorm) {
    return false;
  }

  return items.some((item) => {
    const itemNorm = normalize(item);
    return itemNorm.includes(selectedNorm) || selectedNorm.includes(itemNorm);
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

async function pollAlerts(options = {}) {
  const forceNotify = Boolean(options.forceNotify);

  const { location, lastAlertSignature } = await getConfig();
  if (!location) {
    return { result: "missing_location" };
  }

  const alertData = await fetchAlerts();
  const hit = findLocationHit(alertData, location);
  if (!hit) {
    return { result: "not_matched", location };
  }

  const signature = `${alertData?.id || ""}|${alertData?.alertDate || ""}|${location}`;
  if (!forceNotify && signature && signature === lastAlertSignature) {
    return { result: "already_notified", location };
  }

  await showNotification(alertData, location, forceNotify);
  await chrome.storage.sync.set({ lastAlertSignature: signature });
  return { result: "matched", location };
}

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.alarms.clear(ALARM_NAME);
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: POLL_MINUTES });
  try {
    await pollAlerts();
  } catch (err) {
    console.warn("Red Alert first poll failed", err);
  }
});

chrome.runtime.onStartup.addListener(async () => {
  const alarm = await chrome.alarms.get(ALARM_NAME);
  if (!alarm) {
    chrome.alarms.create(ALARM_NAME, { periodInMinutes: POLL_MINUTES });
  }
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_NAME) {
    return;
  }

  try {
    await pollAlerts();
  } catch (err) {
    console.warn("Red Alert polling failed", err);
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
    pollAlerts({ forceNotify: true })
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((err) => sendResponse({ ok: false, error: err.message || "Server check failed." }));
    return true;
  }

  return false;
});
