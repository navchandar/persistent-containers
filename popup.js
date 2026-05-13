// --- Set Defaults on First Install ---
browser.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    browser.storage.local.set({ openNextToCurrent: true });
    console.info("Persistent Containers: Installed. Default settings saved.");
  }
});

const openNextToCurrentCheckbox = document.getElementById("openNextToCurrent");
const inheritTabGroupCheckbox = document.getElementById("inheritTabGroup");

// When the popup opens, check memory for the current setting
browser.storage.local
  .get({ openNextToCurrent: true, inheritTabGroup: false })
  .then((res) => {
    openNextToCurrentCheckbox.checked = res.openNextToCurrent;
    openNextToCurrentCheckbox.setAttribute(
      "aria-checked",
      String(res.openNextToCurrent),
    );

    inheritTabGroupCheckbox.checked = res.inheritTabGroup;
    inheritTabGroupCheckbox.setAttribute(
      "aria-checked",
      String(res.inheritTabGroup),
    );

    // Disable if Firefox doesn't support tab groups (< 138)
    if (!browser.tabs.group) {
      inheritTabGroupCheckbox.disabled = true;
      inheritTabGroupCheckbox.closest(".setting-row").style.opacity = "0.5";
      inheritTabGroupCheckbox.closest(".setting-row").title =
        "Requires Firefox 138 or later";
    }
  });

// --- Save on change ---
openNextToCurrentCheckbox.addEventListener("change", () => {
  const val = openNextToCurrentCheckbox.checked;
  openNextToCurrentCheckbox.setAttribute("aria-checked", String(val));
  browser.storage.local.set({ openNextToCurrent: val });
});

inheritTabGroupCheckbox.addEventListener("change", () => {
  const val = inheritTabGroupCheckbox.checked;
  inheritTabGroupCheckbox.setAttribute("aria-checked", String(val));
  browser.storage.local.set({ inheritTabGroup: val });
});
