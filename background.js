console.info("Persistent Containers: Background script initialized.");

// Track startup time to safely ignore massive tab bursts from Session Restores
const STARTUP_TIME = Date.now();
const STARTUP_GRACE_PERIOD_MS = 3000;
const MAC_EXTENSION_ID = "@testpilot-containers";

// Trackers
const tabsBeingCreated = new Set();
const pendingBlankTabs = new Map();
const lastActiveTab = new Map();
const bypassRequests = new Map();
const BYPASS_WINDOW_MS = 500;

// --- Storage Configuration ---
let openNextToCurrent = true;
let inheritTabGroup = true;

/**
 * Query Multi-Account Containers for a URL assignment.
 * Returns the cookieStoreId MAC would assign, or null if:
 *   - MAC is not installed
 *   - No "Always open in" rule exists for this URL
 */
async function getMACAssignment(url) {
  // Only query for real URLs
  if (!url || url === "about:blank" || url === "about:newtab") {
    return null;
  }

  try {
    return await browser.runtime.sendMessage(MAC_EXTENSION_ID, {
      method: "getAssignment",
      url,
    });
  } catch {
    // MAC not installed or not responding — that's fine
    return null;
  }
}

function isSystemUrl(url) {
  if (!url) return false;
  return (
    (url.startsWith("about:") &&
      url !== "about:blank" &&
      url !== "about:newtab") ||
    url.startsWith("moz-extension://") ||
    url.startsWith("chrome://")
  );
}

// Set default to true on first install
browser.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    browser.storage.local.set({ openNextToCurrent: true });
    console.info("Persistent Containers: Installed. Default settings saved.");
  }
});

// Load the current setting into memory
browser.storage.local
  .get({ openNextToCurrent: true, inheritTabGroup: true })
  .then((res) => {
    openNextToCurrent = res.openNextToCurrent;
    inheritTabGroup = res.inheritTabGroup;
  });

// Listen for the user changing the setting in the popup
browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local") {
    if (changes.openNextToCurrent?.newValue !== undefined) {
      openNextToCurrent = changes.openNextToCurrent.newValue;
      console.info(
        `Persistent Containers: openNextToCurrent changed to ${openNextToCurrent}`,
      );
    }
    if (changes.inheritTabGroup?.newValue !== undefined) {
      inheritTabGroup = changes.inheritTabGroup.newValue;
      console.info(
        `Persistent Containers: inheritTabGroup changed to ${inheritTabGroup}`,
      );
    }
  }
});

// Seed lastActiveTab for all windows on startup
browser.windows.getAll({ populate: true }).then((windows) => {
  for (const win of windows) {
    const active = win.tabs.find((t) => t.active);
    if (active) {
      lastActiveTab.set(win.id, active);
    }
  }
});

/**
 * If inheritTabGroup is enabled and the source tab is in a group,
 * add targetTabId to that same group.
 * Uses feature detection so older Firefox versions won't crash.
 */
async function maybeInheritTabGroup(targetTabId, sourceTab) {
  if (!inheritTabGroup) {
    return;
  }
  if (!browser.tabs.group) {
    return;
  }

  const groupId = sourceTab.groupId;
  // tabGroups.TAB_GROUP_ID_NONE === -1
  if (groupId === undefined || groupId === -1) {
    return;
  }

  try {
    await browser.tabs.group({ tabIds: [targetTabId], groupId });
    console.info(
      `Persistent Containers: Added tab ${targetTabId} to group ${groupId}`,
    );
  } catch (err) {
    console.warn(
      `Persistent Containers: Could not add tab to group ${groupId}:`,
      err,
    );
  }
}

// fetch fresh tabs, check URL, call performSwap
async function resolveBlankTab(tabId, data) {
  pendingBlankTabs.delete(tabId);

  const freshActiveTab = await browser.tabs
    .get(data.activeTabId)
    .catch(() => null);
  if (!freshActiveTab) {
    return;
  }
  const freshTab = await browser.tabs.get(tabId).catch(() => null);
  if (!freshTab) {
    return;
  }
  const url =
    freshTab.url &&
    freshTab.url !== "about:blank" &&
    freshTab.url !== "about:newtab" &&
    freshTab.url !== ""
      ? freshTab.url
      : undefined;
  await performSwap(freshTab, data.targetContainerId, freshActiveTab, url);
}

