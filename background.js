const STORAGE_KEY = "blockedBaseUrls";
const EVER_ENABLED_KEY = "everEnabledBaseUrls";
const DETECTED_AUTO_OPEN_KEY = "detectedAutoOpenByBaseUrl";
const DETECTED_AUTO_OPEN_VERSION_KEY = "detectedAutoOpenSignalVersion";
const SECOND_LAYER_TOTALS_KEY = "lifetimeSecondLayerBlocksByBaseUrl";
const USER_GESTURE_ALLOWANCES_KEY = "userGestureAllowancesByTab";
const DEBUG_TRACE_KEY = "debugTraceByBaseUrl";
const SOURCE_TAB_RULE_ID_BASE = 1000000;
const POPUP_RULE_ID_BASE = 2000000;
const POPUP_RULES_PER_TAB = 2;
const DETECTED_AUTO_OPEN_VERSION = 2;
const USER_NAVIGATION_INTENT_WINDOW_MS = 2000;
const MAX_USER_NAVIGATION_INTENT_WINDOW_MS = 10000;
const RECENT_POPUP_SIGNAL_WINDOW_MS = 4000;
const DEBUG_TRACE_LIMIT = 20;
const ACTION_ICON_PATHS = {
  neutral: {
    16: "icons/action-grey-16.png",
    32: "icons/action-grey-32.png",
    48: "icons/action-grey-48.png"
  },
  detected: {
    16: "icons/action-yellow-16.png",
    32: "icons/action-yellow-32.png",
    48: "icons/action-yellow-48.png"
  },
  enabled: {
    16: "icons/action-green-16.png",
    32: "icons/action-green-32.png",
    48: "icons/action-green-48.png"
  }
};
const blockedTabs = new Set();
const userInitiatedPopupTabs = new Set();
const recentUserNavigationIntents = new Map();
const recentPopupSignals = new Map();
let storageTask = Promise.resolve();

function getBaseUrl(url) {
  if (typeof url !== "string" || !url) {
    return null;
  }

  try {
    const parsedUrl = new URL(url);
    if (!/^https?:$/i.test(parsedUrl.protocol)) {
      return null;
    }

    return parsedUrl.origin;
  } catch {
    return null;
  }
}

function isInternalUrl(url) {
  return /^(about|chrome|chrome-extension|edge):/i.test(url);
}

function createNavigationMatchKey(url, matchMode = "exactWithoutHash") {
  if (typeof url !== "string" || !url) {
    return null;
  }

  try {
    const parsedUrl = new URL(url);
    if (!/^https?:$/i.test(parsedUrl.protocol)) {
      return null;
    }

    if (matchMode === "sameOriginPath") {
      return `${parsedUrl.origin}${parsedUrl.pathname}`;
    }

    return `${parsedUrl.origin}${parsedUrl.pathname}${parsedUrl.search}`;
  } catch {
    return null;
  }
}

function normalizeUserNavigationIntent(intent) {
  if (!intent || typeof intent !== "object") {
    return null;
  }

  const requestedWindowMs = Number(intent.windowMs);
  const windowMs =
    Number.isFinite(requestedWindowMs) && requestedWindowMs > 0
      ? Math.min(Math.floor(requestedWindowMs), MAX_USER_NAVIGATION_INTENT_WINDOW_MS)
      : USER_NAVIGATION_INTENT_WINDOW_MS;

  if (intent.allowAnyUrl === true) {
    return {
      allowAnyUrl: true,
      windowMs
    };
  }

  const matchMode = intent.matchMode === "sameOriginPath" ? "sameOriginPath" : "exactWithoutHash";
  const matchKey = createNavigationMatchKey(intent.expectedUrl, matchMode);
  if (!matchKey) {
    return null;
  }

  return {
    matchMode,
    matchKey,
    windowMs
  };
}

function queueStorageTask(task) {
  const pendingTask = storageTask.then(task, task);
  storageTask = pendingTask.catch(() => {});
  return pendingTask;
}

function normalizeStoredObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value;
}

function normalizeCount(value) {
  const numericValue = Number(value);

  if (!Number.isFinite(numericValue) || numericValue < 0) {
    return 0;
  }

  return Math.floor(numericValue);
}

function normalizeGestureAllowanceRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const count = normalizeCount(value.count);
  const expiresAt = Number(value.expiresAt);

  if (count <= 0 || !Number.isFinite(expiresAt) || expiresAt <= 0) {
    return null;
  }

  return {
    count,
    expiresAt
  };
}

