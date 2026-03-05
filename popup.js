const storageKeys = {
  manualLocation: "manualLocation"
};

const FALLBACK_LOCATIONS = [
  "תל אביב יפו", "תל אביב - מרכז העיר", "תל אביב - דרום העיר ויפו", "תל אביב - עבר הירקון", "תל אביב - מזרח",
  "ירושלים", "חיפה", "באר שבע", "אשדוד", "אשקלון", "ראשון לציון", "פתח תקווה", "נתניה", "חולון", "בני ברק",
  "רמת גן", "גבעתיים", "בת ים", "הרצליה", "רעננה", "כפר סבא", "הוד השרון", "רמת השרון", "מודיעין מכבים רעות",
  "רחובות", "לוד", "רמלה", "נס ציונה", "קריית אונו", "אור יהודה", "יהוד מונוסון", "גני תקווה", "ראש העין",
  "שוהם", "אלעד", "בית דגן", "אזור", "סביון", "פלמחים", "קריית אתא", "קריית ביאליק", "קריית מוצקין", "קריית ים",
  "עכו", "נהריה", "טבריה", "צפת", "אילת", "דימונה", "יבנה", "שדרות", "נתיבות", "אופקים", "רהט"
];

const manualLocationInput = document.getElementById("manualLocation");
const locationSuggestions = document.getElementById("locationSuggestions");
const manualHintText = document.getElementById("manualHint");
const saveBtn = document.getElementById("saveBtn");
const testNotificationBtn = document.getElementById("testNotificationBtn");
const pollNowBtn = document.getElementById("pollNowBtn");
const closePopupBtn = document.getElementById("closePopupBtn");
const testResultText = document.getElementById("testResult");
const statusText = document.getElementById("status");
const effectiveLocationText = document.getElementById("effectiveLocation");

let manualAutocompleteTimer = null;
let manualAutocompleteAbort = null;
let currentSuggestions = [];
let activeSuggestionIndex = -1;
let latestSuggestionQueryId = 0;

function setStatus(message, isError = false) {
  statusText.textContent = message;
  statusText.style.color = isError ? "#b91c1c" : "#166534";
}

function setTestResult(message, isError = false) {
  testResultText.textContent = message;
  testResultText.style.color = isError ? "#b91c1c" : "#166534";
}

