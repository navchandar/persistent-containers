"use strict";

console.info("Persistent Containers: Background script initialized.");

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------

const DEFAULT_CONTAINER = "firefox-default";
const MAC_EXTENSION_ID = "@testpilot-containers";
const STATE_KEY = "persistentContainersRuntimeStateV3";

const STARTUP_GRACE_MS = 3000;
const BLANK_SETTLE_MS = 300;
const BLANK_WAIT_LIMIT_MS = 10000;
const MAC_TIMEOUT_MS = 1500;
const MAX_DESTINATION_ATTEMPTS = 3;
const MAX_REDIRECTS = 512;

const DEFAULT_SETTINGS = {
    openNextToCurrent: true,
    inheritTabGroup: true,
};

const settings = {
    ...DEFAULT_SETTINGS
};
const changedSettings = new Set();

const addonSession = browser.storage?.session ?? null;

const activeHistory = new Map();
const savedHistory = new Map();
const bootstrapActiveTabs = new Map();

const touchedWindows = new Set();
const windowVersions = new Map();

const pendingTabs = new Map();
const ownedTabIds = new Set();
const creationOperations = new Set();
const replacementIds = new Map();

let creationSequence = 0;
let startupGraceUntil = 0;
let initializing = true;

let persistenceRequested = false;
let persistenceRunning = false;

const LOG_PREFIX = "Persistent Containers";

function describeError(error) {
    if (error instanceof Error) {
        return {
            name: error.name,
            message: error.message,
            stack: error.stack,
        };
    }
    if (
        error &&
        typeof error === "object" &&
        typeof error.message === "string"
    ) {
        return {
            name: error.name ?? "Error",
            message: error.message,
            stack: error.stack,
        };
    }
    return {
        name: "UnknownError",
        message: String(error),
    };
}

function reportError(code, message, error, context = {}, recovery = "") {
    console.error(
        `[${LOG_PREFIX}] ${code}: ${message}`, {
            ...context,
            error: describeError(error),
            recovery,
        },
    );
}

function reportWarning(code, message, context = {}) {
    console.warn(
        `[${LOG_PREFIX}] ${code}: ${message}`,
        context,
    );
}
// These catch otherwise-unhandled runtime failures.
// They cannot catch a syntax error that prevents this file from loading.
globalThis.addEventListener("error", (event) => {
    reportError(
        "BACKGROUND_UNCAUGHT",
        "An uncaught background-script error occurred.",
        event.error ?? event.message, {
            file: event.filename,
            line: event.lineno,
            column: event.colno,
        },
        "Copy the first error and stack trace from the Browser Console.",
    );
});
globalThis.addEventListener("unhandledrejection", (event) => {
    reportError(
        "BACKGROUND_UNHANDLED_PROMISE",
        "An asynchronous operation failed without a local error handler.",
        event.reason, {},
        "Report this error with the action that triggered it.",
    );
});


// -----------------------------------------------------------------------------
// Basic helpers
// -----------------------------------------------------------------------------

function isTabId(value) {
    return Number.isInteger(value) && value >= 0;
}

function isBlankUrl(url) {
    return !url || url === "about:blank";
}

function isNewTabUrl(url) {
    return url === "about:newtab";
}

function isPrivateTab(tab) {
    return Boolean(
        tab.incognito ||
        tab.cookieStoreId === "firefox-private"
    );
}

function isSystemUrl(url) {
    if (!url) {
        return false;
    }

    return (
        (
            url.startsWith("about:") &&
            url !== "about:blank" &&
            url !== "about:newtab"
        ) ||
        url.startsWith("moz-extension://") ||
        url.startsWith("chrome://")
    );
}

function canRecreateUrl(url) {
    if (isBlankUrl(url) || isNewTabUrl(url)) {
        return true;
    }

    try {
        const parsed = new URL(url);

        // Avoid recreating file:, data:, javascript:, blob:, and privileged
        // pages. Their state or permissions may not survive a replacement.
        return (
            parsed.protocol === "http:" ||
            parsed.protocol === "https:"
        );
    } catch {
        return false;
    }
}

function hasSplitView(tab) {
    return (
        Number.isInteger(tab.splitViewId) &&
        tab.splitViewId >= 0
    );
}