function normalizeDebugEntries(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((entry) => entry && typeof entry.message === "string" && typeof entry.time === "number")
    .slice(-DEBUG_TRACE_LIMIT);
}

async function readStoredObject(storageArea, key) {
  const stored = await storageArea.get(key);
  return normalizeStoredObject(stored[key]);
}

async function readBlockedBaseUrls() {
  return readStoredObject(chrome.storage.local, STORAGE_KEY);
}

async function readEverEnabledBaseUrls() {
  return readStoredObject(chrome.storage.local, EVER_ENABLED_KEY);
}

async function readDetectedAutoOpenBaseUrls() {
  return readStoredObject(chrome.storage.local, DETECTED_AUTO_OPEN_KEY);
}

async function readSecondLayerTotals() {
  return readStoredObject(chrome.storage.local, SECOND_LAYER_TOTALS_KEY);
}

async function readUserGestureAllowances() {
  return readStoredObject(chrome.storage.session, USER_GESTURE_ALLOWANCES_KEY);
}

async function readDebugTraceByBaseUrl() {
  return readStoredObject(chrome.storage.session, DEBUG_TRACE_KEY);
}

async function syncUserGestureAllowanceRecord(tabId) {
  if (typeof tabId !== "number") {
    return;
  }

  await queueStorageTask(async () => {
    const allowances = await readUserGestureAllowances();
    const tabKey = String(tabId);
    const record = normalizeGestureAllowanceRecord(recentUserNavigationIntents.get(tabId));

    if (record) {
      allowances[tabKey] = record;
    } else {
      delete allowances[tabKey];
    }

    await chrome.storage.session.set({
      [USER_GESTURE_ALLOWANCES_KEY]: allowances
    });
  });
}

async function migrateDetectedAutoOpenSignals() {
  await queueStorageTask(async () => {
    const stored = await chrome.storage.local.get([
      DETECTED_AUTO_OPEN_KEY,
      DETECTED_AUTO_OPEN_VERSION_KEY
    ]);
    const currentVersion = normalizeCount(stored[DETECTED_AUTO_OPEN_VERSION_KEY]);

    if (currentVersion >= DETECTED_AUTO_OPEN_VERSION) {
      return;
    }

    await chrome.storage.local.set({
      [DETECTED_AUTO_OPEN_KEY]: {},
      [DETECTED_AUTO_OPEN_VERSION_KEY]: DETECTED_AUTO_OPEN_VERSION
    });
  });
}

async function appendDebugTrace(baseUrl, message) {
  if (!baseUrl || typeof message !== "string" || !message) {
    return;
  }

  await queueStorageTask(async () => {
    const traceByBaseUrl = await readDebugTraceByBaseUrl();
    const existingEntries = normalizeDebugEntries(traceByBaseUrl[baseUrl]);

    traceByBaseUrl[baseUrl] = [
      ...existingEntries,
      {
        time: Date.now(),
        message
      }
    ].slice(-DEBUG_TRACE_LIMIT);

    await chrome.storage.session.set({
      [DEBUG_TRACE_KEY]: traceByBaseUrl
    });
  });
}

async function getDebugTraceForBaseUrl(baseUrl) {
  if (!baseUrl) {
    return [];
  }

  const traceByBaseUrl = await readDebugTraceByBaseUrl();
  return normalizeDebugEntries(traceByBaseUrl[baseUrl]);
}

async function isBlockingEnabledForBaseUrl(baseUrl) {
  if (!baseUrl) {
    return false;
  }

  const blockedBaseUrls = await readBlockedBaseUrls();
  return blockedBaseUrls[baseUrl] === true;
}

async function hasDetectedAutoOpenForBaseUrl(baseUrl) {
  if (!baseUrl) {
    return false;
  }

  const detectedBaseUrls = await readDetectedAutoOpenBaseUrls();
  return detectedBaseUrls[baseUrl] === true;
}

async function hasEverEnabledForBaseUrl(baseUrl) {
  if (!baseUrl) {
    return false;
  }

  const everEnabledBaseUrls = await readEverEnabledBaseUrls();
  return everEnabledBaseUrls[baseUrl] === true;
}