// --- Helper Function: Perform the Tab Swap ---
async function performSwap(
  originalTab,
  targetContainerId,
  currentActiveTab,
  finalUrl,
) {
  // check if container id still valid and exists
  try {
    await browser.contextualIdentities.get(targetContainerId);
  } catch {
    console.warn(
      `Persistent Containers: Container ${targetContainerId} no longer exists. Skipping swap.`,
    );
    return;
  }

  try {
    // Defer to Multi-Account Containers if it has an explicit assignment
    const macAssignment = await getMACAssignment(finalUrl);
    if (macAssignment) {
      // MAC has an "Always open in container X" rule for this URL.
      // Use MAC's container instead of ours.
      targetContainerId = macAssignment.cookieStoreId;
      console.info(
        `Persistent Containers: Deferring to MAC assignment → ${targetContainerId}`,
      );
    }

    const creationProps = {
      cookieStoreId: targetContainerId,
      active: originalTab.active,
      windowId: originalTab.windowId,
    };
    // Only set openerTabId if it's valid and existing
    if (originalTab.openerTabId) {
      try {
        await browser.tabs.get(originalTab.openerTabId);
        creationProps.openerTabId = originalTab.openerTabId;
      } catch {
        creationProps.openerTabId = currentActiveTab.id;
      }
    } else {
      creationProps.openerTabId = currentActiveTab.id;
    }

    // Apply user preference for placement
    if (openNextToCurrent) {
      creationProps.index = currentActiveTab.index + 1;
    } else {
      creationProps.index = originalTab.index;
    }

    // If we caught a URL (from a bookmark or external link), inject it!
    if (finalUrl && finalUrl !== "about:blank" && finalUrl !== "about:newtab") {
      creationProps.url = finalUrl;
    }

    const replacementTab = await browser.tabs.create(creationProps);
    tabsBeingCreated.add(replacementTab.id);

    await browser.tabs.remove(originalTab.id);
    console.info(
      `Persistent Containers: Swapped tab. Container: ${targetContainerId}, URL: ${finalUrl || "New Tab"}`,
    );
    //Inherit tab group from the active tab
    await maybeInheritTabGroup(replacementTab.id, currentActiveTab);
  } catch (error) {
    console.error("Persistent Containers: Error during swap:", error);
  }
}

// --- Clean up memory to prevent leaks ---
browser.tabs.onRemoved.addListener((tabId) => {
  tabsBeingCreated.delete(tabId);
  pendingBlankTabs.delete(tabId);
});

// --- Handle Keyboard Commands ---
browser.commands.onCommand.addListener(async (command) => {
  if (command === "open-new-tab-without-container") {
    try {
      const [currentTab] = await browser.tabs.query({
        active: true,
        currentWindow: true,
      });
      if (!currentTab) {
        return;
      }
      // Set bypass flag BEFORE creating the tab
      bypassRequests.set(currentTab.windowId, Date.now());
      // Open explicitly in firefox-default (no container)
      const newTab = await browser.tabs.create({
        cookieStoreId: "firefox-default",
        active: true,
        index: openNextToCurrent ? currentTab.index + 1 : undefined,
      });

      // Even when bypassing containers, tabs can inherit the group
      await maybeInheritTabGroup(newTab.id, currentTab);
    } catch (error) {
      console.error("Persistent Containers: Error executing command:", error);
    }
  }
});