function isMissingTabError(error) {
    const message = describeError(error).message;
    // Known missing-tab message patterns. These are intentionally narrow.
    return (
        /invalid tab id/i.test(message) ||
        /no tab with id/i.test(message) ||
        /tab .* does not exist/i.test(message)
    );
}
async function getTab(tabId) {
    if (!isTabId(tabId)) {
        return null;
    }
    try {
        return await browser.tabs.get(tabId);
    } catch (error) {
        if (isMissingTabError(error)) {
            // Expected when the user closes a tab during processing.
            return null;
        }
        reportError(
            "TAB_LOOKUP_FAILED",
            "Firefox could not retrieve a tab.",
            error, {
                tabId
            },
            "Check extension permissions and the preceding Browser Console errors.",
        );
        // Do not misinterpret an unexpected API failure as a missing tab.
        throw error;
    }
}
async function removeTabQuietly(tabId) {
    if (!isTabId(tabId)) {
        return;
    }
    try {
        await browser.tabs.remove(tabId);
    } catch (error) {
        if (isMissingTabError(error)) {
            return;
        }
        reportError(
            "TAB_CLEANUP_FAILED",
            "Could not remove a temporary replacement tab.",
            error, {
                tabId
            },
            "The original and replacement may both remain open. Check them before closing either.",
        );
    }
}