async function setBlockingEnabledForBaseUrl(baseUrl, enabled) {
  await queueStorageTask(async () => {
    const blockedBaseUrls = await readBlockedBaseUrls();

    if (enabled) {
      blockedBaseUrls[baseUrl] = true;
    } else {
      delete blockedBaseUrls[baseUrl];
    }

    await chrome.storage.local.set({
      [STORAGE_KEY]: blockedBaseUrls
    });
  });
}

async function markEverEnabledForBaseUrl(baseUrl) {
  if (!baseUrl) {
    return false;
  }

  return queueStorageTask(async () => {
    const everEnabledBaseUrls = await readEverEnabledBaseUrls();

    if (everEnabledBaseUrls[baseUrl] === true) {
      return false;
    }

    everEnabledBaseUrls[baseUrl] = true;
    await chrome.storage.local.set({
      [EVER_ENABLED_KEY]: everEnabledBaseUrls
    });

    return true;
  });
}

async function markDetectedAutoOpenForBaseUrl(baseUrl) {
  if (!baseUrl) {
    return false;
  }

  return queueStorageTask(async () => {
    const detectedBaseUrls = await readDetectedAutoOpenBaseUrls();

    if (detectedBaseUrls[baseUrl] === true) {
      return false;
    }

    detectedBaseUrls[baseUrl] = true;
    await chrome.storage.local.set({
      [DETECTED_AUTO_OPEN_KEY]: detectedBaseUrls
    });

    return true;
  });
}

async function incrementSecondLayerBlocks(baseUrl) {
  if (!baseUrl) {
    return 0;
  }

  return queueStorageTask(async () => {
    const secondLayerTotals = await readSecondLayerTotals();
    const nextCount = normalizeCount(secondLayerTotals[baseUrl]) + 1;

    secondLayerTotals[baseUrl] = nextCount;
    await chrome.storage.local.set({
      [SECOND_LAYER_TOTALS_KEY]: secondLayerTotals
    });

    return nextCount;
  });
}

async function getCountsForBaseUrl(baseUrl) {
  if (!baseUrl) {
    return {
      lifetimeSecondLayerCount: 0
    };
  }

  const secondLayerTotals = await readSecondLayerTotals();

  return {
    lifetimeSecondLayerCount: normalizeCount(secondLayerTotals[baseUrl])
  };
}

async function getTabBaseUrl(tabId) {
  if (typeof tabId !== "number") {
    return null;
  }

  try {
    const tab = await chrome.tabs.get(tabId);
    return getBaseUrl(tab.url || tab.pendingUrl || "");
  } catch {
    return null;
  }
}

async function updateBadgeForTab(tabId, baseUrl = undefined) {
  if (typeof tabId !== "number") {
    return;
  }

  const resolvedBaseUrl = baseUrl === undefined ? await getTabBaseUrl(tabId) : baseUrl;

  if (!resolvedBaseUrl) {
    await Promise.all([
      chrome.action.setBadgeText({ tabId, text: "" }),
      chrome.action.setIcon({ tabId, path: ACTION_ICON_PATHS.neutral }),
      chrome.action.setTitle({ tabId, title: "New Tab Blocker" })
    ]);
    return;
  }

  const [enabled, detectedAutoOpen, counts] = await Promise.all([
    isBlockingEnabledForBaseUrl(resolvedBaseUrl),
    hasDetectedAutoOpenForBaseUrl(resolvedBaseUrl),
    getCountsForBaseUrl(resolvedBaseUrl)
  ]);
  const hasObservedPopupBehavior = detectedAutoOpen || counts.lifetimeSecondLayerCount > 0;

  let title = "New Tab Blocker\nBlocking is off for this site";
  let iconPaths = ACTION_ICON_PATHS.neutral;

  if (enabled) {
    title = "New Tab Blocker\nBlocking is on for this site";
    iconPaths = ACTION_ICON_PATHS.enabled;
  } else if (hasObservedPopupBehavior) {
    title = "New Tab Blocker\nThis site has tried to open new tabs\nBlocking is off for this site";
    iconPaths = ACTION_ICON_PATHS.detected;
  }

  await Promise.all([
    chrome.action.setBadgeText({
      tabId,
      text: ""
    }),
    chrome.action.setIcon({
      tabId,
      path: iconPaths
    }),
    chrome.action.setTitle({
      tabId,
      title
    })
  ]);
}

async function updateBadgesForBaseUrl(baseUrl) {
  if (!baseUrl) {
    return;
  }

  try {
    const tabs = await chrome.tabs.query({});
    const matchingTabs = tabs.filter((tab) => {
      return typeof tab.id === "number" && getBaseUrl(tab.url || tab.pendingUrl || "") === baseUrl;
    });

    await Promise.all(
      matchingTabs.map((tab) => updateBadgeForTab(tab.id, baseUrl))
    );
  } catch {
    // Ignore transient tab query errors.
  }
}

