const blockToggle = document.getElementById("blockToggle");
const lifetimeCount = document.getElementById("lifetimeCount");
const reloadButton = document.getElementById("reloadButton");
const siteLabel = document.getElementById("siteLabel");
const statusText = document.getElementById("statusText");
const signalCard = document.getElementById("signalCard");
const signalTitle = document.getElementById("signalTitle");
const signalHint = document.getElementById("signalHint");
const toggleRemark = document.getElementById("toggleRemark");
const debugCard = document.getElementById("debugCard");
const debugLog = document.getElementById("debugLog");

let activeTabId = null;
let currentSiteSupported = false;

function applyTheme(theme) {
  document.body.dataset.theme = theme;
}

function queryActiveTab() {
  return new Promise((resolve, reject) => {
    chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }

      resolve(tabs[0] || null);
    });
  });
}

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }

      resolve(response);
    });
  });
}

function setBusy(isBusy) {
  blockToggle.disabled = isBusy || activeTabId === null || !currentSiteSupported;
  reloadButton.disabled = isBusy || activeTabId === null || !currentSiteSupported;
}

function formatCount(value) {
  const numericValue = Number(value);

  if (!Number.isFinite(numericValue) || numericValue < 0) {
    return "0";
  }

  return String(Math.floor(numericValue));
}

function renderMetric(state) {
  lifetimeCount.textContent = formatCount(state?.lifetimeSecondLayerCount);
}

function formatDebugEntry(entry) {
  if (!entry || typeof entry.message !== "string") {
    return "";
  }

  const entryTime = new Date(entry.time);
  const timeLabel = Number.isNaN(entryTime.getTime())
    ? "--:--:--"
    : entryTime.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit"
      });

  return `[${timeLabel}] ${entry.message}`;
}

function renderDebugTrace(state) {
  const entries = Array.isArray(state?.debugTrace) ? state.debugTrace : [];
  debugCard.hidden = entries.length === 0;
  debugLog.textContent = entries.map(formatDebugEntry).filter(Boolean).join("\n");
}

function renderSignal(variant, title, hint) {
  signalCard.dataset.variant = variant;
  signalTitle.textContent = title;
  signalHint.textContent = hint;
}

function renderUnsupported(message) {
  currentSiteSupported = false;
  applyTheme("grey");
  blockToggle.checked = false;
  blockToggle.disabled = true;
  reloadButton.hidden = true;
  reloadButton.disabled = true;
  toggleRemark.hidden = true;
  debugCard.hidden = true;
  debugLog.textContent = "";
  statusText.hidden = false;
  lifetimeCount.textContent = "--";
  siteLabel.textContent = message;
  renderSignal(
    "neutral",
    "This page is not configurable",
    "Chrome internal pages and similar URLs do not expose a normal website base URL."
  );
  statusText.textContent = "Blocking is off here because this page cannot be stored as a site rule.";
}

function renderState(state) {
  if (!state?.supported || !state.baseUrl) {
    renderUnsupported("This page is not supported.");
    return;
  }

  const canShowRestoreControls = state.enabled !== true && state.everEnabled === true;
  const hasObservedPopupBehavior = state.hasObservedPopupBehavior === true;
  const theme = state.enabled ? "green" : hasObservedPopupBehavior ? "yellow" : "grey";

  currentSiteSupported = true;
  applyTheme(theme);
  blockToggle.checked = state.enabled === true;
  reloadButton.hidden = !canShowRestoreControls;
  toggleRemark.hidden = !canShowRestoreControls;
  renderMetric(state);
  renderDebugTrace(state);
  siteLabel.textContent = `Current website: ${state.baseUrl}`;

  if (state.enabled) {
    renderSignal(
      "success",
      hasObservedPopupBehavior
        ? "Auto-open new tabs are being blocked on this site"
        : "Blocking is on for this site",
      hasObservedPopupBehavior
        ? "This site has tried to open new tabs before, and protection is actively blocking it now."
        : "Protection is active on this site and will block popup-opening behavior if it appears."
    );
  } else if (hasObservedPopupBehavior) {
    renderSignal(
      "warning",
      "This site tries to open new tabs",
      "This site has tried to open new tabs before. Turn blocking on to stop it before a popup fully launches."
    );
  } else {
    renderSignal(
      "neutral",
      "No auto-open new-tab behavior detected yet",
      "If this site tries it later, we will flag it here so you can turn protection on."
    );
  }

  if (state.enabled) {
    statusText.hidden = false;
    statusText.textContent = "Blocking is on for this site.";
    return;
  }

  if (canShowRestoreControls) {
    statusText.hidden = false;
    statusText.textContent = "Reload to restore the site's original behavior, including auto-opening new tabs.";
    return;
  }

  statusText.hidden = true;
  statusText.textContent = "";
}

async function loadState() {
  try {
    const activeTab = await queryActiveTab();

    if (!activeTab || typeof activeTab.id !== "number") {
      renderUnsupported("No active browser tab was found.");
      return;
    }

    activeTabId = activeTab.id;
    setBusy(true);
    const state = await sendMessage({
      type: "getTabState",
      tabId: activeTabId
    });
    renderState(state);
  } catch (error) {
    renderUnsupported("Unable to read this page.");
    statusText.textContent = error.message;
  } finally {
    setBusy(false);
  }
}

blockToggle.addEventListener("change", async () => {
  if (activeTabId === null) {
    return;
  }

  setBusy(true);

  try {
    const state = await sendMessage({
      type: "setTabBlocking",
      tabId: activeTabId,
      enabled: blockToggle.checked
    });
    renderState(state);
  } catch (error) {
    statusText.textContent = error.message;
  } finally {
    setBusy(false);
  }
});

reloadButton.addEventListener("click", () => {
  if (activeTabId === null) {
    return;
  }

  chrome.tabs.reload(activeTabId, () => {
    if (chrome.runtime.lastError) {
      statusText.textContent = chrome.runtime.lastError.message;
    }
  });
});

void loadState();