async function withTimeout(promise, milliseconds, fallback) {
    let timer;

    try {
        return await Promise.race([
            promise,
            new Promise((resolve) => {
                timer = setTimeout(() => {
                    resolve(fallback);
                }, milliseconds);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

function touchWindow(windowId) {
    if (initializing) {
        touchedWindows.add(windowId);
    }

    windowVersions.set(
        windowId,
        (windowVersions.get(windowId) ?? 0) + 1,
    );
}

function followReplacement(tabId) {
    const visited = new Set();

    while (
        replacementIds.has(tabId) &&
        !visited.has(tabId)
    ) {
        visited.add(tabId);
        tabId = replacementIds.get(tabId);
    }

    return tabId;
}

// -----------------------------------------------------------------------------
// Session-state persistence
// -----------------------------------------------------------------------------

function persistState() {
    if (!addonSession) {
        return;
    }
    persistenceRequested = true;
    if (persistenceRunning) {
        return;
    }
    persistenceRunning = true;
    Promise.resolve()
        .then(async () => {
            await ready;
            while (persistenceRequested) {
                persistenceRequested = false;
                await addonSession.set({
                    [STATE_KEY]: {
                        startupGraceUntil,
                        windows: Object.fromEntries(activeHistory),
                    },
                });
            }
        })
        .catch((error) => {
            // Do not create a tight retry loop after a storage failure.
            // A subsequent event can request a fresh write.
            persistenceRequested = false;
            reportError(
                "SESSION_SAVE_FAILED",
                "Could not save the active-tab recovery state.",
                error, {
                    trackedWindows: activeHistory.size,
                },
                "Inheritance after background unloading may be affected. Check initialization and storage errors.",
            );
        })
        .finally(() => {
            persistenceRunning = false;
            if (persistenceRequested) {
                persistState();
            }
        });
}


function rememberActiveTab(windowId, tabId, previousTabId) {
    if (!isTabId(tabId)) {
        return;
    }

    touchWindow(windowId);

    const old = activeHistory.get(windowId);
    const explicitPrevious =
        isTabId(previousTabId) && previousTabId !== tabId ?
        previousTabId :
        null;

    if (old?.current === tabId) {
        // onCreated may already have stored the new current ID.
        // Do not discard useful previousTabId information from onActivated.
        if (
            explicitPrevious !== null &&
            old.previous !== explicitPrevious
        ) {
            activeHistory.set(windowId, {
                current: tabId,
                previous: explicitPrevious,
            });

            persistState();
        }

        return;
    }

    activeHistory.set(windowId, {
        current: tabId,
        previous: explicitPrevious ?? old?.current ?? null,
    });

    persistState();
}

function forgetTabFromHistory(tabId, windowId) {
    let changed = false;

    for (const map of [activeHistory, savedHistory]) {
        const history = map.get(windowId);

        if (!history) {
            continue;
        }

        if (
            history.current !== tabId &&
            history.previous !== tabId
        ) {
            continue;
        }

        map.set(windowId, {
            current: history.current === tabId ? null : history.current,
            previous: history.previous === tabId ? null : history.previous,
        });

        changed = true;
    }

    if (bootstrapActiveTabs.get(windowId) === tabId) {
        bootstrapActiveTabs.delete(windowId);
    }

    if (changed) {
        persistState();
    }
}

function rememberReplacement(originalId, replacementId, windowId) {
    replacementIds.set(originalId, replacementId);

    while (replacementIds.size > MAX_REDIRECTS) {
        const oldestId = replacementIds.keys().next().value;
        replacementIds.delete(oldestId);
    }

    for (const map of [activeHistory, savedHistory]) {
        const history = map.get(windowId);

        if (!history) {
            continue;
        }

        map.set(windowId, {
            current: history.current === originalId ?
                replacementId : history.current,
            previous: history.previous === originalId ?
                replacementId : history.previous,
        });
    }

    if (bootstrapActiveTabs.get(windowId) === originalId) {
        bootstrapActiveTabs.set(windowId, replacementId);
    }

    persistState();
}

async function syncActiveTab(tabId, windowId) {
    const version = windowVersions.get(windowId) ?? 0;
    const tab = await getTab(tabId);

    if (
        !tab ||
        !tab.active ||
        tab.windowId !== windowId ||
        isPrivateTab(tab) ||
        version !== (windowVersions.get(windowId) ?? 0)
    ) {
        return;
    }

    rememberActiveTab(windowId, tab.id);
}

// -----------------------------------------------------------------------------
// Initialization
// -----------------------------------------------------------------------------

async function initialize() {
    const settingsPromise = browser.storage.local
        .get(DEFAULT_SETTINGS)
        .catch((error) => {
            console.warn(
                "Persistent Containers: Could not load settings:",
                error,
            );

            return DEFAULT_SETTINGS;
        });

    const sessionPromise = addonSession ?
        addonSession.get(STATE_KEY).catch((error) => {
            console.warn(
                "Persistent Containers: Could not load runtime state:",
                error,
            );

            return {};
        }) :
        Promise.resolve({});

    const windowsPromise = browser.windows
        .getAll({
            populate: true,
            windowTypes: ["normal"],
        })
        .catch((error) => {
            console.warn(
                "Persistent Containers: Could not inspect windows:",
                error,
            );

            return [];
        });

    const [storedSettings, sessionResult, windows] = await Promise.all([
        settingsPromise,
        sessionPromise,
        windowsPromise,
    ]);

    for (const key of Object.keys(DEFAULT_SETTINGS)) {
        if (!changedSettings.has(key)) {
            settings[key] =
                typeof storedSettings[key] === "boolean" ?
                storedSettings[key] :
                DEFAULT_SETTINGS[key];
        }
    }

    const storedState = sessionResult[STATE_KEY];

    if (storedState && typeof storedState === "object") {
        const storedGrace = storedState.startupGraceUntil;

        // Avoid trusting an implausibly distant deadline after a clock change.
        if (
            Number.isFinite(storedGrace) &&
            storedGrace <= Date.now() + STARTUP_GRACE_MS
        ) {
            startupGraceUntil = Math.max(
                startupGraceUntil,
                storedGrace,
            );
        }

        const storedWindows = storedState.windows;

        if (storedWindows && typeof storedWindows === "object") {
            for (const [key, history] of Object.entries(storedWindows)) {
                const windowId = Number(key);

                if (
                    !Number.isInteger(windowId) ||
                    !history ||
                    typeof history !== "object"
                ) {
                    continue;
                }

                const entry = {
                    current: isTabId(history.current) ?
                        history.current : null,
                    previous: isTabId(history.previous) ?
                        history.previous : null,
                };

                savedHistory.set(windowId, entry);

                if (!touchedWindows.has(windowId)) {
                    activeHistory.set(windowId, {
                        ...entry
                    });
                }
            }
        }
    }

    for (const win of windows) {
        if (win.incognito) {
            continue;
        }

        const activeTab = win.tabs?.find((tab) => tab.active);

        if (!activeTab || isPrivateTab(activeTab)) {
            continue;
        }

        bootstrapActiveTabs.set(win.id, activeTab.id);

        if (!touchedWindows.has(win.id)) {
            const old = activeHistory.get(win.id);

            activeHistory.set(win.id, {
                current: activeTab.id,
                previous: old?.current === activeTab.id ?
                    old.previous : old?.current ?? null,
            });
        }
    }

    if (!addonSession) {
        console.warn(
            "Persistent Containers: storage.session is unavailable; " +
            "recovery after background unloading is limited.",
        );
    }
}

// -----------------------------------------------------------------------------
// Multi-Account Containers integration
// -----------------------------------------------------------------------------
function isMissingMessageReceiver(error) {
    const message = describeError(error).message;
    return (
        /receiving end does not exist/i.test(message) ||
        /could not establish connection/i.test(message)
    );
}

async function hasMACAssignment(url) {
    let parsed;
    try {
        parsed = new URL(url);
    } catch {
        return false;
    }
    if (
        parsed.protocol !== "http:" &&
        parsed.protocol !== "https:"
    ) {
        return false;
    }
    const timedOut = Symbol("mac-message-timeout");
    try {
        const assignment = await withTimeout(
            browser.runtime.sendMessage(MAC_EXTENSION_ID, {
                method: "getAssignment",
                url,
            }),
            MAC_TIMEOUT_MS,
            timedOut,
        );
        if (assignment === timedOut) {
            reportWarning(
                "MAC_ASSIGNMENT_TIMEOUT",
                "Multi-Account Containers did not respond in time. Falling back to ordinary inheritance.", {
                    timeoutMs: MAC_TIMEOUT_MS,
                },
            );
            return false;
        }
        if (assignment === null || assignment === undefined) {
            return false;
        }
        if (typeof assignment !== "object") {
            reportWarning(
                "MAC_UNEXPECTED_RESPONSE",
                "Multi-Account Containers returned an unexpected response.", {
                    responseType: typeof assignment,
                },
            );
            return false;
        }
        const contextId = assignment.userContextId;
        // An empty object can represent no assignment.
        if (contextId === null || contextId === undefined) {
            return false;
        }
        const valid =
            (
                typeof contextId === "string" ||
                typeof contextId === "number"
            ) &&
            /^[1-9]\d*$/.test(String(contextId));
        if (!valid) {
            reportWarning(
                "MAC_INVALID_CONTEXT_ID",
                "Multi-Account Containers returned an unsupported assignment ID.", {
                    contextIdType: typeof contextId,
                },
            );
        }
        return valid;
    } catch (error) {
        if (!isMissingMessageReceiver(error)) {
            reportError(
                "MAC_ASSIGNMENT_FAILED",
                "Could not check the optional Multi-Account Containers assignment.",
                error, {},
                "Ordinary inheritance will continue. Check whether the installed MAC version supports this message.",
            );
        }
        return false;
    }
}



// -----------------------------------------------------------------------------
// Tab grouping
// -----------------------------------------------------------------------------

async function applyTabGrouping(
    targetTabId,
    sourceTabId,
    originalGroupId = -1,
) {
    if (typeof browser.tabs.group !== "function") {
        return;
    }

    const [target, source] = await Promise.all([
        getTab(targetTabId),
        getTab(sourceTabId),
    ]);

    if (!target || target.pinned || hasSplitView(target)) {
        return;
    }

    let desiredGroupId = originalGroupId;

    if (
        settings.inheritTabGroup &&
        source &&
        source.windowId === target.windowId
    ) {
        desiredGroupId = source.groupId;
    }

    if (!Number.isInteger(desiredGroupId)) {
        desiredGroupId = -1;
    }

    try {
        if (desiredGroupId >= 0) {
            if (target.groupId !== desiredGroupId) {
                await browser.tabs.group({
                    tabIds: [target.id],
                    groupId: desiredGroupId,
                });
            }
        } else if (
            Number.isInteger(target.groupId) &&
            target.groupId >= 0 &&
            typeof browser.tabs.ungroup === "function"
        ) {
            await browser.tabs.ungroup([target.id]);
        }
    } catch (error) {
        // A grouping failure must not undo successful container inheritance.
        reportError(
            "TAB_GROUPING_FAILED",
            "Could not apply the requested tab group.",
            error, {
                targetTabId,
                sourceTabId,
                desiredGroupId,
            },
            "Container handling can continue, but the tab group may be unchanged.",
        );

    }
}

// -----------------------------------------------------------------------------
// Exact tracking of extension-created tabs
// -----------------------------------------------------------------------------

async function createOwnedTab(properties) {
    let resolveOperation;

    const operation = {
        windowId: properties.windowId,
        finished: new Promise((resolve) => {
            resolveOperation = resolve;
        }),
    };

    // Register before tabs.create(), because onCreated can arrive before
    // the returned promise resolves.
    creationOperations.add(operation);

    let createdId = null;

    try {
        const tab = await browser.tabs.create(properties);

        createdId = tab.id;
        ownedTabIds.add(tab.id);

        return tab;
    } finally {
        resolveOperation(createdId);
        creationOperations.delete(operation);
    }
}

// -----------------------------------------------------------------------------
// Pending-tab records
// -----------------------------------------------------------------------------

function candidateFor(tabId) {
    if (!isTabId(tabId)) {
        return null;
    }

    return {
        id: tabId,
        pending: pendingTabs.get(tabId) ?? null,
    };
}

function historyCandidate(history, newTabId) {
    if (!history) {
        return null;
    }

    // Previous is useful only if "current" is already the new tab.
    // Otherwise an unrelated older container must not become a fallback.
    const tabId =
        history.current === newTabId ?
        history.previous :
        history.current;

    return candidateFor(tabId);
}

function signalRecord(record) {
    record.version += 1;

    if (record.wake) {
        record.wake();
    }
}

function waitForChange(record, version, milliseconds) {
    if (
        record.cancelled ||
        record.version !== version
    ) {
        return Promise.resolve();
    }

    return new Promise((resolve) => {
        let timer;

        const finish = () => {
            clearTimeout(timer);

            if (record.wake === finish) {
                record.wake = null;
            }

            resolve();
        };

        record.wake = finish;
        timer = setTimeout(finish, milliseconds);
    });
}

function cancelRecord(record) {
    record.cancelled = true;
    signalRecord(record);
}

// -----------------------------------------------------------------------------
// Inheritance-source recovery
// -----------------------------------------------------------------------------

async function resolveSource(record) {
    const eventCandidates = [
        record.activationSource,
        ...record.sources,
    ].filter(Boolean);

    const candidates = [...eventCandidates];

    // Consult the load-time snapshot only when live event history did not
    // identify a source. Do not replace a known source with an older one.
    if (eventCandidates.length === 0) {
        candidates.push(
            historyCandidate(
                savedHistory.get(record.windowId),
                record.id,
            ),
        );
    }

    candidates.push(candidateFor(record.initial.openerTabId));

    if (eventCandidates.length === 0) {
        candidates.push(
            candidateFor(bootstrapActiveTabs.get(record.windowId)),
        );
    }

    const visited = new Set();

    for (const candidate of candidates.filter(Boolean)) {
        if (
            candidate.id === record.id ||
            visited.has(candidate.id)
        ) {
            continue;
        }

        visited.add(candidate.id);

        let sourceId = followReplacement(candidate.id);

        const sourceRecord =
            candidate.pending ??
            pendingTabs.get(sourceId);

        if (sourceRecord && sourceId === candidate.id) {
            // Never wait on the same or a later creation.
            if (sourceRecord.sequence >= record.sequence) {
                continue;
            }

            sourceId = await sourceRecord.finished;

            if (!isTabId(sourceId)) {
                continue;
            }

            sourceId = followReplacement(sourceId);
        }

        if (record.cancelled || sourceId === record.id) {
            continue;
        }

        const source = await getTab(sourceId);

        if (
            !source ||
            source.windowId !== record.windowId ||
            isPrivateTab(source)
        ) {
            continue;
        }

        // A real default-container source is valid and intentional.
        return source;
    }

    return null;
}

// -----------------------------------------------------------------------------
// Destination resolution
// -----------------------------------------------------------------------------

async function waitForDestination(record) {
    const deadline = record.createdAt + BLANK_WAIT_LIMIT_MS;

    while (!record.cancelled) {
        const version = record.version;
        const tab = await getTab(record.id);

        if (
            !tab ||
            record.cancelled ||
            tab.windowId !== record.windowId
        ) {
            return null;
        }

        if (record.version !== version) {
            continue;
        }

        if (!isBlankUrl(tab.url)) {
            return tab;
        }

        const now = Date.now();
        const elapsed = now - record.createdAt;

        if (
            tab.status === "complete" &&
            elapsed >= BLANK_SETTLE_MS
        ) {
            return tab;
        }

        const remaining = deadline - now;

        if (remaining <= 0) {
            console.warn(
                "Persistent Containers: Blank tab did not settle; " +
                "leaving it unchanged:",
                record.id,
            );

            return null;
        }

        const delay =
            tab.status === "complete" ?
            Math.max(1, BLANK_SETTLE_MS - elapsed) :
            remaining;

        await waitForChange(
            record,
            version,
            Math.min(delay, remaining),
        );
    }

    return null;
}

function originalStillMatches(record, live, expected) {
    return Boolean(
        !record.cancelled &&
        live &&
        live.windowId === record.windowId &&
        live.cookieStoreId === DEFAULT_CONTAINER &&
        !isPrivateTab(live) &&
        !hasSplitView(live) &&
        live.url === expected.url &&
        Boolean(live.pinned) === Boolean(expected.pinned) &&
        live.groupId === expected.groupId
    );
}

// -----------------------------------------------------------------------------
// Container replacement
// -----------------------------------------------------------------------------

async function replaceTab(record, expected, sourceTab) {
    let replacement = null;
    let removalStarted = false;
    let committed = false;

    try {
        const sourceId = followReplacement(sourceTab.id);

        const [original, source] = await Promise.all([
            getTab(record.id),
            getTab(sourceId),
        ]);

        if (
            !originalStillMatches(record, original, expected) ||
            !source ||
            source.windowId !== record.windowId ||
            isPrivateTab(source) ||
            isSystemUrl(source.url)
        ) {
            return {
                id: original?.id ?? null,
                retry: false
            };
        }

        const containerId = source.cookieStoreId;

        if (!containerId || containerId === DEFAULT_CONTAINER) {
            return {
                id: original.id,
                retry: false
            };
        }

        try {
            await browser.contextualIdentities.get(containerId);
        } catch (error) {
            console.warn(
                "Persistent Containers: Target container is unavailable:",
                containerId,
                error,
            );

            return {
                id: original.id,
                retry: false
            };
        }

        const freshOriginal = await getTab(original.id);

        if (!originalStillMatches(record, freshOriginal, original)) {
            return {
                id: freshOriginal?.id ?? null,
                retry: Boolean(
                    freshOriginal &&
                    !record.cancelled &&
                    freshOriginal.url !== original.url
                ),
            };
        }

        let opener = await getTab(original.openerTabId);

        if (
            !opener ||
            opener.id === original.id ||
            opener.windowId !== record.windowId
        ) {
            opener = source;
        }

        const properties = {
            windowId: record.windowId,
            cookieStoreId: containerId,
            // Create a foreground New Tab as active immediately.
            // Keep website replacements and background tabs inactive.
            active: Boolean(freshOriginal.active && isNewTabUrl(freshOriginal.url)),
            pinned: Boolean(original.pinned),
            muted: Boolean(original.mutedInfo?.muted),
            openerTabId: opener.id,
            index: settings.openNextToCurrent ?
                source.index + 1 : original.index,
        };

        if (!isNewTabUrl(original.url)) {
            // Preserve intentional about:blank tabs. For real URLs, begin
            // with a blank replacement and navigate only after validation.
            properties.url = "about:blank";
        }

        replacement = await createOwnedTab(properties);

        await applyTabGrouping(
            replacement.id,
            source.id,
            original.groupId,
        );

        let currentOriginal = await getTab(original.id);
        const currentReplacement = await getTab(replacement.id);

        if (
            !originalStillMatches(record, currentOriginal, original) ||
            !currentReplacement ||
            currentReplacement.windowId !== record.windowId ||
            currentReplacement.cookieStoreId !== containerId
        ) {
            await removeTabQuietly(replacement.id);

            return {
                id: currentOriginal?.id ?? null,
                retry: Boolean(
                    currentOriginal &&
                    !record.cancelled &&
                    currentOriginal.url !== original.url
                ),
            };
        }

        if (
            !isBlankUrl(original.url) &&
            !isNewTabUrl(original.url)
        ) {
            await browser.tabs.update(replacement.id, {
                url: original.url,
                loadReplace: true,
            });
        }

        // Recheck after navigation/grouping API calls before closing anything.
        currentOriginal = await getTab(original.id);

        if (!originalStillMatches(record, currentOriginal, original)) {
            await removeTabQuietly(replacement.id);

            return {
                id: currentOriginal?.id ?? null,
                retry: Boolean(
                    currentOriginal &&
                    !record.cancelled &&
                    currentOriginal.url !== original.url
                ),
            };
        }

        // Do not deliberately activate a background tab.
        if (currentOriginal.active) {
            await browser.tabs.update(replacement.id, {
                active: true,
            });
        }

        removalStarted = true;
        await browser.tabs.remove(original.id);

        // Avoid reporting success if a close was prevented.
        if (await getTab(original.id)) {
            throw new Error("The original tab was not closed.");
        }

        committed = true;

        rememberReplacement(
            original.id,
            replacement.id,
            record.windowId,
        );

        console.info(
            "Persistent Containers: Replaced tab",
            original.id,
            "with",
            replacement.id,
            "in",
            containerId,
        );

        return {
            id: replacement.id,
            retry: false
        };
    } catch (error) {

        reportError(
            "TAB_REPLACEMENT_FAILED",
            "Could not complete container inheritance.",
            error, {
                originalTabId: record.id,
                replacementTabId: replacement?.id ?? null,
                windowId: record.windowId,
                removalStarted,
                committed,
            },
            "The script will attempt cleanup. Check whether the original or replacement tab remains open.",
        );


        const remainingOriginal = await getTab(record.id);

        // If removal succeeded but another operation threw, do not delete
        // the only remaining replacement.
        if (
            replacement &&
            (
                committed ||
                (removalStarted && !remainingOriginal)
            )
        ) {
            rememberReplacement(
                record.id,
                replacement.id,
                record.windowId,
            );

            return {
                id: replacement.id,
                retry: false
            };
        }

        if (replacement) {
            await removeTabQuietly(replacement.id);
        }

        return {
            id: remainingOriginal?.id ?? null,
            retry: false,
        };
    }
}

// -----------------------------------------------------------------------------
// Main created-tab processing
// -----------------------------------------------------------------------------

async function processCreatedTab(record) {
    await ready;

    const operationIds = await Promise.all(
        record.operations.map((operation) => operation.finished),
    );

    const markedOwned = ownedTabIds.delete(record.id);
    const isOwned =
        markedOwned ||
        operationIds.includes(record.id);

    if (record.cancelled) {
        return null;
    }

    const tab = await getTab(record.id);

    if (!tab) {
        return null;
    }

    if (
        isOwned ||
        isPrivateTab(tab) ||
        record.initial.discarded ||
        tab.discarded ||
        tab.hidden ||
        hasSplitView(tab) ||
        tab.windowId !== record.windowId ||
        record.createdAt < startupGraceUntil
    ) {
        return tab.id;
    }

    const source = await resolveSource(record);

    if (
        record.cancelled ||
        !source ||
        !source.cookieStoreId ||
        isSystemUrl(source.url)
    ) {
        return tab.id;
    }

    for (
        let attempt = 0; attempt < MAX_DESTINATION_ATTEMPTS; attempt += 1
    ) {
        const destination = await waitForDestination(record);

        if (
            !destination ||
            record.cancelled ||
            !canRecreateUrl(destination.url)
        ) {
            return destination?.id ?? null;
        }

        // Never override a container already selected by Firefox or
        // another extension.
        if (
            destination.cookieStoreId !== DEFAULT_CONTAINER ||
            source.cookieStoreId === DEFAULT_CONTAINER
        ) {
            await applyTabGrouping(
                destination.id,
                followReplacement(source.id),
                destination.groupId,
            );

            return destination.id;
        }

        if (await hasMACAssignment(destination.url)) {
            // Let MAC implement its assignment, confirmation, and exemption
            // rules. Do not force a container and bypass that behavior.
            await applyTabGrouping(
                destination.id,
                followReplacement(source.id),
                destination.groupId,
            );

            return destination.id;
        }

        const freshDestination = await getTab(record.id);

        if (!freshDestination || record.cancelled) {
            return null;
        }

        if (freshDestination.url !== destination.url) {
            continue;
        }

        const result = await replaceTab(
            record,
            freshDestination,
            source,
        );

        if (!result.retry) {
            return result.id;
        }
    }

    console.warn(
        "Persistent Containers: Destination kept changing; " +
        "leaving original tab unchanged:",
        record.id,
    );

    return record.id;
}

// -----------------------------------------------------------------------------
// Event handlers
// Register synchronously, before starting asynchronous initialization.
// -----------------------------------------------------------------------------

browser.runtime.onStartup.addListener(() => {
    startupGraceUntil = Date.now() + STARTUP_GRACE_MS;
    persistState();

    console.info(
        "Persistent Containers: Browser startup grace period armed.",
    );
});

browser.runtime.onInstalled.addListener((details) => {
    if (details.reason !== "install") {
        return;
    }

    browser.storage.local
        .set(DEFAULT_SETTINGS)
        .catch((error) => {
            console.error(
                "Persistent Containers: Could not save initial settings:",
                error,
            );
        });
});

browser.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") {
        return;
    }

    for (const key of Object.keys(DEFAULT_SETTINGS)) {
        if (!Object.hasOwn(changes, key)) {
            continue;
        }

        changedSettings.add(key);

        settings[key] =
            typeof changes[key].newValue === "boolean" ?
            changes[key].newValue :
            DEFAULT_SETTINGS[key];
    }
});

browser.tabs.onCreated.addListener((newTab) => {
    // This extension intentionally does not containerize private tabs.
    if (isPrivateTab(newTab)) {
        return;
    }

    const history = activeHistory.get(newTab.windowId);

    let resolveResult;

    const record = {
        id: newTab.id,
        windowId: newTab.windowId,
        initial: {
            ...newTab
        },
        createdAt: Date.now(),
        sequence: ++creationSequence,
        version: 0,
        cancelled: false,
        wake: null,
        activationSource: null,
        activationCaptured: false,

        sources: [
            historyCandidate(history, newTab.id),
        ].filter(Boolean),

        operations: [...creationOperations].filter(
            (operation) => operation.windowId === newTab.windowId,
        ),

        finished: new Promise((resolve) => {
            resolveResult = resolve;
        }),
    };

    // Register before the first await so subsequent updates can wake it.
    pendingTabs.set(newTab.id, record);

    if (initializing) {
        touchedWindows.add(newTab.windowId);
    }

    if (newTab.active) {
        rememberActiveTab(newTab.windowId, newTab.id);
    }

    const finish = async () => {
        let resultId = record.id;

        try {
            resultId = await processCreatedTab(record);
        } catch (error) {
            reportError(
                "TAB_PROCESSING_FAILED",
                "Could not finish processing a newly created tab.",
                error, {
                    tabId: record.id,
                    windowId: record.windowId,
                    cancelled: record.cancelled,
                },
                "The tab may remain unchanged. Check the preceding error for the underlying cause.",
            );

            resultId = record.cancelled ? null : record.id;
        } finally {
            // Always release earlier-creation dependencies.
            resolveResult(resultId);

            if (pendingTabs.get(record.id) === record) {
                pendingTabs.delete(record.id);
            }

            ownedTabIds.delete(record.id);
            signalRecord(record);
        }

        if (isTabId(resultId)) {
            await syncActiveTab(resultId, record.windowId);
        }
    };

    finish().catch((error) => {
        console.error(
            "Persistent Containers: Tab finalization failed:",
            error,
        );
    });
});

browser.tabs.onUpdated.addListener((tabId) => {
    const record = pendingTabs.get(tabId);
    if (record) {
        signalRecord(record);
    }
});


browser.tabs.onActivated.addListener((activeInfo) => {
    const {
        tabId,
        windowId,
        previousTabId,
    } = activeInfo;

    const record = pendingTabs.get(tabId);

    if (record && !record.activationCaptured) {
        record.activationCaptured = true;

        record.activationSource =
            isTabId(previousTabId) && previousTabId !== tabId ?
            candidateFor(previousTabId) :
            historyCandidate(
                activeHistory.get(windowId),
                tabId,
            );

        signalRecord(record);
    }

    rememberActiveTab(windowId, tabId, previousTabId);
});

browser.tabs.onRemoved.addListener((tabId, removeInfo) => {
    ownedTabIds.delete(tabId);
    touchWindow(removeInfo.windowId);

    const record = pendingTabs.get(tabId);

    if (record) {
        cancelRecord(record);
    }

    forgetTabFromHistory(tabId, removeInfo.windowId);
});

browser.tabs.onDetached.addListener((tabId, detachInfo) => {
    touchWindow(detachInfo.oldWindowId);
    forgetTabFromHistory(tabId, detachInfo.oldWindowId);

    const record = pendingTabs.get(tabId);

    if (record) {
        cancelRecord(record);
    }
});

browser.tabs.onAttached.addListener((tabId, attachInfo) => {
    touchWindow(attachInfo.newWindowId);

    syncActiveTab(tabId, attachInfo.newWindowId).catch((error) => {
        console.warn(
            "Persistent Containers: Could not refresh attached tab:",
            error,
        );
    });
});

browser.windows.onRemoved.addListener((windowId) => {
    touchWindow(windowId);

    activeHistory.delete(windowId);
    savedHistory.delete(windowId);
    bootstrapActiveTabs.delete(windowId);

    for (const record of pendingTabs.values()) {
        if (record.windowId === windowId) {
            cancelRecord(record);
        }
    }

    persistState();
});

browser.commands.onCommand.addListener((command, commandTab) => {
    if (command !== "open-new-tab-without-container") {
        return;
    }

    console.info(
        "Persistent Containers: No-container command received.",
    );

    // Capture command context immediately, not after waiting for settings.
    const sourcePromise = isTabId(commandTab?.id) ?
        getTab(commandTab.id) :
        browser.tabs
        .query({
            active: true,
            currentWindow: true,
        })
        .then((tabs) => tabs[0] ?? null)
        .catch((error) => {
            console.error(
                "Persistent Containers: Could not resolve command tab:",
                error,
            );

            return null;
        });

    const execute = async () => {
        const [capturedSource] = await Promise.all([
            sourcePromise,
            ready,
        ]);

        if (!capturedSource || isPrivateTab(capturedSource)) {
            return;
        }

        const source = await getTab(
            followReplacement(capturedSource.id),
        );

        if (
            !source ||
            isPrivateTab(source) ||
            source.windowId !== capturedSource.windowId
        ) {
            return;
        }

        const properties = {
            windowId: source.windowId,
            cookieStoreId: DEFAULT_CONTAINER,
            openerTabId: source.id,
            active: true,
        };

        if (settings.openNextToCurrent) {
            properties.index = source.index + 1;
        }

        const newTab = await createOwnedTab(properties);

        await applyTabGrouping(
            newTab.id,
            source.id,
            -1,
        );
    };

    execute().catch((error) => {

        reportError(
            "NO_CONTAINER_COMMAND_FAILED",
            "The command could not finish opening a non-container tab.",
            error, {
                command
            },
            "Check the preceding error and whether a new tab was already created.",
        );

    });
});

// -----------------------------------------------------------------------------
// Initialize after synchronous listener registration.
// -----------------------------------------------------------------------------

console.info(
    "[Persistent Containers] LISTENERS_READY: All event listeners registered.",
);
const ready = initialize()
    .then(() => {
        console.info(
            "[Persistent Containers] INITIALIZATION_READY: Background initialization completed.", {
                sessionStorageAvailable: Boolean(addonSession),
                trackedWindows: activeHistory.size,
                openNextToCurrent: settings.openNextToCurrent,
                inheritTabGroup: settings.inheritTabGroup,
            },
        );
    })
    .catch((error) => {
        reportError(
            "INITIALIZATION_FAILED",
            "Background initialization did not complete. Tab replacement will not proceed.",
            error, {},
            "Reload the extension after fixing the first reported error. Do not uninstall it just to troubleshoot.",
        );
        throw error;
    })
    .finally(() => {
        initializing = false;
        touchedWindows.clear();
    });
// Attach an explicit rejection handler so a failed initialization does not
// create an additional unhandled rejection from this startup chain.
ready.then(
    () => {
        persistState();
    },
    () => {
        // INITIALIZATION_FAILED was already reported above.
    },
);