async function syncAllTabs() {
  try {
    const tabs = await chrome.tabs.query({});

    await Promise.all(
      tabs
        .filter((tab) => typeof tab.id === "number")
        .map((tab) => syncTabSiteProtection(tab.id, getBaseUrl(tab.url || tab.pendingUrl || "")))
    );
  } catch {
    // Ignore transient tab query errors.
  }
}

async function buildStateForBaseUrl(baseUrl, enabled, detectedAutoOpen, everEnabled) {
  const [counts, debugTrace] = await Promise.all([
    getCountsForBaseUrl(baseUrl),
    getDebugTraceForBaseUrl(baseUrl)
  ]);
  const hasObservedPopupBehavior = detectedAutoOpen === true || counts.lifetimeSecondLayerCount > 0;

  return {
    supported: Boolean(baseUrl),
    baseUrl,
    enabled: enabled === true,
    detectedAutoOpen: detectedAutoOpen === true,
    hasObservedPopupBehavior,
    everEnabled: everEnabled === true,
    debugTrace,
    ...counts
  };
}

async function getTabState(tabId) {
  if (typeof tabId !== "number") {
    return buildStateForBaseUrl(null, false, false, false);
  }

  try {
    const baseUrl = await getTabBaseUrl(tabId);
    const [enabled, detectedAutoOpen, everEnabled] = await Promise.all([
      isBlockingEnabledForBaseUrl(baseUrl),
      hasDetectedAutoOpenForBaseUrl(baseUrl),
      hasEverEnabledForBaseUrl(baseUrl)
    ]);

    return buildStateForBaseUrl(baseUrl, enabled, detectedAutoOpen, everEnabled);
  } catch {
    return buildStateForBaseUrl(null, false, false, false);
  }
}

async function getSenderState(sender) {
  const baseUrl = getBaseUrl(sender.tab?.url || sender.tab?.pendingUrl || "");
  const [enabled, detectedAutoOpen, everEnabled] = await Promise.all([
    isBlockingEnabledForBaseUrl(baseUrl),
    hasDetectedAutoOpenForBaseUrl(baseUrl),
    hasEverEnabledForBaseUrl(baseUrl)
  ]);

  return buildStateForBaseUrl(baseUrl, enabled, detectedAutoOpen, everEnabled);
}

function getSourcePingRuleId(tabId) {
  return SOURCE_TAB_RULE_ID_BASE + tabId;
}

function getPopupPrivacyRuleId(tabId) {
  return POPUP_RULE_ID_BASE + (tabId * POPUP_RULES_PER_TAB);
}

function getPopupBlockRuleId(tabId) {
  return getPopupPrivacyRuleId(tabId) + 1;
}

function getManagedPopupRuleIdsForTab(tabId) {
  return [getPopupPrivacyRuleId(tabId), getPopupBlockRuleId(tabId)];
}

function normalizeManualOpenUrl(url) {
  if (typeof url !== "string" || !url) {
    return null;
  }

  try {
    const parsedUrl = new URL(url);
    if (!/^(https?|about):$/i.test(parsedUrl.protocol)) {
      return null;
    }

    return parsedUrl.href;
  } catch {
    return null;
  }
}

async function installSourceTabProtectionRules(tabId) {
  if (typeof tabId !== "number") {
    return;
  }

  const sourceRuleId = getSourcePingRuleId(tabId);

  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [sourceRuleId],
    addRules: [
      {
        id: sourceRuleId,
        priority: 1,
        action: {
          type: "block"
        },
        condition: {
          regexFilter: "^https?://",
          resourceTypes: ["ping"],
          tabIds: [tabId]
        }
      }
    ]
  });
}

async function removeSourceTabProtectionRules(tabId) {
  if (typeof tabId !== "number") {
    return;
  }

  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [getSourcePingRuleId(tabId)]
    });
  } catch {
    // Ignore cases where rules were already cleared.
  }
}

