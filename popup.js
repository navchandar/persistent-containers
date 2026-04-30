// --- Set Defaults on First Install ---
browser.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    browser.storage.local.set({ openNextToCurrent: true });
    console.info("Persistent Containers: Installed. Default settings saved.");
  }
});

const checkbox = document.getElementById("openNextToCurrent");

// When the popup opens, check memory for the current setting
browser.storage.local.get({ openNextToCurrent: true }).then((result) => {
  checkbox.checked = result.openNextToCurrent;
  checkbox.setAttribute("aria-checked", checkbox.checked);
});

// When the user flips the switch, save it to memory
checkbox.addEventListener("change", () => {
  browser.storage.local.set({ openNextToCurrent: checkbox.checked });
  checkbox.setAttribute("aria-checked", checkbox.checked);
});
