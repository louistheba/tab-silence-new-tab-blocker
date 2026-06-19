const TARGET_SELECTOR = "a[target], area[target], form[target], base[target]";
const PING_SELECTOR = "a[ping], area[ping]";
const SAFE_TARGETS = new Set(["_self", "_top", "_parent"]);
const LINK_SELECTOR = "a[href], area[href]";
const FORM_SELECTOR = "form";
const INTERACTIVE_GESTURE_SELECTOR =
  'a[href], area[href], button, [role="button"], input[type="button"], input[type="submit"], input[type="image"], summary';
const CONTEXT_MENU_INTENT_WINDOW_MS = 10000;
const USER_GESTURE_INTENT_WINDOW_MS = 2500;
const WINDOW_OPEN_SIGNAL_EVENT = "prevent-new-tab:window-open-signal";
const PAGE_CONFIG_EVENT = "prevent-new-tab:config";
const PAGE_STATE_ATTRIBUTE = "data-prevent-new-tab-enabled";
const ORIGINAL_TARGET_ATTRIBUTE = "data-prevent-new-tab-original-target";
const ORIGINAL_PING_ATTRIBUTE = "data-prevent-new-tab-original-ping";
const MISSING_VALUE_SENTINEL = "__prevent_new_tab_missing__";
let blockingEnabled = false;
let observer = null;
let rootObserver = null;

function getTargetValue(element) {
  const target = element.getAttribute("target");
  return typeof target === "string" ? target.trim() : "";
}

function escapeAttributeValue(value) {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }

  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function hasSamePageNamedFrame(element, target) {
  if (!target) {
    return false;
  }

  const ownerDocument = element.ownerDocument;
  if (!ownerDocument) {
    return false;
  }

  const escapedTarget = escapeAttributeValue(target);
  return Boolean(ownerDocument.querySelector(`iframe[name="${escapedTarget}"], frame[name="${escapedTarget}"]`));
}

function shouldForceSameTab(element) {
  const target = getTargetValue(element);
  if (!target) {
    return false;
  }

  const normalizedTarget = target.toLowerCase();
  if (SAFE_TARGETS.has(normalizedTarget)) {
    return false;
  }

  if (normalizedTarget === "_blank") {
    return true;
  }

  return !hasSamePageNamedFrame(element, target);
}

function rememberOriginalAttribute(element, markerAttribute, value) {
  if (!(element instanceof Element) || element.hasAttribute(markerAttribute)) {
    return;
  }

  const storedValue = value === null ? MISSING_VALUE_SENTINEL : value;
  element.setAttribute(markerAttribute, storedValue);
}

function restoreAttributeFromMarker(element, attributeName, markerAttribute) {
  if (!(element instanceof Element) || !element.hasAttribute(markerAttribute)) {
    return;
  }

  const storedValue = element.getAttribute(markerAttribute);
  if (storedValue === MISSING_VALUE_SENTINEL) {
    element.removeAttribute(attributeName);
  } else {
    element.setAttribute(attributeName, storedValue);
  }

  element.removeAttribute(markerAttribute);
}

function stripPing(element) {
  if (!blockingEnabled) {
    return false;
  }

  if (!(element instanceof Element) || !element.matches(PING_SELECTOR)) {
    return false;
  }

  rememberOriginalAttribute(element, ORIGINAL_PING_ATTRIBUTE, element.getAttribute("ping"));
  element.removeAttribute("ping");
  return true;
}

function reportPopupSignal() {
  chrome.runtime.sendMessage({
    type: "reportPopupSignal"
  });
}

function registerUserNavigationIntent(intent) {
  chrome.runtime.sendMessage({
    type: "registerUserNavigationIntent",
    intent
  });
}

function requestManualTabOpen(request) {
  chrome.runtime.sendMessage({
    type: "openManualTab",
    ...request
  });
}

function resolveAbsoluteUrl(url) {
  if (typeof url !== "string" || !url) {
    return null;
  }

  try {
    return new URL(url, document.baseURI).href;
  } catch {
    return null;
  }
}

function buildWindowOpenIntent(detail) {
  if (!detail || detail.userInitiated !== true) {
    return null;
  }

  return {
    allowAnyUrl: true,
    windowMs: 1500
  };
}

function buildManualLinkOpenRequest(element, active) {
  if (!(element instanceof Element) || !element.matches(LINK_SELECTOR)) {
    return null;
  }

  const resolvedUrl = resolveAbsoluteUrl(element.getAttribute("href") || element.href || "");
  if (!resolvedUrl) {
    return null;
  }

  return {
    url: resolvedUrl,
    active
  };
}

function buildManualWindowOpenRequest(detail) {
  if (!detail || detail.userInitiated !== true) {
    return null;
  }

  const resolvedUrl = resolveAbsoluteUrl(detail.url || "");
  if (!resolvedUrl) {
    return null;
  }

  return {
    url: resolvedUrl,
    active: detail.active !== false
  };
}