async function installPopupProtectionRules(tabId) {
  if (typeof tabId !== "number") {
    return;
  }

  const [privacyRuleId, blockRuleId] = getManagedPopupRuleIdsForTab(tabId);

  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [privacyRuleId, blockRuleId],
    addRules: [
      {
        id: privacyRuleId,
        priority: 1,
        action: {
          type: "modifyHeaders",
          requestHeaders: [
            {
              header: "cookie",
              operation: "remove"
            },
            {
              header: "origin",
              operation: "remove"
            },
            {
              header: "referer",
              operation: "remove"
            }
          ]
        },
        condition: {
          regexFilter: "^https?://",
          resourceTypes: ["main_frame"],
          tabIds: [tabId]
        }
      },
      {
        id: blockRuleId,
        priority: 2,
        action: {
          type: "block"
        },
        condition: {
          regexFilter: "^https?://",
          resourceTypes: ["main_frame"],
          tabIds: [tabId]
        }
      }
    ]
  });
}

async function removePopupProtectionRules(tabId) {
  if (typeof tabId !== "number") {
    return;
  }

  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: getManagedPopupRuleIdsForTab(tabId)
    });
  } catch {
    // Ignore cases where rules were already cleared.
  }
}

async function clearManagedSessionRules() {
  try {
    const sessionRules = await chrome.declarativeNetRequest.getSessionRules();
    const managedRuleIds = sessionRules
      .map((rule) => rule.id)
      .filter((ruleId) => ruleId >= SOURCE_TAB_RULE_ID_BASE);

    if (managedRuleIds.length === 0) {
      return;
    }

    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: managedRuleIds
    });
  } catch {
    // Ignore transient startup failures.
  }
}

async function notifyTab(tabId, enabled, baseUrl) {
  if (typeof tabId !== "number") {
    return;
  }

  try {
    await chrome.tabs.sendMessage(tabId, {
      type: "siteSettingChanged",
      enabled,
      baseUrl
    });
  } catch {
    // Ignore tabs that do not have an active content script.
  }
}

async function syncTabSiteProtection(tabId, baseUrl = undefined) {
  if (typeof tabId !== "number") {
    return;
  }

  const resolvedBaseUrl = baseUrl === undefined ? await getTabBaseUrl(tabId) : baseUrl;
  const enabled = await isBlockingEnabledForBaseUrl(resolvedBaseUrl);

  if (enabled && resolvedBaseUrl) {
    await installSourceTabProtectionRules(tabId);
  } else {
    await removeSourceTabProtectionRules(tabId);
  }

  await updateBadgeForTab(tabId, resolvedBaseUrl);
}

async function syncTabsForBaseUrl(baseUrl, enabled) {
  if (!baseUrl) {
    return;
  }

  try {
    const tabs = await chrome.tabs.query({});
    const matchingTabs = tabs.filter((tab) => {
      return typeof tab.id === "number" && getBaseUrl(tab.url || tab.pendingUrl || "") === baseUrl;
    });

    await Promise.all(
      matchingTabs.map(async (tab) => {
        await syncTabSiteProtection(tab.id, baseUrl);
        await notifyTab(tab.id, enabled, baseUrl);
      })
    );
  } catch {
    // Ignore transient tab query errors.
  }
}

function closeTab(tabId, protectionPromise) {
  chrome.tabs.remove(tabId, () => {
    blockedTabs.delete(tabId);
    userInitiatedPopupTabs.delete(tabId);
    void chrome.runtime.lastError;
    void protectionPromise.finally(() => removePopupProtectionRules(tabId));
  });
}

async function clearUserGestureAllowance(tabId) {
  if (typeof tabId !== "number") {
    return;
  }

  recentUserNavigationIntents.delete(tabId);
  await syncUserGestureAllowanceRecord(tabId);
}

async function registerUserNavigationIntent(tabId, baseUrl, intent) {
  if (typeof tabId !== "number" || !baseUrl) {
    return;
  }

  const normalizedIntent = normalizeUserNavigationIntent(intent);
  if (!normalizedIntent) {
    return;
  }

  const expiresAt = Date.now() + normalizedIntent.windowMs;
  const existingRecord = normalizeGestureAllowanceRecord(recentUserNavigationIntents.get(tabId));
  const nextRecord = {
    count: Math.min((existingRecord?.count || 0) + 1, 4),
    expiresAt: Math.max(existingRecord?.expiresAt || 0, expiresAt)
  };

  recentUserNavigationIntents.set(tabId, nextRecord);
  await syncUserGestureAllowanceRecord(tabId);

  await appendDebugTrace(baseUrl, `gesture allowance registered on source tab ${tabId}`);
}

