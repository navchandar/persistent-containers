"use strict";

/**
 * Configuration mapping for the popup toggles.
 * Defaults match those defined in background.js.
 */
const SETTINGS_CONFIG = [
  { id: "openNextToCurrent", key: "openNextToCurrent", default: true },
  { id: "inheritTabGroup", key: "inheritTabGroup", default: true },
];

document.addEventListener("DOMContentLoaded", async () => {
  // 1. Verify browser capability (Tab Groups API is available in Firefox 138+)
  checkTabGroupSupport();

  // 2. Load stored preferences and attach change listeners
  await initSettings();

  // 3. Display current tab container status badge
  await updateCurrentContainerStatus();
});

/**
 * Checks if browser.tabs.group exists. If not, disables the setting row gracefully.
 */
function checkTabGroupSupport() {
  const supportsTabGroups = typeof browser.tabs?.group === "function";

  if (!supportsTabGroups) {
    const checkbox = document.getElementById("inheritTabGroup");
    if (!checkbox) return;

    checkbox.disabled = true;
    const row = checkbox.closest(".setting-row");
    if (row) {
      row.classList.add("disabled");
      row.title = "Requires Firefox 138 or later with tab groups enabled";
    }
  }
}

/**
 * Reads preferences from browser.storage.local, sets toggle states,
 * and handles writing updates back to storage on change.
 */
async function initSettings() {
  // Construct lookup defaults object
  const defaults = Object.fromEntries(
    SETTINGS_CONFIG.map(({ key, default: defVal }) => [key, defVal])
  );

  try {
    const settings = await browser.storage.local.get(defaults);

    for (const { id, key } of SETTINGS_CONFIG) {
      const checkbox = document.getElementById(id);
      if (!checkbox) continue;

      // Sync checkbox state with storage
      const value = Boolean(settings[key]);
      checkbox.checked = value;
      checkbox.setAttribute("aria-checked", String(value));

      // Persist changes immediately on user interaction
      checkbox.addEventListener("change", async () => {
        const isChecked = checkbox.checked;
        checkbox.setAttribute("aria-checked", String(isChecked));

        try {
          await browser.storage.local.set({ [key]: isChecked });
        } catch (error) {
          console.error(`Persistent Containers: Failed to save '${key}':`, error);
        }
      });
    }
  } catch (err) {
    console.error("Persistent Containers: Error retrieving settings:", err);
  }
}

/**
 * Inspects the current active tab and shows container information in the status badge.
 */
async function updateCurrentContainerStatus() {
  const statusText = document.getElementById("containerText");
  const statusDot = document.getElementById("containerDot");
  if (!statusText || !statusDot) return;

  try {
    const [activeTab] = await browser.tabs.query({
      active: true,
      currentWindow: true,
    });

    // Handle non-container tabs or missing contextual identity
    if (!activeTab || !activeTab.cookieStoreId || activeTab.cookieStoreId === "firefox-default") {
      statusText.textContent = "Default Container (no container)";
      statusDot.style.backgroundColor = "#999999";
      return;
    }

    if (activeTab.incognito || activeTab.cookieStoreId === "firefox-private") {
      statusText.textContent = "Private Window (inactive)";
      statusDot.style.backgroundColor = "#800080";
      return;
    }

    // Query container metadata (name and color) from Firefox Contextual Identities API
    if (browser.contextualIdentities) {
      const identity = await browser.contextualIdentities.get(activeTab.cookieStoreId);
      statusText.textContent = `Active: ${identity.name}`;
      statusDot.style.backgroundColor = identity.colorCode || "#37adff";
    }
  } catch {
    // If permissions are restricted or tab cannot be read, display general status
    statusText.textContent = "Monitoring tab inheritance";
    statusDot.style.backgroundColor = "#37adff";
  }
}