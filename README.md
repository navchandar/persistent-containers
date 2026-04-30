# Persistent Containers

Firefox extension to make containers persistent and sticky. New tabs inherit the container of the currently active tab, mimicking the default behavior in Google Chrome browser.

Similar to [Sticky Containers](https://github.com/kemayo/firefox-sticky-containers) but better!

## Overview

By default, Firefox opens all new tabs and bookmarks in the "No Container" state, requiring users to manually sort tabs into their respective containers. Persistent Containers intercepts the creation of new tabs and automatically routes them into the same container as the currently active tab.

## Features

- When opening bookmarks and external links, intercepts the new tab into the current tab's container.
- Opens new tab/bookmarks right next to the current tab, by default.
- Includes a toolbar options to toggle whether new tabs open immediately next to the current tab or at the end of the tab row.
- Use `Alt+T` to forcefully open a standard "No Container" tab, bypassing these rules.
- Automatically ignores Private Browsing windows, session restores, and new window creations to prevent browser conflicts and memory leaks.

## Usage

- **Toolbar Menu:** Click the extension icon in the Firefox toolbar to access the settings menu. Here you can toggle the "Open next to current tab" preference.
- **Keyboard Commands:**
  - `Ctrl+T`: Open a new tab in the current container.
  - `Alt+T`: Open a new tab without a container. (This shortcut can be customized in Firefox's Add-on settings).

## Permissions Used

- `tabs`: To monitor tab creation and manage tab URLs.
- `contextualIdentities`: To read and assign container IDs (cookieStoreId) to new tabs.
- `cookies`: Required by Firefox to programmatically create tabs inside isolated containers.
- `storage`: To save the user's preferences in browser memory.

## Testing

For testing, this extension must be loaded as a temporary add-on for testing and development.

1. Download or clone this repository to your local machine.
2. Open Firefox and navigate to `about:debugging` in the address bar.
3. Click on **This Firefox** in the left-hand sidebar.
4. Click the **Load Temporary Add-on...** button.
5. Select the `manifest.json` file from your project directory.
6. Click on the Persistent Containers icon in your toolbar.