async function consumeRecentUserNavigationIntent(tabId, createdTabId) {
  if (typeof tabId !== "number") {
    return false;
  }

  const inMemoryRecord = normalizeGestureAllowanceRecord(recentUserNavigationIntents.get(tabId));
  if (inMemoryRecord && inMemoryRecord.expiresAt >= Date.now()) {
    const nextCount = inMemoryRecord.count - 1;

    if (nextCount <= 0) {
      recentUserNavigationIntents.delete(tabId);
    } else {
      recentUserNavigationIntents.set(tabId, {
        ...inMemoryRecord,
        count: nextCount
      });
    }

    void syncUserGestureAllowanceRecord(tabId);

    if (typeof createdTabId === "number") {
      userInitiatedPopupTabs.add(createdTabId);
    }

    return true;
  }

  if (recentUserNavigationIntents.has(tabId)) {
    recentUserNavigationIntents.delete(tabId);
    void syncUserGestureAllowanceRecord(tabId);
  }

  const consumed = await queueStorageTask(async () => {
    const allowances = await readUserGestureAllowances();
    const tabKey = String(tabId);
    const record = normalizeGestureAllowanceRecord(allowances[tabKey]);

    if (!record || record.expiresAt < Date.now()) {
      if (record || tabKey in allowances) {
        delete allowances[tabKey];
        await chrome.storage.session.set({
          [USER_GESTURE_ALLOWANCES_KEY]: allowances
        });
      }

      recentUserNavigationIntents.delete(tabId);
      return false;
    }

    const nextCount = record.count - 1;

    if (nextCount <= 0) {
      delete allowances[tabKey];
      recentUserNavigationIntents.delete(tabId);
    } else {
      const nextRecord = {
        ...record,
        count: nextCount
      };
      allowances[tabKey] = nextRecord;
      recentUserNavigationIntents.set(tabId, nextRecord);
    }

    await chrome.storage.session.set({
      [USER_GESTURE_ALLOWANCES_KEY]: allowances
    });

    return true;
  });

  if (consumed && typeof createdTabId === "number") {
    userInitiatedPopupTabs.add(createdTabId);
  }

  return consumed;
}

async function allowPopupTab(tabId) {
  if (typeof tabId !== "number") {
    return;
  }

  userInitiatedPopupTabs.add(tabId);
  await removePopupProtectionRules(tabId);
}

function registerRecentPopupSignal(tabId) {
  if (typeof tabId !== "number") {
    return;
  }

  const existingRecord = normalizeGestureAllowanceRecord(recentPopupSignals.get(tabId));
  const nextRecord = {
    count: Math.min((existingRecord?.count || 0) + 1, 4),
    expiresAt: Math.max(existingRecord?.expiresAt || 0, Date.now() + RECENT_POPUP_SIGNAL_WINDOW_MS)
  };

  recentPopupSignals.set(tabId, nextRecord);
}

function consumeRecentPopupSignal(tabId) {
  if (typeof tabId !== "number") {
    return false;
  }

  const record = normalizeGestureAllowanceRecord(recentPopupSignals.get(tabId));
  if (!record || record.expiresAt < Date.now()) {
    recentPopupSignals.delete(tabId);
    return false;
  }

  const nextCount = record.count - 1;
  if (nextCount <= 0) {
    recentPopupSignals.delete(tabId);
  } else {
    recentPopupSignals.set(tabId, {
      ...record,
      count: nextCount
    });
  }

  return true;
}

async function tryAllowPopupTabFromGesture(sourceTabId, createdTabId, sourceBaseUrl, label) {
  if (!(await consumeRecentUserNavigationIntent(sourceTabId, createdTabId))) {
    return false;
  }

  await appendDebugTrace(sourceBaseUrl, `allowed tab ${createdTabId} ${label}`);
  await allowPopupTab(createdTabId);
  return true;
}

