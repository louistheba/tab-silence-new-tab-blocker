(() => {
  const PAGE_CONFIG_EVENT = "prevent-new-tab:config";
  const WINDOW_OPEN_SIGNAL_EVENT = "prevent-new-tab:window-open-signal";
  const SAFE_TARGETS = new Set(["_self", "_top", "_parent"]);
  let blockingEnabled = false;
  let protectedOpenInstalled = false;
  const ownWindowOpenDescriptor = Object.getOwnPropertyDescriptor(window, "open");
  const originalWindowOpen = window.open;

  function escapeAttributeValue(value) {
    if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
      return CSS.escape(value);
    }

    return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  function hasSamePageNamedFrame(target) {
    if (!target || !document) {
      return false;
    }

    const escapedTarget = escapeAttributeValue(target);
    return Boolean(document.querySelector(`iframe[name="${escapedTarget}"], frame[name="${escapedTarget}"]`));
  }

  function isPopupTarget(target) {
    if (typeof target !== "string") {
      return true;
    }

    const normalizedTarget = target.trim().toLowerCase();
    if (!normalizedTarget) {
      return true;
    }

    if (SAFE_TARGETS.has(normalizedTarget)) {
      return false;
    }

    return !hasSamePageNamedFrame(target.trim());
  }

  function resolveOpenUrl(url) {
    if (typeof url !== "string" || !url) {
      return "";
    }

    try {
      return new URL(url, window.location.href).href;
    } catch {
      return "";
    }
  }

  function announcePopupSignal(url) {
    const userInitiated = Boolean(navigator.userActivation && navigator.userActivation.isActive);
    const resolvedUrl = resolveOpenUrl(url);

    window.dispatchEvent(
      new CustomEvent(WINDOW_OPEN_SIGNAL_EVENT, {
        detail: {
          userInitiated,
          url: resolvedUrl
        }
      })
    );

    return {
      userInitiated,
      resolvedUrl
    };
  }

  function protectedOpen(url, target, features) {
    if (isPopupTarget(target)) {
      const popupSignal = announcePopupSignal(url);

      if (blockingEnabled && !popupSignal.userInitiated) {
        return null;
      }

      if (blockingEnabled && popupSignal.userInitiated && popupSignal.resolvedUrl) {
        return null;
      }
    }

    return originalWindowOpen.call(window, url, target, features);
  }

  function installProtectedOpen() {
    if (protectedOpenInstalled) {
      return;
    }

    try {
      Object.defineProperty(window, "open", {
        configurable: true,
        enumerable: ownWindowOpenDescriptor?.enumerable ?? true,
        writable: true,
        value: protectedOpen
      });
      protectedOpenInstalled = true;
    } catch {
      try {
        window.open = protectedOpen;
        protectedOpenInstalled = true;
      } catch {
        protectedOpenInstalled = false;
      }
    }
  }

  function restoreOriginalOpen() {
    if (!protectedOpenInstalled) {
      return;
    }

    try {
      if (ownWindowOpenDescriptor) {
        Object.defineProperty(window, "open", ownWindowOpenDescriptor);
      } else {
        delete window.open;
      }
    } catch {
      try {
        window.open = originalWindowOpen;
      } catch {
        // Ignore pages that refuse reassignment.
      }
    } finally {
      protectedOpenInstalled = false;
    }
  }

  function applyBlockingState(enabled) {
    blockingEnabled = enabled === true;

    if (blockingEnabled) {
      installProtectedOpen();
      return;
    }

    restoreOriginalOpen();
  }

  window.addEventListener(PAGE_CONFIG_EVENT, (event) => {
    applyBlockingState(event.detail?.enabled === true);
  });
})();
