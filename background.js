console.info("Persistent Containers: Background script initialized.");

// Track startup time to safely ignore massive tab bursts from Session Restores
const STARTUP_TIME = Date.now();

// Trackers
const tabsBeingCreated = new Set();
const bypassRequests = new Map();
const pendingBlankTabs = new Map();

// --- Storage Configuration ---
let openNextToCurrent = true;

// Set default to true on first install
browser.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    browser.storage.local.set({ openNextToCurrent: true });
    console.info("Persistent Containers: Installed. Default settings saved.");
  }
});

// Load the current setting into memory
browser.storage.local.get({ openNextToCurrent: true }).then((res) => {
  openNextToCurrent = res.openNextToCurrent;
});

// Listen for the user changing the setting in the popup
browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.openNextToCurrent !== undefined) {
    openNextToCurrent = changes.openNextToCurrent.newValue;
    console.info(
      `Persistent Containers: openNextToCurrent setting changed to ${openNextToCurrent}`,
    );
  }
});

// --- Helper Function: Perform the Tab Swap ---
async function performSwap(
  originalTab,
  targetContainerId,
  currentActiveTab,
  finalUrl,
) {
  try {
    const creationProps = {
      cookieStoreId: targetContainerId,
      active: originalTab.active,
      windowId: originalTab.windowId,
      openerTabId: originalTab.openerTabId || currentActiveTab.id,
    };

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

      bypassRequests.set(currentTab.windowId, Date.now());

      await browser.tabs.create({
        cookieStoreId: "firefox-default",
        index: openNextToCurrent ? currentTab.index + 1 : undefined,
        active: true,
      });
    } catch (error) {
      console.error(
        "Persistent Containers: Error executing bypass command:",
        error,
      );
      if (currentTab) bypassRequests.delete(currentTab.windowId);
    }
  }
});

// --- Core Interceptor ---
browser.tabs.onCreated.addListener(async (newTab) => {
  try {
    // Ignore Session Restores (tabs created immediately when the browser opens)
    if (Date.now() - STARTUP_TIME < 3000) {
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

    // 3. Bypass Command Check
    const bypassTime = bypassRequests.get(newTab.windowId);
    if (bypassTime && Date.now() - bypassTime < 500) {
      bypassRequests.delete(newTab.windowId);
      return;
    }

    // --- Query Context ---
    const [currentActiveTab] = await browser.tabs.query({
      active: true,
      windowId: newTab.windowId,
    });
    if (!currentActiveTab) return;
    if (currentActiveTab.id === newTab.id && newTab.index === 0) {
      return;
    }

    const targetContainerId = currentActiveTab.cookieStoreId;

    // --- The Swap Logic ---
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
        await performSwap(
          newTab,
          targetContainerId,
          currentActiveTab,
          newTab.url,
        );
      }
      // Scenario B: The tab is completely blank. Add to tracker and wait for the browser event.
      else if (newTab.url === "about:blank" || newTab.url === "") {
        pendingBlankTabs.set(newTab.id, {
          targetContainerId,
          currentActiveTab,
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
  } catch (error) {
    console.error(
      "Persistent Containers: Critical error during tab interception:",
      error,
    );
  }
});

// --- The Deterministic Event Catcher (The Bookmark Catcher) ---
browser.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  // Only care about tabs we are actively tracking
  if (!pendingBlankTabs.has(tabId)) {
    return;
  }

  const data = pendingBlankTabs.get(tabId);

  // EVENT A: The browser injects the URL (Bookmark/Link caught!)
  if (changeInfo.url && changeInfo.url !== "about:blank") {
    pendingBlankTabs.delete(tabId); // Stop tracking
    await performSwap(
      tab,
      data.targetContainerId,
      data.currentActiveTab,
      changeInfo.url,
    );
  }
  // EVENT B: The browser declares the tab is 100% finished loading, but it's still blank
  else if (changeInfo.status === "complete") {
    pendingBlankTabs.delete(tabId); // Stop tracking
    await performSwap(
      tab,
      data.targetContainerId,
      data.currentActiveTab,
      undefined,
    );
  }
});