async function openManualTabFromSender(sender, request) {
  const sourceTabId = sender.tab?.id;
  const sourceUrl = sender.tab?.url || sender.tab?.pendingUrl || "";
  const sourceBaseUrl = getBaseUrl(sourceUrl);
  const targetUrl = normalizeManualOpenUrl(request?.url);

  if (typeof sourceTabId !== "number" || !sourceBaseUrl || !targetUrl) {
    return {
      ok: false
    };
  }

  const openInBackground = request?.active === false;

  await appendDebugTrace(
    sourceBaseUrl,
    `manual-open request: ${openInBackground ? "background tab" : "foreground tab"} -> ${targetUrl}`
  );

  await clearUserGestureAllowance(sourceTabId);
  await registerUserNavigationIntent(sourceTabId, sourceBaseUrl, {
    allowAnyUrl: true,
    windowMs: MAX_USER_NAVIGATION_INTENT_WINDOW_MS
  });

  let sourceTab;
  try {
    sourceTab = await chrome.tabs.get(sourceTabId);
  } catch {
    sourceTab = null;
  }

  const createProperties = {
    url: targetUrl,
    active: openInBackground !== true,
    openerTabId: sourceTabId
  };

  if (sourceTab && typeof sourceTab.index === "number") {
    createProperties.index = sourceTab.index + 1;
  }

  if (sourceTab && typeof sourceTab.windowId === "number") {
    createProperties.windowId = sourceTab.windowId;
  }

  await chrome.tabs.create(createProperties);

  return {
    ok: true
  };
}

async function recordSiteSignal(baseUrl) {
  if (!baseUrl) {
    return;
  }

  const detectedChanged = await markDetectedAutoOpenForBaseUrl(baseUrl);
  if (detectedChanged) {
    await updateBadgesForBaseUrl(baseUrl);
  }
}

async function recordBlockedAttempt(baseUrl) {
  if (!baseUrl) {
    return;
  }

  await recordSiteSignal(baseUrl);
  await updateBadgesForBaseUrl(baseUrl);
}

async function recordSecondLayerBlock(baseUrl) {
  if (!baseUrl) {
    return;
  }

  await recordBlockedAttempt(baseUrl);
  await incrementSecondLayerBlocks(baseUrl);
}

async function blockPopupTab(tabId, sourceBaseUrl) {
  if (
    typeof tabId !== "number" ||
    blockedTabs.has(tabId) ||
    userInitiatedPopupTabs.has(tabId) ||
    !sourceBaseUrl
  ) {
    return false;
  }

  await appendDebugTrace(sourceBaseUrl, `blocked tab ${tabId} by 2nd layer`);
  blockedTabs.add(tabId);
  const protectionPromise = installPopupProtectionRules(tabId).catch(() => {});
  closeTab(tabId, protectionPromise);
  await recordSecondLayerBlock(sourceBaseUrl);
  return true;
}

async function handleCreatedTab(tab) {
  if (tab.id === undefined || tab.openerTabId === undefined) {
    return;
  }

  if (userInitiatedPopupTabs.has(tab.id)) {
    return;
  }

  const sourceBaseUrl = await getTabBaseUrl(tab.openerTabId);
  if (!sourceBaseUrl) {
    return;
  }

  const blockingEnabled = await isBlockingEnabledForBaseUrl(sourceBaseUrl);
  await appendDebugTrace(
    sourceBaseUrl,
    `tabs.onCreated for tab ${tab.id} from source ${tab.openerTabId} (${blockingEnabled ? "blocking on" : "blocking off"})`
  );

  if (await tryAllowPopupTabFromGesture(tab.openerTabId, tab.id, sourceBaseUrl, "from source-tab gesture allowance")) {
    return;
  }

  const pendingLocation = tab.pendingUrl || tab.url || "";
  if (pendingLocation && isInternalUrl(pendingLocation)) {
    return;
  }

  const hasExternalTarget = Boolean(getBaseUrl(pendingLocation));
  const hasRecentPopupSignal = consumeRecentPopupSignal(tab.openerTabId);
  if (!hasExternalTarget && !hasRecentPopupSignal) {
    return;
  }

  if (
    await tryAllowPopupTabFromGesture(
      tab.openerTabId,
      tab.id,
      sourceBaseUrl,
      "from late source-tab gesture allowance"
    )
  ) {
    return;
  }

  await recordSiteSignal(sourceBaseUrl);

  if (!blockingEnabled) {
    return;
  }

  await blockPopupTab(tab.id, sourceBaseUrl);
}