function buildNavigationIntent(element, windowMs = USER_GESTURE_INTENT_WINDOW_MS) {
  if (!(element instanceof Element)) {
    return null;
  }

  if (
    !element.matches(TARGET_SELECTOR) &&
    !element.matches(LINK_SELECTOR) &&
    !element.matches(FORM_SELECTOR) &&
    !element.matches(INTERACTIVE_GESTURE_SELECTOR)
  ) {
    return null;
  }

  return {
    allowAnyUrl: true,
    windowMs
  };
}

function registerNavigationIntentFromElement(element, windowMs = USER_GESTURE_INTENT_WINDOW_MS) {
  const intent = buildNavigationIntent(element, windowMs);
  if (!intent) {
    return false;
  }

  registerUserNavigationIntent(intent);
  return true;
}

function normalizeNode(node) {
  if (!blockingEnabled) {
    return;
  }

  if (!(node instanceof Element || node instanceof Document || node instanceof DocumentFragment)) {
    return;
  }

  if (node instanceof Element) {
    stripPing(node);
  }

  if ("querySelectorAll" in node) {
    for (const element of node.querySelectorAll(PING_SELECTOR)) {
      stripPing(element);
    }
  }
}

function normalizeEventPath(event) {
  const path = typeof event.composedPath === "function" ? event.composedPath() : [];
  let detectedPopupBehavior = false;

  for (const entry of path) {
    if (!(entry instanceof Element)) {
      continue;
    }

    if (entry.matches(TARGET_SELECTOR) && shouldForceSameTab(entry)) {
      detectedPopupBehavior = true;
    }

    if (blockingEnabled && entry.matches(PING_SELECTOR)) {
      stripPing(entry);
    }
  }

  return detectedPopupBehavior;
}

function shouldRegisterLinkIntent(event) {
  if (event.button === 1) {
    return true;
  }

  return event.metaKey || event.ctrlKey || event.shiftKey;
}

function isUnmodifiedPrimaryClick(event) {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

function findPathMatch(event, selector, predicate = null) {
  const path = typeof event.composedPath === "function" ? event.composedPath() : [];

  for (const entry of path) {
    if (!(entry instanceof Element) || !entry.matches(selector)) {
      continue;
    }

    if (!predicate || predicate(entry)) {
      return entry;
    }
  }

  return null;
}

function findGestureIntentTarget(event, includeGeneralInteractive = false) {
  const popupTarget = findPathMatch(event, TARGET_SELECTOR, shouldForceSameTab);
  if (popupTarget) {
    return popupTarget;
  }

  const linkTarget = findPathMatch(event, LINK_SELECTOR);
  if (linkTarget) {
    return linkTarget;
  }

  if (!includeGeneralInteractive) {
    return null;
  }

  return findPathMatch(event, INTERACTIVE_GESTURE_SELECTOR);
}

function startObserver() {
  if (observer || !document.documentElement) {
    return;
  }

  normalizeNode(document);

  observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === "attributes" && mutation.target instanceof Element) {
        stripPing(mutation.target);
        continue;
      }

      for (const addedNode of mutation.addedNodes) {
        normalizeNode(addedNode);
      }
    }
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["ping"]
  });
}

function stopObservers() {
  if (observer) {
    observer.disconnect();
    observer = null;
  }

  if (rootObserver) {
    rootObserver.disconnect();
    rootObserver = null;
  }
}

function waitForRoot() {
  if (rootObserver) {
    return;
  }

  rootObserver = new MutationObserver(() => {
    if (!document.documentElement) {
      return;
    }

    rootObserver.disconnect();
    rootObserver = null;
    startObserver();
  });

  rootObserver.observe(document, {
    childList: true,
    subtree: true
  });
}

function restoreManagedAttributes() {
  for (const element of document.querySelectorAll(`[${ORIGINAL_TARGET_ATTRIBUTE}]`)) {
    restoreAttributeFromMarker(element, "target", ORIGINAL_TARGET_ATTRIBUTE);
  }

  for (const element of document.querySelectorAll(`[${ORIGINAL_PING_ATTRIBUTE}]`)) {
    restoreAttributeFromMarker(element, "ping", ORIGINAL_PING_ATTRIBUTE);
  }
}

function syncPageScriptState() {
  if (document.documentElement) {
    document.documentElement.setAttribute(PAGE_STATE_ATTRIBUTE, blockingEnabled ? "true" : "false");
  }

  window.dispatchEvent(
    new CustomEvent(PAGE_CONFIG_EVENT, {
      detail: {
        enabled: blockingEnabled
      }
    })
  );
}

function applyBlockingState(enabled) {
  const nextEnabled = enabled === true;

  if (blockingEnabled === nextEnabled) {
    syncPageScriptState();
    if (!blockingEnabled) {
      restoreManagedAttributes();
    }
    return;
  }

  blockingEnabled = nextEnabled;
  syncPageScriptState();

  if (blockingEnabled) {
    if (document.documentElement) {
      startObserver();
    } else {
      waitForRoot();
    }
    return;
  }

  stopObservers();
  restoreManagedAttributes();
}

