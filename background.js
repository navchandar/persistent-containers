console.info("Persistent Containers: Background script initialized.");

// Safely ignore massive tab bursts from Session Restores. The grace period
// must be anchored to the *browser* startup, not to this script loading:
// MV3 background scripts are torn down after a short idle period and reloaded
// on the next event, so module-load time is NOT a safe proxy for browser
// startup. With the old module constant, every wake-up re-armed a fresh
// 3-second black hole and the first user-created tab silently stayed in the
// default container. browser.storage.session survives event-page reloads and
// is cleared on browser shutdown — exactly the lifetime of a browser session.
//
// The grace window is armed ONLY by real browser-start signals
// (runtime.onStartup, and an onStartup that fired within the last 3 seconds
// survives reloads via the storage.session anchor). Mid-session script
// loads — temporary add-on install, wake-from-idle — never arm it, so the
// user's first tab creation is never swallowed.
const STARTUP_GRACE_PERIOD_MS = 3000;
const SESSION_START_KEY = "browserSessionStart";
const MAC_EXTENSION_ID = "@testpilot-containers";

// Trackers
const tabsBeingCreated = new Set();
const pendingBlankTabs = new Map();
const lastActiveTab = new Map();
const bypassRequests = new Map();
const BYPASS_WINDOW_MS = 500;
const ACTIVE_TAB_CACHE_KEY = "lastActiveTabByWindow";

// Feature-gate every storage.session touch: this script runs before any
// await, so an unguarded top-level access could throw at load and register
// no listeners at all (which would look like "never inherits anything").
const hasSessionStorage = !!(browser.storage && browser.storage.session);

// storage.session mirror of the last-active-tab cache. It survives MV3
// event-page reloads within a browser session and is cleared on shutdown —
// exactly the cache's intended lifetime. Without it, the cache is empty
// after every idle teardown and the first tab creation after a wake-up has
// no inheritance source (plain Ctrl+T carries no openerTabId, and querying
// the window's active tab returns the just-created tab itself).
function persistLastActiveTab() {
  if (!hasSessionStorage) {
    return;
  }
  browser.storage.session
    .set({ [ACTIVE_TAB_CACHE_KEY]: Object.fromEntries(lastActiveTab) })
    .catch(() => {});
}

function setLastActiveTab(windowId, tab) {
  lastActiveTab.set(windowId, tab);
  persistLastActiveTab();
}

// Issued at load time — i.e. before any event can be delivered to this
// reload — so the resolved snapshot still names each window's PRE-creation
// active tab even after tabs.onActivated has contaminated the live cache.
const hydratedActiveTabCache = hasSessionStorage
  ? browser.storage.session
      .get(ACTIVE_TAB_CACHE_KEY)
      .then((res) => {
        const saved = res[ACTIVE_TAB_CACHE_KEY];
        return saved && typeof saved === "object" ? saved : {};
      })
      .catch(() => ({}))
  : Promise.resolve({});

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

// Arm the session-restore grace ONLY on real browser start. runtime.onStartup
// fires exactly once per browser launch. The storage.session anchor lets a
// later event-page reload during the same startup burst still see the grace;
// the in-memory value covers this instance directly. Mid-session loads
// (temporary add-on install, wake-from-idle) arm NOTHING, so the user's first
// real tab creation is never swallowed.
let startupGraceUntil = 0;

function armStartupGrace() {
  const now = Date.now();
  startupGraceUntil = now + STARTUP_GRACE_PERIOD_MS;
  if (hasSessionStorage) {
    browser.storage.session
      .set({ [SESSION_START_KEY]: now })
      .catch(() => {});
  }
}

browser.runtime.onStartup.addListener(armStartupGrace);

async function inBrowserStartupGrace() {
  if (Date.now() < startupGraceUntil) {
    return true;
  }
  if (!hasSessionStorage) {
    return false;
  }
  try {
    const stored = await browser.storage.session.get(SESSION_START_KEY);
    const value = stored[SESSION_START_KEY];
    if (
      typeof value === "number" &&
      Date.now() - value < STARTUP_GRACE_PERIOD_MS
    ) {
      return true;
    }
  } catch {
    // storage.session read failure: treat as not-in-grace (better a swapped
    // restore tab than permanently broken inheritance).
  }
  return false;
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
      setLastActiveTab(win.id, active);
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
    // Read the active-tab cache synchronously at handler entry, BEFORE any
    // await: tabs.onActivated fires shortly after onCreated for foreground
    // tabs and would otherwise be able to overwrite the inheritance source
    // while this handler is suspended.
    let currentActiveTab = lastActiveTab.get(newTab.windowId);
    // Remember the synchronous opener hint from the event itself (link
    // clicks, window.open). tabs.get() on it after the awaits below is
    // immune to the onActivated race, unlike an {active:true} query, which
    // can return the just-activated new tab.
    let openerCandidate = null;
    if (
      !currentActiveTab &&
      newTab.openerTabId &&
      newTab.openerTabId !== newTab.id
    ) {
      openerCandidate = newTab.openerTabId;
    }

    // Ignore Session Restores (tabs created in a burst right after the
    // browser itself opens). Armed only by runtime.onStartup / its
    // storage.session anchor — never by a mid-session script load, so a
    // wake-from-idle or a temporary install does NOT swallow the user's
    // first real tab creation.
    if (await inBrowserStartupGrace()) {
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
    // Cache was empty at handler entry (event-page reload after idle
    // teardown, or a window that appeared while the script was asleep).
    // Reconstruct the inheritance source, most trustworthy first:
    // 1) the storage.session mirror snapshot, read at load time BEFORE any
    //    event of this reload was delivered — it still names the pre-creation
    //    active tab even though onActivated has since overwritten the live
    //    cache with the new tab (covers plain Ctrl+T, which carries no
    //    openerTabId);
    // 2) the opener tab from the creation event (link clicks, window.open),
    //    deterministic and immune to the onActivated race;
    // 3) last resort: the window's current active tab.
    // The final id check rejects every path that resolves to the new tab
    // itself (new window / first tab / activated-tab query) — the same safe
    // no-op the guards below would apply.
    if (!currentActiveTab) {
      // First tab of a (new) window — keep ignoring new window creations, as
      // session restore does at startup.
      if (newTab.index === 0) {
        return;
      }
      const hydrated = await hydratedActiveTabCache;
      const savedEntry = hydrated[newTab.windowId];
      if (savedEntry && typeof savedEntry.id === "number") {
        // Re-read live: the tab may have been closed, moved containers, or
        // navigated while this script slept.
        currentActiveTab = await browser.tabs
          .get(savedEntry.id)
          .catch(() => null);
      }
      if (!currentActiveTab && openerCandidate) {
        currentActiveTab = await browser.tabs
          .get(openerCandidate)
          .catch(() => null);
      }
      // Rejected candidates (cross-window opener, recycled id): the swap
      // placement math and the cache key assume the same window.
      if (currentActiveTab && currentActiveTab.windowId !== newTab.windowId) {
        currentActiveTab = null;
      }
      if (!currentActiveTab) {
        const [activeTab] = await browser.tabs.query({
          active: true,
          windowId: newTab.windowId,
        });
        currentActiveTab = activeTab ?? null;
      }
      if (!currentActiveTab || currentActiveTab.id === newTab.id) {
        return;
      }
      setLastActiveTab(newTab.windowId, currentActiveTab);
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
      setLastActiveTab(tab.windowId, tab);
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
      setLastActiveTab(windowId, tab);
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
  persistLastActiveTab();
});