async function handleCreatedNavigationTarget(details) {
  if (details.sourceTabId < 0 || isInternalUrl(details.url)) {
    return;
  }

  if (userInitiatedPopupTabs.has(details.tabId)) {
    return;
  }

  const sourceBaseUrl = await getTabBaseUrl(details.sourceTabId);
  if (!sourceBaseUrl) {
    return;
  }

  const blockingEnabled = await isBlockingEnabledForBaseUrl(sourceBaseUrl);
  await appendDebugTrace(
    sourceBaseUrl,
    `onCreatedNavigationTarget for tab ${details.tabId} from source ${details.sourceTabId} (${blockingEnabled ? "blocking on" : "blocking off"})`
  );

  if (
    await tryAllowPopupTabFromGesture(
      details.sourceTabId,
      details.tabId,
      sourceBaseUrl,
      "from webNavigation gesture allowance"
    )
  ) {
    return;
  }

  await recordSiteSignal(sourceBaseUrl);

  if (!blockingEnabled) {
    return;
  }

  if (
    await tryAllowPopupTabFromGesture(
      details.sourceTabId,
      details.tabId,
      sourceBaseUrl,
      "from late webNavigation gesture allowance"
    )
  ) {
    return;
  }

  await blockPopupTab(details.tabId, sourceBaseUrl);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "getBlockingState") {
    void (async () => {
      sendResponse(await getSenderState(sender));
    })();
    return true;
  }

  if (message?.type === "getTabState") {
    void (async () => {
      sendResponse(await getTabState(message.tabId));
    })();
    return true;
  }

  if (message?.type === "setTabBlocking") {
    void (async () => {
      const tabState = await getTabState(message.tabId);

      if (!tabState.supported || !tabState.baseUrl) {
        sendResponse(tabState);
        return;
      }

      const enabled = message.enabled === true;
      if (enabled) {
        await markEverEnabledForBaseUrl(tabState.baseUrl);
      }

      await setBlockingEnabledForBaseUrl(tabState.baseUrl, enabled);
      await syncTabsForBaseUrl(tabState.baseUrl, enabled);

      sendResponse(await getTabState(message.tabId));
    })();
    return true;
  }

  if (message?.type === "registerUserNavigationIntent") {
    const tabId = sender.tab?.id;
    const baseUrl = getBaseUrl(sender.tab?.url || sender.tab?.pendingUrl || "");
    void (async () => {
      if (typeof tabId === "number" && baseUrl) {
        await registerUserNavigationIntent(tabId, baseUrl, message.intent);
      }

      sendResponse({ ok: true });
    })();
    return true;
  }

  if (message?.type === "openManualTab") {
    void (async () => {
      sendResponse(await openManualTabFromSender(sender, message));
    })();
    return true;
  }

  if (message?.type === "reportPopupSignal") {
    void (async () => {
      const sourceTabId = sender.tab?.id;
      const baseUrl = getBaseUrl(sender.tab?.url || sender.tab?.pendingUrl || "");
      if (!baseUrl) {
        sendResponse({ ok: false });
        return;
      }

      if (typeof sourceTabId === "number") {
        registerRecentPopupSignal(sourceTabId);
      }

      await appendDebugTrace(baseUrl, "popup signal reported from page/content script");
      await recordSiteSignal(baseUrl);

      if (!(await isBlockingEnabledForBaseUrl(baseUrl))) {
        sendResponse({ ok: true });
        return;
      }

      await recordBlockedAttempt(baseUrl);
      sendResponse({ ok: true });
    })();
    return true;
  }

  return false;
});

chrome.tabs.onCreated.addListener((tab) => {
  void handleCreatedTab(tab);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url === undefined && changeInfo.status === undefined) {
    return;
  }

  void syncTabSiteProtection(tabId, getBaseUrl(changeInfo.url || tab.url || tab.pendingUrl || ""));
});

chrome.tabs.onActivated.addListener((activeInfo) => {
  void syncTabSiteProtection(activeInfo.tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  blockedTabs.delete(tabId);
  userInitiatedPopupTabs.delete(tabId);
  recentPopupSignals.delete(tabId);
  void clearUserGestureAllowance(tabId);
  void removeSourceTabProtectionRules(tabId);
  void removePopupProtectionRules(tabId);
});

chrome.webNavigation.onCreatedNavigationTarget.addListener((details) => {
  void handleCreatedNavigationTarget(details);
});

chrome.runtime.onInstalled.addListener(() => {
  void (async () => {
    await migrateDetectedAutoOpenSignals();
    await clearManagedSessionRules();
    await syncAllTabs();
  })();
});

chrome.runtime.onStartup.addListener(() => {
  void (async () => {
    await migrateDetectedAutoOpenSignals();
    await clearManagedSessionRules();
    await syncAllTabs();
  })();
});

void (async () => {
  await migrateDetectedAutoOpenSignals();
  await clearManagedSessionRules();
  await syncAllTabs();
})();