document.addEventListener(
  "mousedown",
  (event) => {
    if (event.defaultPrevented || !event.isTrusted) {
      return;
    }

    if (event.button !== 0 && event.button !== 1) {
      return;
    }

    const gestureTarget = findGestureIntentTarget(event, true);
    if (gestureTarget) {
      registerNavigationIntentFromElement(gestureTarget);
    }
  },
  true
);

document.addEventListener(
  "click",
  (event) => {
    if (event.defaultPrevented) {
      return;
    }

    const popupTarget = event.isTrusted ? findPathMatch(event, TARGET_SELECTOR, shouldForceSameTab) : null;
    const linkTarget = event.isTrusted ? findPathMatch(event, LINK_SELECTOR) : null;
    const generalInteractiveTarget =
      event.isTrusted && !popupTarget && !linkTarget
        ? findPathMatch(event, INTERACTIVE_GESTURE_SELECTOR)
        : null;
    const targetBasedIntent = popupTarget || linkTarget || generalInteractiveTarget;
    const modifiedLinkIntent = event.isTrusted && shouldRegisterLinkIntent(event) ? linkTarget : null;

    if (blockingEnabled && event.isTrusted && modifiedLinkIntent) {
      const manualOpenRequest = buildManualLinkOpenRequest(modifiedLinkIntent, event.shiftKey);
      if (manualOpenRequest) {
        event.preventDefault();
        event.stopImmediatePropagation();
        requestManualTabOpen(manualOpenRequest);
        return;
      }
    }

    if (
      blockingEnabled &&
      event.isTrusted &&
      isUnmodifiedPrimaryClick(event) &&
      popupTarget &&
      popupTarget.matches(LINK_SELECTOR)
    ) {
      const manualOpenRequest = buildManualLinkOpenRequest(popupTarget, true);
      if (manualOpenRequest) {
        event.preventDefault();
        event.stopImmediatePropagation();
        requestManualTabOpen(manualOpenRequest);
        return;
      }
    }

    const registeredIntent = registerNavigationIntentFromElement(targetBasedIntent || modifiedLinkIntent);

    if (event.button !== 0) {
      return;
    }

    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }

    if (blockingEnabled && !registeredIntent && normalizeEventPath(event)) {
      reportPopupSignal();
    }
  },
  true
);

document.addEventListener(
  "auxclick",
  (event) => {
    if (event.defaultPrevented) {
      return;
    }

    const popupTarget = event.isTrusted ? findPathMatch(event, TARGET_SELECTOR, shouldForceSameTab) : null;
    const linkTarget = event.isTrusted ? findPathMatch(event, LINK_SELECTOR) : null;
    const generalInteractiveTarget =
      event.isTrusted && !popupTarget && !linkTarget
        ? findPathMatch(event, INTERACTIVE_GESTURE_SELECTOR)
        : null;
    const targetBasedIntent = popupTarget || linkTarget || generalInteractiveTarget;
    const modifiedLinkIntent = event.isTrusted && shouldRegisterLinkIntent(event) ? linkTarget : null;

    if (blockingEnabled && event.isTrusted && linkTarget) {
      const manualOpenRequest = buildManualLinkOpenRequest(linkTarget, false);
      if (manualOpenRequest) {
        event.preventDefault();
        event.stopImmediatePropagation();
        requestManualTabOpen(manualOpenRequest);
        return;
      }
    }

    registerNavigationIntentFromElement(targetBasedIntent || modifiedLinkIntent);
  },
  true
);

document.addEventListener(
  "submit",
  (event) => {
    const targetBasedIntent = event.isTrusted ? findGestureIntentTarget(event, true) : null;
    const registeredIntent = registerNavigationIntentFromElement(targetBasedIntent || event.target);

    if (blockingEnabled && !registeredIntent && normalizeEventPath(event)) {
      reportPopupSignal();
    }
  },
  true
);

document.addEventListener(
  "contextmenu",
  (event) => {
    if (event.defaultPrevented || !event.isTrusted) {
      return;
    }

    const linkIntentTarget = findGestureIntentTarget(event, true);
    if (!linkIntentTarget) {
      return;
    }

    registerNavigationIntentFromElement(linkIntentTarget, CONTEXT_MENU_INTENT_WINDOW_MS);
  },
  true
);

window.addEventListener(WINDOW_OPEN_SIGNAL_EVENT, (event) => {
  const manualOpenRequest = blockingEnabled ? buildManualWindowOpenRequest(event.detail) : null;
  if (manualOpenRequest) {
    requestManualTabOpen(manualOpenRequest);
    return;
  }

  const intent = buildWindowOpenIntent(event.detail);
  if (intent) {
    registerUserNavigationIntent(intent);
    return;
  }

  reportPopupSignal();
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "siteSettingChanged") {
    applyBlockingState(message.enabled === true);
  }
});

restoreManagedAttributes();
syncPageScriptState();

chrome.runtime.sendMessage({ type: "getBlockingState" }, (response) => {
  if (chrome.runtime.lastError) {
    return;
  }

  applyBlockingState(response?.enabled === true);
});