function normalize(text) {
  return (text || "")
    .toLowerCase()
    .replace(/[-–—_/\\]/g, " ")
    .replace(/[׳'"`]/g, "")
    .replace(/יי/g, "י")
    .replace(/\s+/g, " ")
    .trim();
}

function matchesQuery(name, query) {
  const n = normalize(name);
  const q = normalize(query);
  return Boolean(q) && n.includes(q);
}

function getFallbackSuggestions(query, limit = 8) {
  const q = normalize(query);
  if (!q) {
    return [];
  }

  return FALLBACK_LOCATIONS.filter((name) => matchesQuery(name, q)).slice(0, limit);
}

function closeSuggestionMenu() {
  locationSuggestions.classList.remove("open");
  manualLocationInput.setAttribute("aria-expanded", "false");
  activeSuggestionIndex = -1;
}

function openSuggestionMenu() {
  if (currentSuggestions.length === 0) {
    closeSuggestionMenu();
    return;
  }

  locationSuggestions.classList.add("open");
  manualLocationInput.setAttribute("aria-expanded", "true");
}

function applySuggestion(index) {
  const value = currentSuggestions[index];
  if (!value) {
    return;
  }

  manualLocationInput.value = value;
  closeSuggestionMenu();
}

function updateActiveSuggestion(nextIndex) {
  const buttons = [...locationSuggestions.querySelectorAll(".suggestion-item")];
  if (buttons.length === 0) {
    activeSuggestionIndex = -1;
    return;
  }

  activeSuggestionIndex = Math.max(0, Math.min(nextIndex, buttons.length - 1));
  buttons.forEach((btn, idx) => {
    btn.classList.toggle("active", idx === activeSuggestionIndex);
  });

  const activeBtn = buttons[activeSuggestionIndex];
  if (activeBtn) {
    activeBtn.scrollIntoView({ block: "nearest" });
  }
}

function renderLocationSuggestions(options) {
  currentSuggestions = options;
  locationSuggestions.innerHTML = "";

  options.forEach((name, idx) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "suggestion-item";
    button.setAttribute("role", "option");
    button.textContent = name;
    button.addEventListener("mousedown", (event) => {
      event.preventDefault();
      applySuggestion(idx);
    });
    locationSuggestions.appendChild(button);
  });

  openSuggestionMenu();
}

async function checkNotificationPermission() {
  try {
    const response = await chrome.runtime.sendMessage({ type: "NOTIFICATION_PERMISSION" });
    const level = response && response.level;
    if (level !== "granted") {
      setTestResult("Chrome notifications are blocked by browser/OS settings.", true);
      return false;
    }
    return true;
  } catch {
    setTestResult("Could not check notification permission.", true);
    return false;
  }
}

function extractNameFromNominatimItem(item) {
  const a = item.address || {};
  return (
    a.city ||
    a.town ||
    a.village ||
    a.suburb ||
    a.municipality ||
    a.state_district ||
    item.name ||
    item.display_name ||
    ""
  );
}

async function fetchLocationSuggestions(query) {
  const local = getFallbackSuggestions(query, 8);

  if (manualAutocompleteAbort) {
    manualAutocompleteAbort.abort();
  }

  manualAutocompleteAbort = new AbortController();

  try {
    const response = await fetch(
      `https://nominatim.openstreetmap.org/search?format=jsonv2&countrycodes=il&addressdetails=1&limit=8&accept-language=he&q=${encodeURIComponent(query)}`,
      {
        headers: { Accept: "application/json" },
        signal: manualAutocompleteAbort.signal
      }
    );

    if (!response.ok) {
      return local;
    }

    const rows = await response.json();
    const unique = new Set(local);

    rows.forEach((item) => {
      const name = extractNameFromNominatimItem(item).trim();
      if (name && matchesQuery(name, query)) {
        unique.add(name);
      }
    });

    return [...unique].filter((name) => matchesQuery(name, query)).slice(0, 10);
  } catch (err) {
    if (err && err.name === "AbortError") {
      throw err;
    }
    return local;
  }
}

async function loadState() {
  const state = await chrome.storage.sync.get({
    [storageKeys.manualLocation]: ""
  });

  manualLocationInput.value = state[storageKeys.manualLocation] || "";
  effectiveLocationText.textContent = state[storageKeys.manualLocation]
    ? `Active location: ${state[storageKeys.manualLocation]}`
    : "No active location defined.";
}

manualLocationInput.addEventListener("input", () => {
  const query = manualLocationInput.value.trim();
  const queryId = ++latestSuggestionQueryId;

  if (manualAutocompleteTimer) {
    clearTimeout(manualAutocompleteTimer);
  }

  if (query.length < 2) {
    renderLocationSuggestions([]);
    manualHintText.textContent = "Type at least 2 letters for suggestions.";
    manualHintText.style.color = "#52525b";
    return;
  }

  manualHintText.textContent = "Searching suggestions...";
  manualHintText.style.color = "#52525b";

  manualAutocompleteTimer = setTimeout(async () => {
    try {
      const suggestions = await fetchLocationSuggestions(query);
      if (queryId !== latestSuggestionQueryId) {
        return;
      }
      if (normalize(manualLocationInput.value) !== normalize(query)) {
        return;
      }

      renderLocationSuggestions(suggestions);

      if (suggestions.length === 0) {
        manualHintText.textContent = "No suggestions found. You can still save free text.";
      } else {
        manualHintText.textContent = `Found ${suggestions.length} suggestions. Pick one from the list.`;
      }
      manualHintText.style.color = "#52525b";
    } catch (err) {
      if (err && err.name === "AbortError") {
        return;
      }
      if (queryId !== latestSuggestionQueryId) {
        return;
      }
      renderLocationSuggestions(getFallbackSuggestions(query, 8));
      manualHintText.textContent = "Could not load online suggestions. Showing local list.";
      manualHintText.style.color = "#b91c1c";
    }
  }, 250);
});

manualLocationInput.addEventListener("keydown", (event) => {
  if (!locationSuggestions.classList.contains("open")) {
    return;
  }

  if (event.key === "ArrowDown") {
    event.preventDefault();
    updateActiveSuggestion(activeSuggestionIndex + 1);
    return;
  }

  if (event.key === "ArrowUp") {
    event.preventDefault();
    updateActiveSuggestion(activeSuggestionIndex - 1);
    return;
  }

  if (event.key === "Enter" && activeSuggestionIndex >= 0) {
    event.preventDefault();
    applySuggestion(activeSuggestionIndex);
    return;
  }

  if (event.key === "Escape") {
    closeSuggestionMenu();
  }
});

manualLocationInput.addEventListener("focus", () => {
  if (currentSuggestions.length > 0) {
    openSuggestionMenu();
  }
});

manualLocationInput.addEventListener("blur", () => {
  setTimeout(() => {
    closeSuggestionMenu();
  }, 100);
});

saveBtn.addEventListener("click", async () => {
  const manualLocation = manualLocationInput.value.trim();
  if (!manualLocation) {
    setStatus("Please enter a location before saving.", true);
    return;
  }

  await chrome.storage.sync.set({ [storageKeys.manualLocation]: manualLocation });
  effectiveLocationText.textContent = `Active location: ${manualLocation}`;
  setStatus("Settings saved.");
});

testNotificationBtn.addEventListener("click", async () => {
  const permissionOk = await checkNotificationPermission();
  if (!permissionOk) {
    return;
  }

  setTestResult("Sending test notification...");

  try {
    const response = await chrome.runtime.sendMessage({ type: "TEST_NOTIFICATION" });
    if (!response || !response.ok) {
      setTestResult((response && response.error) || "Test notification failed.", true);
      return;
    }

    setTestResult("Test notification sent.");
  } catch {
    setTestResult("Communication error with background service.", true);
  }
});

pollNowBtn.addEventListener("click", async () => {
  setTestResult("Checking alert server now...");

  try {
    const response = await chrome.runtime.sendMessage({ type: "POLL_NOW" });
    if (!response || !response.ok) {
      setTestResult((response && response.error) || "Server check failed.", true);
      return;
    }

    if (response.result === "matched") {
      setTestResult(`Match found for "${response.location}" and notification sent.`);
      return;
    }

    if (response.result === "not_matched") {
      setTestResult(`No current match for "${response.location}".`);
      return;
    }

    if (response.result === "missing_location") {
      setTestResult("No active location set. Save location first.", true);
      return;
    }

    if (response.result === "already_notified") {
      setTestResult(`Already notified for "${response.location}" in current event.`);
      return;
    }

    setTestResult("Check completed.");
  } catch {
    setTestResult("Communication error with background service.", true);
  }
});

if (closePopupBtn) {
  closePopupBtn.addEventListener("click", () => {
    window.close();
  });
}

document.addEventListener("mousedown", (event) => {
  if (!event.target.closest(".location-field")) {
    closeSuggestionMenu();
  }
});

loadState();
checkNotificationPermission();