// --- Core Interceptor ---
browser.tabs.onCreated.addListener(async (newTab) => {
  try {
    // Ignore Session Restores (tabs created immediately when the browser opens)
    if (Date.now() - STARTUP_TIME < STARTUP_GRACE_PERIOD_MS) {
      return;
    }

    // Safety Checks
    if (newTab.incognito || newTab.cookieStoreId === "firefox-private") {
      return;
    }

    if (tabsBeingCreated.has(newTab.id)) {
      tabsBeingCreated.delete(newTab.id);
      return;
    }

    // Bypass check (Alt+T) new tab without container
    const bypassTime = bypassRequests.get(newTab.windowId);
    if (bypassTime && Date.now() - bypassTime < BYPASS_WINDOW_MS) {
      bypassRequests.delete(newTab.windowId);
      return;
    }

    // --- Query Context ---
    const currentActiveTab = lastActiveTab.get(newTab.windowId);
    if (!currentActiveTab) {
      return;
    }
    if (currentActiveTab.id === newTab.id && newTab.index === 0) {
      return;
    }

    const targetContainerId = currentActiveTab.cookieStoreId;
    // Don't inherit container from system pages
    if (isSystemUrl(currentActiveTab.url)) {
      return;
    }

    // --- The Swap Logic ---
    // Only intercept tabs in the default (no-container) context.
    // If another extension already assigned a container, we leave it alone.
    if (
      targetContainerId !== "firefox-default" &&
      newTab.cookieStoreId === "firefox-default"
    ) {
      // Scenario A: The tab already has a real URL (e.g., clicking an external link)
      if (
        newTab.url &&
        newTab.url !== "about:blank" &&
        newTab.url !== "about:newtab" &&
        newTab.url !== ""
      ) {
        // Don't containerize system pages
        if (isSystemUrl(newTab.url)) {
          return;
        }

        await performSwap(
          newTab,
          targetContainerId,
          currentActiveTab,
          newTab.url,
        );
      }
      // Scenario B: The tab is completely blank. Add to tracker and wait for the browser event.
      else if (!newTab.url || newTab.url === "about:blank") {
        pendingBlankTabs.set(newTab.id, {
          targetContainerId,
          activeTabId: currentActiveTab.id,
          timestamp: Date.now(),
        });
      }
      // Scenario C: Standard "Ctrl+T" New Tab Page
      else {
        await performSwap(
          newTab,
          targetContainerId,
          currentActiveTab,
          undefined,
        );
      }
    }
    // No container swap needed, but still inherit tab group
    else {
      await maybeInheritTabGroup(newTab.id, currentActiveTab);
    }
  } catch (error) {
    console.error(
      "Persistent Containers: Critical error during tab interception:",
      error,
    );
  }
});

// Keep the cache fresh if the active tab's container or URL changes
browser.tabs.onUpdated.addListener(
  (tabId, changeInfo, tab) => {
    const cached = lastActiveTab.get(tab.windowId);
    if (cached && cached.id === tabId) {
      lastActiveTab.set(tab.windowId, tab);
    }
  },
  { properties: ["url", "status"] },
);

// --- The Deterministic Event Catcher (The Bookmark Catcher) ---
browser.tabs.onUpdated.addListener(
  async (tabId, changeInfo, tab) => {
    // Only care about tabs we are actively tracking
    if (!pendingBlankTabs.has(tabId)) {
      return;
    }

    const data = pendingBlankTabs.get(tabId);

    // EVENT A: The browser injects the URL (Bookmark/Link caught!)
    if (changeInfo.url && changeInfo.url !== "about:blank") {
      // Don't containerize system pages
      if (isSystemUrl(changeInfo.url)) {
        pendingBlankTabs.delete(tabId);
        return;
      }

      pendingBlankTabs.delete(tabId); // Stop tracking

      const freshActiveTab = await browser.tabs
        .get(data.activeTabId)
        .catch(() => null);
      if (!freshActiveTab) {
        // parent tab was closed, abort
        return;
      }
      const freshTab = await browser.tabs.get(tabId).catch(() => null);
      if (!freshTab) {
        return;
      }
      // swap the tab based on current tab container
      // MAC check happens inside performSwap
      await performSwap(
        freshTab,
        data.targetContainerId,
        freshActiveTab,
        changeInfo.url,
      );
    }
    // EVENT B: Tab finished loading but still blank
    else if (changeInfo.status === "complete") {
      const elapsed = Date.now() - data.timestamp;
      if (elapsed < 300) {
        setTimeout(() => {
          if (!pendingBlankTabs.has(tabId)) {
            return;
          }
          resolveBlankTab(tabId, data);
        }, 300 - elapsed);
        return;
      }
      resolveBlankTab(tabId, data);
    }
  },
  // only fire for these changes
  { properties: ["url", "status"] },
);

// --- Update active tab cache on tab switch ---
browser.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  try {
    const tab = await browser.tabs.get(tabId);
    // Don't update cache if this is a pending blank tab about to be swapped
    if (!pendingBlankTabs.has(tabId)) {
      lastActiveTab.set(windowId, tab);
    }
  } catch {
    // tab was closed
  }
});

// Periodic cleanup of pendingBlankTabs (every 30s)
setInterval(() => {
  const now = Date.now();
  for (const [tabId, data] of pendingBlankTabs) {
    if (now - data.timestamp > 10000) {
      pendingBlankTabs.delete(tabId);
      console.warn(`Persistent Containers: Timed out pending tab ${tabId}`);
    }
  }
  // cleanup bypassed new tab pages
  for (const [windowId, timestamp] of bypassRequests) {
    if (now - timestamp > 5000) {
      bypassRequests.delete(windowId);
    }
  }
}, 30000);

browser.windows.onRemoved.addListener((windowId) => {
  lastActiveTab.delete(windowId);
});
