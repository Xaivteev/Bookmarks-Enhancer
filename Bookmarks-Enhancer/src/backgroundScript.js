const MAX_STATUS_FILL_RETRIES = 8;
const CONTENT_SCRIPT_FILES = ["browser-polyfill.js", "utils.js", "contentScript.js"];
const UNMATCHED_SEARCH_CONCURRENCY = 2;
// Only used for aged-build recovery heuristics (not Promise.race timeouts).
const INDEX_BUILD_STALE_MS = 120000;

const DEFAULT_ACTION_TITLE = "Enhance Bookmarks";
const ACTION_BUSY_TIMEOUT_MS = 60000;
const ACTION_BUSY_BADGE_TEXT = "…";
const ACTION_BUSY_BADGE_COLOR = "#475569";

let actionBusyGeneration = 0;
let actionBusyRemaining = 0;
let actionBusyClearTimer = null;

function beginActionBusy(tabCount = 1) {
	actionBusyGeneration += 1;
	const generation = actionBusyGeneration;
	actionBusyRemaining = Math.max(1, tabCount | 0);
	if (actionBusyClearTimer) {
		clearTimeout(actionBusyClearTimer);
	}
	actionBusyClearTimer = setTimeout(() => {
		forceEndActionBusy(generation);
	}, ACTION_BUSY_TIMEOUT_MS);

	Promise.resolve(browser.action.setBadgeText({ text: ACTION_BUSY_BADGE_TEXT })).catch(() => {});
	Promise.resolve(browser.action.setBadgeBackgroundColor({ color: ACTION_BUSY_BADGE_COLOR })).catch(() => {});
	Promise.resolve(browser.action.setTitle({ title: "Refreshing bookmark styles…" })).catch(() => {});
	return generation;
}

function clearActionBusyUi(expectedGeneration) {
	if (expectedGeneration !== actionBusyGeneration) return;
	actionBusyGeneration += 1;
	actionBusyRemaining = 0;
	if (actionBusyClearTimer) {
		clearTimeout(actionBusyClearTimer);
		actionBusyClearTimer = null;
	}
	Promise.resolve(browser.action.setBadgeText({ text: "" })).catch(() => {});
	Promise.resolve(browser.action.setTitle({ title: DEFAULT_ACTION_TITLE })).catch(() => {});
}

function endActionBusy(expectedGeneration) {
	if (expectedGeneration == null || expectedGeneration !== actionBusyGeneration) return;
	actionBusyRemaining = Math.max(0, actionBusyRemaining - 1);
	if (actionBusyRemaining > 0) return;
	clearActionBusyUi(expectedGeneration);
}

function forceEndActionBusy(expectedGeneration) {
	if (expectedGeneration == null || expectedGeneration !== actionBusyGeneration) return;
	clearActionBusyUi(expectedGeneration);
}

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
	if (message && message.refreshBusyComplete) {
		endActionBusy(message.actionBusyGeneration);
		return false;
	}

	if (message && message.hrefs) {
		const tabId = sender && sender.tab ? sender.tab.id : null;
		const authoritative = !!(message.authoritative || message.mode === "authoritative");
		ensureSettingsReady()
			.then(() => searchhrefs(message.hrefs, tabId, { authoritative }))
			.then(sendResponse)
			.catch(error => {
				onError(error);
				// Signal failure explicitly so content scripts do not wipe existing styles.
				sendResponse({ statuses: {}, error: String(error && error.message ? error.message : error) });
			});
		return true;
	}
	return false;
});

// Full refresh when the toolbar icon is clicked
browser.action.onClicked.addListener(() => {
	sendRefreshToActiveTab("authoritative", { showActionBusy: true });
});

function sendRefreshToActiveTab(mode, options = {}) {
	return browser.tabs.query({
		currentWindow: true,
		active: true
	}).then(tabs => {
		if (tabs.length > 0) {
			return refreshTabStyling(tabs[0].id, mode, options);
		}
		return undefined;
	}).catch(onError);
}

function sendTabMessage(tabId, payload) {
	return browser.tabs.sendMessage(tabId, payload)
		.catch(() => ensureContentScripts(tabId).then(() => browser.tabs.sendMessage(tabId, payload)));
}

function refreshTabStyling(tabId, mode = "authoritative", options = {}) {
	if (tabId == null) return Promise.resolve();

	// Icon/menu refresh is the recovery path when the SW index is stuck.
	recoverHungBookmarkIndex(true);

	const showActionBusy = !!options.showActionBusy && mode === "authoritative";
	let busyGeneration = null;
	if (showActionBusy) {
		busyGeneration = beginActionBusy();
	}

	return sendTabMessage(tabId, {
		refresh: true,
		mode,
		showActionBusy,
		actionBusyGeneration: busyGeneration
	}).catch(error => {
		if (busyGeneration != null) {
			endActionBusy(busyGeneration);
		}
		onError(error);
	});
}

// One shared cache wipe + index rebuild, then each tab restyles without
// re-invalidating the index (avoids N authoritative thrash).
function refreshAllTabsStyling() {
	return browser.tabs.query({}).then(tabs => {
		const targets = tabs.filter(tab => tab && tab.id != null);
		const busyGeneration = beginActionBusy(Math.max(targets.length, 1));

		recoverHungBookmarkIndex(true);
		invalidateBookmarkCaches();

		return ensureSettingsReady()
			.then(() => getBookmarkIndex())
			.then(() => {
				if (targets.length === 0) {
					forceEndActionBusy(busyGeneration);
					return;
				}

				for (const tab of targets) {
					sendTabMessage(tab.id, {
						refresh: true,
						mode: "rebuild",
						showActionBusy: true,
						actionBusyGeneration: busyGeneration
					}).catch(() => {
						endActionBusy(busyGeneration);
					});
				}
			})
			.catch(error => {
				forceEndActionBusy(busyGeneration);
				onError(error);
			});
	}).catch(onError);
}

function ensureContentScripts(tabId) {
	return browser.scripting.executeScript({
		target: { tabId },
		files: CONTENT_SCRIPT_FILES
	});
}

function updateRevealHiddenMenuTitle(revealed) {
	return browser.contextMenus.update(TOGGLE_REVEAL_HIDDEN_MENU_ID, {
		title: revealed ? "Hide items again" : "Show hidden items"
	}).catch(() => {});
}

function syncRevealHiddenMenuForTab(tabId) {
	if (tabId == null) {
		return updateRevealHiddenMenuTitle(false);
	}

	return browser.tabs.sendMessage(tabId, { getRevealHidden: true })
		.then(response => updateRevealHiddenMenuTitle(response && response.revealHidden))
		.catch(() => updateRevealHiddenMenuTitle(false));
}

function toggleRevealHiddenOnTab(tabId) {
	if (tabId == null) {
		return updateRevealHiddenMenuTitle(false).then(() => false);
	}

	return sendTabMessage(tabId, { toggleRevealHidden: true })
		.then(response => {
			const revealed = !!(response && response.revealHidden);
			return updateRevealHiddenMenuTitle(revealed).then(() => revealed);
		})
		.catch(error => {
			onError(error);
			return updateRevealHiddenMenuTitle(false).then(() => false);
		});
}

function onError(error) {
	console.log(`Error: ${error}`);
}

// Storage keys: STORAGE_KEYS from utils.js

let urlRules = [];
let bookmarkRules = [];
let unmatchedBookmarkStyle = "";
let styleRules = DEFAULT_STYLE_RULES.map(rule => ({ ...rule }));
const urlNormalizationCache = createUrlNormalizationCache();

let settingsReady = null;
let settingsLoadGeneration = 0;

function loadSettings() {
    return browser.storage.local
        .get([
			STORAGE_KEYS.urlRules,
			STORAGE_KEYS.bookmarkRules,
			STORAGE_KEYS.styleRules,
			STORAGE_KEYS.textRules,
			LEGACY_STORAGE_KEYS.textFilters,
			LEGACY_STORAGE_KEYS.enableSeenStyling,
			LEGACY_STORAGE_KEYS.blockedFolderId,
			LEGACY_STORAGE_KEYS.favoritedFolderId
		])
        .then(result => {
            urlRules = Array.isArray(result[STORAGE_KEYS.urlRules])
                ? result[STORAGE_KEYS.urlRules]
                : [];
			const migratedRules = migrateBookmarkRulesFromStorage(result);
			bookmarkRules = migratedRules.filter(rule => !isUnmatchedBookmarkRule(rule));
			unmatchedBookmarkStyle = migratedRules.find(isUnmatchedBookmarkRule)?.style || "";
			styleRules = migrateStyleRulesFromStorage(result);
			return purgeLegacyStorage(result);
        });
}

function ensureSettingsReady() {
	if (!settingsReady) {
		const loadGeneration = ++settingsLoadGeneration;
		settingsReady = loadSettings()
			.then(() => restoreStatusCacheFromSession())
			.catch(error => {
				onError(error);
				// Allow a later request to retry instead of staying wedged forever.
				if (loadGeneration === settingsLoadGeneration) {
					settingsReady = null;
				}
				throw error;
			});
	}
	return settingsReady;
}

ensureSettingsReady()
	.then(() => getBookmarkIndex())
	.catch(onError);

const SESSION_STATUS_CACHE_KEY = "beBookmarkStatusCache";

const RULE_LINK_MENU_PREFIX = "addLinkToRuleFolder:";
const RULE_PAGE_MENU_PREFIX = "addPageToRuleFolder:";
const RULE_LINK_MENU_PARENT = "addLinkToRuleFolderParent";
const RULE_PAGE_MENU_PARENT = "addPageToRuleFolderParent";
const TEXT_RULE_MENU_PARENT = "addTextRuleParent";
const TEXT_RULE_MENU_PREFIX = "addTextRuleStyle:";
const REFRESH_TAB_STYLING_MENU_ID = "refreshTabStyling";
const REFRESH_ALL_TABS_STYLING_MENU_ID = "refreshAllTabsStyling";
const TOGGLE_REVEAL_HIDDEN_MENU_ID = "toggleRevealHidden";
const LEGACY_LINK_MENU_IDS = ["addLinkBlocked", "addLinkFavorited", "addTextFilter"];
let ruleFolderMenuIds = [];
let textRuleMenuIds = [];

// Lightweight menus only on wake; defer folder/text menus so they don't
// compete with first-page bookmark index work.
function createStaticContextMenus() {
	const menuDefinitions = [
		{
			id: 'selectTargetClasses',
			title: 'Select Target Classes',
			contexts: ['page', 'action']
		},
		{
			id: TOGGLE_REVEAL_HIDDEN_MENU_ID,
			title: 'Show hidden items',
			contexts: ['page', 'action']
		},
		{
			id: REFRESH_TAB_STYLING_MENU_ID,
			title: 'Refresh styling on this tab',
			contexts: ['page', 'action']
		},
		{
			id: REFRESH_ALL_TABS_STYLING_MENU_ID,
			title: 'Refresh styling on all tabs',
			contexts: ['action']
		}
	];

	browser.contextMenus.remove('authoritativeRefresh').catch(() => {});
	for (const legacyId of LEGACY_LINK_MENU_IDS) {
		browser.contextMenus.remove(legacyId).catch(() => {});
	}

	for (const definition of menuDefinitions) {
		browser.contextMenus.remove(definition.id)
			.catch(() => {})
			.finally(() => {
				try {
					browser.contextMenus.create(definition);
				} catch (e) {
					console.error('Context menu creation failed', e);
				}
			});
	}
}

function scheduleDeferredDynamicMenus() {
	const run = () => {
		refreshTextRuleContextMenus();
		refreshRuleFolderContextMenus();
	};
	if (typeof globalThis.requestIdleCallback === "function") {
		globalThis.requestIdleCallback(() => run(), { timeout: 1500 });
	} else {
		setTimeout(run, 250);
	}
}

function removeContextMenu(id) {
	return browser.contextMenus.remove(id).catch(() => {});
}

function getRuleFolderStyleLabel(styleId) {
	const rule = styleRules.find(styleRule => styleRule.id === styleId);
	return rule?.name || styleId || "Style";
}

function getFolderRuleMenuTitle(folderTitle, styleId) {
	return `${folderTitle || "Folder"} (${getRuleFolderStyleLabel(styleId)})`;
}

function createRuleFolderChildMenus(parentId, idPrefix, contexts) {
	return Promise.all(bookmarkRules.map(rule =>
		getValidFolderId(rule.folderId).then(folderId => {
			if (!folderId) return null;

			return browser.bookmarks.get(folderId).then(nodes => {
				const folder = nodes.find(node => node.type === "folder") || nodes[0];
				if (!folder) return null;

				const menuId = idPrefix + folderId;
				browser.contextMenus.create({
					id: menuId,
					parentId,
					title: getFolderRuleMenuTitle(folder.title, rule.style),
					contexts
				});
				ruleFolderMenuIds.push(menuId);
				return menuId;
			});
		}).catch(onError)
	));
}

function refreshRuleFolderContextMenus() {
	return ensureSettingsReady().then(() => {
		const removals = [
			removeContextMenu(RULE_LINK_MENU_PARENT),
			removeContextMenu(RULE_PAGE_MENU_PARENT),
			...ruleFolderMenuIds.map(removeContextMenu),
			...LEGACY_LINK_MENU_IDS.map(removeContextMenu)
		];
		ruleFolderMenuIds = [];

		return Promise.all(removals).then(() => {
			if (bookmarkRules.length === 0) return;

			browser.contextMenus.create({
				id: RULE_LINK_MENU_PARENT,
				title: "Add link to rule folder",
				contexts: ["link"]
			});
			browser.contextMenus.create({
				id: RULE_PAGE_MENU_PARENT,
				title: "Add page to rule folder",
				contexts: ["page"]
			});

			return Promise.all([
				createRuleFolderChildMenus(
					RULE_LINK_MENU_PARENT,
					RULE_LINK_MENU_PREFIX,
					["link"]
				),
				createRuleFolderChildMenus(
					RULE_PAGE_MENU_PARENT,
					RULE_PAGE_MENU_PREFIX,
					["page"]
				)
			]);
		});
	}).catch(onError);
}

function refreshTextRuleContextMenus() {
	return ensureSettingsReady().then(() => {
		const removals = [
			removeContextMenu(TEXT_RULE_MENU_PARENT),
			...textRuleMenuIds.map(removeContextMenu)
		];
		textRuleMenuIds = [];

		return Promise.all(removals).then(() => {
			const styles = Array.isArray(styleRules) && styleRules.length > 0
				? styleRules
				: DEFAULT_STYLE_RULES;

			browser.contextMenus.create({
				id: TEXT_RULE_MENU_PARENT,
				title: "Add selection as text rule",
				contexts: ["selection"]
			});

			for (const styleRule of styles) {
				const menuId = TEXT_RULE_MENU_PREFIX + styleRule.id;
				browser.contextMenus.create({
					id: menuId,
					parentId: TEXT_RULE_MENU_PARENT,
					title: styleRule.name || styleRule.id,
					contexts: ["selection"]
				});
				textRuleMenuIds.push(menuId);
			}
		});
	}).catch(onError);
}

createStaticContextMenus();
ensureSettingsReady().then(() => scheduleDeferredDynamicMenus()).catch(onError);
browser.tabs.query({ currentWindow: true, active: true })
	.then(tabs => {
		if (tabs[0]) syncRevealHiddenMenuForTab(tabs[0].id);
	})
	.catch(() => {});

function getValidFolderId(folderId) {
	if (!folderId) return Promise.resolve(null);
	return browser.bookmarks.get(folderId).then(nodes => {
		const folder = nodes.find(isFolderNode);
		return folder ? folder.id : null;
	}).catch(() => null);
}

function createBookmarkInFolder(folderId, url, title) {
	return getValidFolderId(folderId).then(validFolderId => {
		if (!validFolderId) {
			throw new Error("Configured bookmark rule folder no longer exists");
		}
		return browser.bookmarks.create({
			parentId: validFolderId,
			title: title || url,
			url
		});
	});
}

function notifyAllTabsRefresh(mode = "optimistic") {
	return browser.tabs.query({}).then(tabs => {
		for (const t of tabs) {
			browser.tabs.sendMessage(t.id, { refresh: true, mode }).catch(() => {});
		}
	}).catch(() => {});
}

let configRefreshNotifyTimer = null;
let optimisticRefreshNotifyTimer = null;

function scheduleConfigTabsRefresh() {
	if (configRefreshNotifyTimer) {
		clearTimeout(configRefreshNotifyTimer);
	}
	configRefreshNotifyTimer = setTimeout(() => {
		configRefreshNotifyTimer = null;
		notifyAllTabsRefresh("authoritative");
	}, 75);
}

// Bookmark create/edit/delete: optimistic only. Authoritative all-tab refresh
// re-runs unmatched lookups and can starve the browser bookmarks UI.
function scheduleOptimisticTabsRefresh() {
	if (optimisticRefreshNotifyTimer) {
		clearTimeout(optimisticRefreshNotifyTimer);
	}
	optimisticRefreshNotifyTimer = setTimeout(() => {
		optimisticRefreshNotifyTimer = null;
		notifyAllTabsRefresh("optimistic");
	}, 75);
}

function notifyTabsStatusUpdates(statusByHref) {
	if (!statusByHref || Object.keys(statusByHref).length === 0) {
		return scheduleOptimisticTabsRefresh();
	}
	return browser.tabs.query({}).then(tabs => {
		for (const t of tabs) {
			browser.tabs.sendMessage(t.id, { statusUpdates: statusByHref }).catch(() => {});
		}
	}).catch(() => {});
}

// When any lookup discovers a positive, share it with all tabs so an earlier
// "none" on another tab can upgrade without re-searching.
let pendingPositiveBroadcasts = null;
let positiveBroadcastTimer = null;
const POSITIVE_BROADCAST_DEBOUNCE_MS = 25;

function schedulePositiveStatusBroadcast(href, status) {
	if (!href || !status || status === "none") return;
	if (!pendingPositiveBroadcasts) {
		pendingPositiveBroadcasts = {};
	}
	pendingPositiveBroadcasts[href] = status;
	if (positiveBroadcastTimer) return;
	positiveBroadcastTimer = setTimeout(() => {
		positiveBroadcastTimer = null;
		const batch = pendingPositiveBroadcasts;
		pendingPositiveBroadcasts = null;
		if (!batch || Object.keys(batch).length === 0) return;
		notifyTabsStatusUpdates(batch);
	}, POSITIVE_BROADCAST_DEBOUNCE_MS);
}

function clearPendingPositiveStatusBroadcasts() {
	if (positiveBroadcastTimer) {
		clearTimeout(positiveBroadcastTimer);
		positiveBroadcastTimer = null;
	}
	pendingPositiveBroadcasts = null;
}

function setBookmarkStatus(href, status, { broadcastPositive = true } = {}) {
	if (!href || status === undefined || status === null) return;
	// Positives only — never cache "none". Sticky negatives blocked folder
	// re-checks and required an authoritative refresh to recover.
	if (!status || status === "none") {
		bookmarkStatusMap.delete(href);
		return;
	}
	unmatchedMissSet.delete(href);
	const previous = bookmarkStatusMap.has(href) ? bookmarkStatusMap.get(href) : null;
	bookmarkStatusMap.set(href, status);
	if (broadcastPositive && previous !== status) {
		schedulePositiveStatusBroadcast(href, status);
	}
}

function rememberUnmatchedMiss(href) {
	if (!href) return;
	if (bookmarkStatusMap.has(href)) return;
	unmatchedMissSet.add(href);
}

function clearUnmatchedMisses(hrefs) {
	if (!hrefs) {
		unmatchedMissSet = new Set();
		return;
	}
	for (const href of hrefs) {
		if (href) unmatchedMissSet.delete(href);
	}
}

const CONFIG_REFRESH_STORAGE_KEY_SET = new Set(CONFIG_REFRESH_STORAGE_KEYS);

function addSelectionAsTextRule(selection, site, styleId) {
	const style = styleId || "blocked";
	const normalizedSite = normalizeSite(site) || site;
	return browser.storage.local.get([
		STORAGE_KEYS.textRules,
		LEGACY_STORAGE_KEYS.textFilters
	]).then(result => {
		const existing = migrateTextRulesFromStorage(result);
		const next = normalizeTextRules([
			...existing,
			{
				site: normalizedSite,
				text: selection,
				style
			}
		]);

		return browser.storage.local.set({
			[STORAGE_KEYS.textRules]: next
		}).then(() => browser.storage.local.remove([LEGACY_STORAGE_KEYS.textFilters]));
	});
}

function throwIfScriptInjectionFailed(results, label) {
	for (const result of results || []) {
		if (result && result.error != null) {
			const detail = result.error && result.error.message
				? result.error.message
				: String(result.error);
			throw new Error(`${label}: ${detail}`);
		}
	}
	return results;
}

function startClassPickerOnTab(tabId) {
	if (tabId == null) return Promise.resolve();

	const armLaunchFlag = () => browser.scripting.executeScript({
		target: { tabId },
		func: () => {
			globalThis.__beLaunchClassPicker = true;
		}
	}).then(results => throwIfScriptInjectionFailed(results, "arm class picker"));

	const injectPicker = () => browser.scripting.executeScript({
		target: { tabId },
		files: ["classPicker.js"]
	}).then(results => throwIfScriptInjectionFailed(results, "inject class picker"));

	const startPicker = () => browser.scripting.executeScript({
		target: { tabId },
		func: () => {
			const start = globalThis.__beStartClassPicker;
			if (typeof start !== "function") {
				throw new Error("Class picker is not available on this page");
			}
			start();
			return true;
		}
	}).then(results => throwIfScriptInjectionFailed(results, "start class picker"));

	return armLaunchFlag()
		.then(injectPicker)
		.then(startPicker)
		.catch(error => {
			// Already-injected picker, or a transient inject failure: try starting again.
			return startPicker()
				.catch(() => browser.tabs.sendMessage(tabId, { startClassPicker: true }))
				.catch(() => {
					onError(error);
				});
		});
}

function resolveContextMenuTab(tab) {
	if (tab && tab.id != null) return Promise.resolve(tab);
	return browser.tabs.query({ currentWindow: true, active: true })
		.then(tabs => tabs[0] || null);
}

browser.tabs.onActivated.addListener(({ tabId }) => {
	syncRevealHiddenMenuForTab(tabId);
});

browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
	// Navigations clear the page-level reveal class; keep the menu label in sync.
	if (changeInfo.status === "complete" && tab && tab.active) {
		syncRevealHiddenMenuForTab(tabId);
	}
});

browser.contextMenus.onClicked.addListener((info, tab) => {
	if (!info) return;

	resolveContextMenuTab(tab).then(resolvedTab => {
		if (!resolvedTab) return;
		handleContextMenuClick(info, resolvedTab);
	}).catch(onError);
});

function handleContextMenuClick(info, tab) {
	if (info.menuItemId === 'selectTargetClasses') {
		startClassPickerOnTab(tab.id);
		return;
	}

	if (info.menuItemId === TOGGLE_REVEAL_HIDDEN_MENU_ID) {
		toggleRevealHiddenOnTab(tab.id);
		return;
	}

	if (info.menuItemId === REFRESH_TAB_STYLING_MENU_ID) {
		refreshTabStyling(tab.id, "authoritative", { showActionBusy: true });
		return;
	}

	if (info.menuItemId === REFRESH_ALL_TABS_STYLING_MENU_ID) {
		refreshAllTabsStyling();
		return;
	}

	if (
		typeof info.menuItemId === "string" &&
		info.menuItemId.startsWith(TEXT_RULE_MENU_PREFIX)
	) {
		const selection = (info.selectionText || '').trim();
		if (!selection) return;
		const styleId = info.menuItemId.slice(TEXT_RULE_MENU_PREFIX.length);
		let site = '';
		try { site = normalizeSite(new URL(tab.url).hostname); }
		catch (e) { site = tab.url || ''; }

		addSelectionAsTextRule(selection, site, styleId).catch(onError);
		return;
	}

	if (typeof info.menuItemId !== "string") return;

	let folderId = null;
	let url = null;
	let title = null;

	if (info.menuItemId.startsWith(RULE_LINK_MENU_PREFIX)) {
		url = info.linkUrl;
		if (!url) return;
		folderId = info.menuItemId.slice(RULE_LINK_MENU_PREFIX.length);
		title = info.linkText || url;
	} else if (info.menuItemId.startsWith(RULE_PAGE_MENU_PREFIX)) {
		url = tab.url;
		if (!url || !/^https?:/i.test(url)) return;
		folderId = info.menuItemId.slice(RULE_PAGE_MENU_PREFIX.length);
		title = tab.title || url;
	} else {
		return;
	}

	ensureSettingsReady()
		.then(() => createBookmarkInFolder(folderId, url, title))
		// bookmarks.onCreated updates the live index/status and notifies tabs.
		.catch(onError);
}

// Listen for storage changes and update settings dynamically
browser.storage.onChanged.addListener((changes, areaName) => {
	if (areaName !== "local") return;

	let shouldRefreshTabs = false;

	if (changes[STORAGE_KEYS.urlRules]) {
		urlRules = Array.isArray(changes[STORAGE_KEYS.urlRules].newValue)
			? changes[STORAGE_KEYS.urlRules].newValue
			: [];
		urlNormalizationCache.clear();
		invalidateBookmarkCaches();
		shouldRefreshTabs = true;
	}

	if (changes[STORAGE_KEYS.bookmarkRules]) {
		const migratedRules = migrateBookmarkRulesFromStorage({
			bookmarkRules: changes[STORAGE_KEYS.bookmarkRules].newValue
		});
		bookmarkRules = migratedRules.filter(rule => !isUnmatchedBookmarkRule(rule));
		unmatchedBookmarkStyle = migratedRules.find(isUnmatchedBookmarkRule)?.style || "";
		invalidateBookmarkCaches();
		refreshRuleFolderContextMenus();
		shouldRefreshTabs = true;
	}

	if (changes[STORAGE_KEYS.styleRules]) {
		styleRules = migrateStyleRulesFromStorage({
			styleRules: changes[STORAGE_KEYS.styleRules].newValue
		});
		invalidateBookmarkCaches();
		refreshTextRuleContextMenus();
		refreshRuleFolderContextMenus();
		shouldRefreshTabs = true;
	}

	for (const key of Object.keys(changes)) {
		if (CONFIG_REFRESH_STORAGE_KEY_SET.has(key)) {
			shouldRefreshTabs = true;
			break;
		}
	}

	if (shouldRefreshTabs) {
		scheduleConfigTabsRefresh();
	}
});

let bookmarkStatusMap = new Map(); // href -> positive status string only (never "none")
let unmatchedUrlSet = new Set(); // normalized hrefs bookmarked outside rule folders
// Soft unmatched-search misses for the current index generation. Cleared whenever
// bookmarkCacheGeneration bumps so folder re-checks can recover without re-searching
// every non-match on each scan.
let unmatchedMissSet = new Set();
let tabHrefSets = new Map(); // tabId -> Set of normalized hrefs seen from that tab
let bookmarkIndexPromise = null;
let liveBookmarkIndex = null;
let bookmarkCacheGeneration = 0;
let bookmarkIndexBuildId = 0;
let bookmarkIndexStartedAt = 0;
let bookmarkIndexBuilding = false;
let persistStatusCacheTimer = null;

function isUnmatchedStylingEnabled() {
	const styleIds = new Set((styleRules || []).map(rule => rule.id));
	return !!(unmatchedBookmarkStyle && styleIds.has(unmatchedBookmarkStyle));
}

function getStatusCacheFingerprint() {
	return JSON.stringify({
		bookmarkRules,
		unmatchedBookmarkStyle,
		styleRuleIds: (styleRules || []).map(rule => rule.id),
		urlRules
	});
}

function restoreStatusCacheFromSession() {
	if (!browser.storage.session) return Promise.resolve();

	return browser.storage.session.get(SESSION_STATUS_CACHE_KEY).then(result => {
		const cached = result && result[SESSION_STATUS_CACHE_KEY];
		if (!cached || typeof cached !== "object") return;
		if (cached.fingerprint !== getStatusCacheFingerprint()) return;

		// Positives only — never restore "none" (or any negative).
		if (cached.statuses && typeof cached.statuses === "object") {
			bookmarkStatusMap = new Map(
				Object.entries(cached.statuses).filter(([, status]) => status && status !== "none")
			);
		}
		if (Array.isArray(cached.unmatchedUrls)) {
			unmatchedUrlSet = new Set(cached.unmatchedUrls.filter(Boolean));
		}
		// Miss memos are generation-scoped and not persisted across SW restarts.
		unmatchedMissSet = new Set();
	}).catch(() => {});
}

function clearSessionStatusCache() {
	if (persistStatusCacheTimer) {
		clearTimeout(persistStatusCacheTimer);
		persistStatusCacheTimer = null;
	}
	if (!browser.storage.session) return;
	browser.storage.session.remove(SESSION_STATUS_CACHE_KEY).catch(() => {});
}

function schedulePersistStatusCache() {
	if (!browser.storage.session) return;
	if (persistStatusCacheTimer) {
		clearTimeout(persistStatusCacheTimer);
	}
	persistStatusCacheTimer = setTimeout(() => {
		persistStatusCacheTimer = null;
		const statuses = {};
		for (const [href, status] of bookmarkStatusMap) {
			if (status) {
				statuses[href] = status;
			}
		}
		browser.storage.session.set({
			[SESSION_STATUS_CACHE_KEY]: {
				fingerprint: getStatusCacheFingerprint(),
				statuses,
				unmatchedUrls: Array.from(unmatchedUrlSet)
			}
		}).catch(() => {});
	}, 400);
}

function hrefReferencedByOtherTab(exceptTabId, href) {
	for (const [tabId, hrefSet] of tabHrefSets) {
		if (tabId === exceptTabId) continue;
		if (hrefSet.has(href)) return true;
	}
	return false;
}

function rememberTabHrefs(tabId, hrefs) {
	if (tabId == null || tabId === undefined) return;

	let hrefSet = tabHrefSets.get(tabId);
	if (!hrefSet) {
		hrefSet = new Set();
		tabHrefSets.set(tabId, hrefSet);
	}

	for (const href of hrefs || []) {
		if (href) hrefSet.add(href);
	}
}

// Drop per-tab href tracking without wiping the global status map.
// Shared URLs must stay warm for other tabs; optionally drop exclusive
// unmatched soft-miss memos so this tab's requery can re-search.
function forgetTabHrefTracking(tabId, { dropExclusiveNones = false } = {}) {
	const hrefSet = tabHrefSets.get(tabId);
	if (!hrefSet) return;

	if (dropExclusiveNones) {
		for (const href of hrefSet) {
			if (!unmatchedMissSet.has(href)) continue;
			if (hrefReferencedByOtherTab(tabId, href)) continue;
			unmatchedMissSet.delete(href);
		}
	}

	tabHrefSets.delete(tabId);
}

// Drop a settled index so the next getBookmarkIndex() re-reads rule folders.
// Unlike invalidateBookmarkCaches(), this keeps status maps (callers clear URLs).
function invalidateLiveBookmarkIndex() {
	bookmarkCacheGeneration += 1;
	bookmarkIndexBuildId += 1;
	bookmarkIndexPromise = null;
	liveBookmarkIndex = null;
	bookmarkIndexBuilding = false;
	bookmarkIndexStartedAt = 0;
	clearUnmatchedMisses();
	abandonUnmatchedSearches();
}

function searchhrefs(hrefs, tabId = null, options = {}) {
	// contentScript asks if links have been bookmarked
	// Normalize once; retries reuse validHrefs instead of re-entering searchhrefs.
	const normalizedHrefs = hrefs.map(normalizeHrefForSearch);
	const validHrefs = normalizedHrefs.filter(isValidBookmarkUrl);
	rememberTabHrefs(tabId, validHrefs);

	// Hard refresh must bypass in-memory/session status hits and re-resolve
	// against a freshly built folder index (settled indexes can go stale).
	if (options && options.authoritative) {
		clearStatusesForUrls(validHrefs);
		clearUnmatchedMisses(validHrefs);
		for (const href of validHrefs) {
			unmatchedUrlSet.delete(href);
		}
		invalidateLiveBookmarkIndex();
	}

	return fillBookmarkStatuses(validHrefs, 0, tabId);
}

function deliverStatusFollowUp(tabId, statusByHref) {
	if (!statusByHref || Object.keys(statusByHref).length === 0) return;
	if (tabId != null) {
		sendTabMessage(tabId, { statusUpdates: statusByHref }).catch(() => {});
		return;
	}
	notifyTabsStatusUpdates(statusByHref);
}

function buildPartialStatusResponse(requestedHrefs, pendingHrefs) {
	const pending = new Set(pendingHrefs);
	const statuses = {};

	for (const href of new Set(requestedHrefs)) {
		// Omit URLs still waiting on unmatched search so the content script
		// does not treat them as definitive "none" before the follow-up arrives.
		if (pending.has(href)) continue;
		statuses[href] = bookmarkStatusMap.get(href) || "none";
	}

	return { statuses, partial: true };
}

function fillBookmarkStatuses(validHrefs, retryCount = 0, tabId = null) {
	// Positives only in bookmarkStatusMap — unknowns always re-check the folder
	// index (cheap Map.get) so a prior soft miss cannot stick.
	const hrefsToSearch = validHrefs.filter(href => !bookmarkStatusMap.has(href));
	if (hrefsToSearch.length === 0) {
		return Promise.resolve(buildStatusResponse(validHrefs));
	}

	// Folder-only index for rule matches; unmatched uses live set + light URL search.
	// Never call bookmarks.getTree() here — a hung getTree wedges the SW until it dies.
	return getBookmarkIndex().then(index => {
		if (index.generation !== bookmarkCacheGeneration) {
			if (retryCount >= MAX_STATUS_FILL_RETRIES) {
				throw new Error("Bookmark status lookup aborted after repeated cache invalidation");
			}
			return fillBookmarkStatuses(validHrefs, retryCount + 1, tabId);
		}

		const needsUnmatchedSearch = [];
		const unmatchedEnabled = !!(
			index.unmatchedBookmarkStyle &&
			index.styleIds.has(index.unmatchedBookmarkStyle)
		);

		for (const href of hrefsToSearch) {
			if (bookmarkStatusMap.has(href)) continue;

			const bookmarkList = index.bookmarksByNormalizedUrl.get(href) || [];
			let status = "none";
			let bestPriority = Infinity;

			for (const bookmark of bookmarkList) {
				const matched = findMatchingRuleStyle(
					bookmark,
					index.rules,
					index.parentById
				);
				if (!matched) continue;
				if (matched.priority < bestPriority) {
					status = matched.styleId;
					bestPriority = matched.priority;
					if (bestPriority === 0) break;
				}
			}

			if (status !== "none") {
				setBookmarkStatus(href, status);
			} else if (unmatchedEnabled && unmatchedUrlSet.has(href)) {
				setBookmarkStatus(href, index.unmatchedBookmarkStyle);
			} else if (unmatchedEnabled && unmatchedMissSet.has(href)) {
				// Generation-scoped soft miss — report "none" without re-searching.
			} else if (unmatchedEnabled) {
				needsUnmatchedSearch.push(href);
			}
			// Folder miss with unmatched disabled: do not cache a negative.
		}

		const finish = () => {
			if (index.generation !== bookmarkCacheGeneration) {
				if (retryCount >= MAX_STATUS_FILL_RETRIES) {
					throw new Error("Bookmark status lookup aborted after repeated cache invalidation");
				}
				return fillBookmarkStatuses(validHrefs, retryCount + 1, tabId);
			}
			schedulePersistStatusCache();
			return buildStatusResponse(validHrefs);
		};

		if (needsUnmatchedSearch.length === 0) {
			return finish();
		}

		// Return folder / cached hits immediately; finish unmatched search in the
		// background and push those statuses to the requesting tab afterward.
		schedulePersistStatusCache();
		const earlyResponse = buildPartialStatusResponse(validHrefs, needsUnmatchedSearch);

		resolveUnmatchedSearches(needsUnmatchedSearch, index)
			.then(() => {
				if (index.generation !== bookmarkCacheGeneration) {
					if (retryCount >= MAX_STATUS_FILL_RETRIES) return;
					return fillBookmarkStatuses(validHrefs, retryCount + 1, tabId).then(response => {
						if (response && response.statuses) {
							deliverStatusFollowUp(tabId, response.statuses);
						}
					});
				}

				schedulePersistStatusCache();
				const updates = {};
				for (const href of needsUnmatchedSearch) {
					updates[href] = bookmarkStatusMap.get(href) || "none";
				}
				deliverStatusFollowUp(tabId, updates);
			})
			.catch(onError);

		return earlyResponse;
	});
}

function urlSearchCandidates(href) {
	const candidates = new Set();
	if (!href) return [];
	candidates.add(href);
	try {
		const url = new URL(href);
		candidates.add(url.href);
		if (url.href.endsWith("/")) {
			candidates.add(url.href.replace(/\/+$/, "") || url.href);
		} else {
			candidates.add(`${url.href}/`);
		}
		url.hash = "";
		candidates.add(url.href);
	} catch {
		// keep href only
	}
	return Array.from(candidates);
}

function findBookmarksForNormalizedHref(href) {
	const matchesNormalized = results =>
		(results || []).filter(bookmark =>
			bookmark &&
			bookmark.url &&
			normalizeHrefForSearch(bookmark.url) === href
		);

	// Exact URL searches only (plus a few variants). Avoid bookmarks.search(string)
	// of a full URL, which scans the whole library and stalls the native bookmarks UI.
	const candidates = urlSearchCandidates(href);
	let chain = Promise.resolve([]);

	for (const candidate of candidates) {
		chain = chain.then(found => {
			if (found.length > 0) return found;
			return browser.bookmarks.search({ url: candidate })
				.catch(() => [])
				.then(matchesNormalized);
		});
	}

	return chain.then(found => {
		if (found.length > 0) return found;

		// Light query: host + path terms only (needed when stored URLs keep tracking
		// params that normalization strips from the page href).
		let lightQuery = "";
		try {
			const url = new URL(href);
			lightQuery = `${url.hostname} ${url.pathname}`.trim();
		} catch {
			return [];
		}
		if (!lightQuery) return [];

		return browser.bookmarks.search(lightQuery)
			.catch(() => [])
			.then(matchesNormalized);
	});
}

// Global unmatched-search queue: one in-flight search per href, shared across
// tabs, capped at UNMATCHED_SEARCH_CONCURRENCY workers total (not per request).
const unmatchedSearchWaiters = new Map(); // href -> { promise, resolve, generation, unmatchedStyle }
let unmatchedSearchQueue = [];
let unmatchedSearchActive = 0;

function abandonUnmatchedSearches() {
	unmatchedSearchQueue = [];
	const waiters = Array.from(unmatchedSearchWaiters.values());
	unmatchedSearchWaiters.clear();
	for (const entry of waiters) {
		entry.resolve();
	}
}

function resolveUnmatchedSearches(hrefs, index) {
	return Promise.all(hrefs.map(href => ensureUnmatchedSearch(href, index)));
}

function ensureUnmatchedSearch(href, index) {
	if (!href) return Promise.resolve();
	if (bookmarkStatusMap.has(href)) return Promise.resolve();
	if (unmatchedMissSet.has(href)) return Promise.resolve();

	const existing = unmatchedSearchWaiters.get(href);
	if (existing) {
		return existing.promise;
	}

	let resolveFn = null;
	const promise = new Promise(resolve => {
		resolveFn = resolve;
	});
	unmatchedSearchWaiters.set(href, {
		promise,
		resolve: resolveFn,
		generation: index.generation,
		unmatchedStyle: index.unmatchedBookmarkStyle
	});
	unmatchedSearchQueue.push(href);
	pumpUnmatchedSearchQueue();
	return promise;
}

function pumpUnmatchedSearchQueue() {
	while (
		unmatchedSearchActive < UNMATCHED_SEARCH_CONCURRENCY &&
		unmatchedSearchQueue.length > 0
	) {
		const href = unmatchedSearchQueue.shift();
		const entry = unmatchedSearchWaiters.get(href);
		if (!entry) continue;

		if (
			bookmarkStatusMap.has(href) ||
			unmatchedMissSet.has(href) ||
			entry.generation !== bookmarkCacheGeneration
		) {
			unmatchedSearchWaiters.delete(href);
			entry.resolve();
			continue;
		}

		unmatchedSearchActive += 1;
		findBookmarksForNormalizedHref(href)
			.then(bookmarks => {
				if (entry.generation !== bookmarkCacheGeneration) return;
				if (bookmarkStatusMap.has(href)) return;
				if (bookmarks.length > 0) {
					unmatchedUrlSet.add(href);
					setBookmarkStatus(href, entry.unmatchedStyle);
				} else {
					// Soft miss for this index generation only — never poison
					// bookmarkStatusMap with "none".
					rememberUnmatchedMiss(href);
				}
			})
			.catch(() => {
				// Search failures are transient — do not memoize a miss or a later
				// pass can stick on an unstyled result until hard refresh.
			})
			.finally(() => {
				unmatchedSearchActive = Math.max(0, unmatchedSearchActive - 1);
				if (unmatchedSearchWaiters.get(href) === entry) {
					unmatchedSearchWaiters.delete(href);
				}
				entry.resolve();
				pumpUnmatchedSearchQueue();
			});
	}
}

function buildStatusResponse(requestedHrefs) {
	const statuses = {};

	for (const href of new Set(requestedHrefs)) {
		// Unknowns report as "none" without polluting the positive-only map.
		statuses[href] = bookmarkStatusMap.get(href) || "none";
	}

	return { statuses };
}

function getBookmarkIndex() {
	if (liveBookmarkIndex && liveBookmarkIndex.generation === bookmarkCacheGeneration) {
		return Promise.resolve(liveBookmarkIndex);
	}

	// If a prior build has been in-flight far too long, drop it so a new request
	// (page reload / later lookup) can start fresh without rejecting healthy builds.
	recoverHungBookmarkIndex(false);

	if (!bookmarkIndexPromise) {
		const generationAtStart = bookmarkCacheGeneration;
		const buildId = ++bookmarkIndexBuildId;
		bookmarkIndexStartedAt = Date.now();
		bookmarkIndexBuilding = true;
		const buildPromise = buildBookmarkIndex()
			.then(index => {
				if (buildId !== bookmarkIndexBuildId) {
					// A recovery/reset abandoned this build.
					return getBookmarkIndex();
				}
				if (generationAtStart !== bookmarkCacheGeneration) {
					// Drop stale work. If invalidate already started a newer build, join it;
					// otherwise start one. All waiters on this promise share this single chain.
					if (bookmarkIndexPromise === buildPromise) {
						bookmarkIndexPromise = null;
						liveBookmarkIndex = null;
						bookmarkIndexBuilding = false;
					}
					return getBookmarkIndex();
				}
				index.generation = generationAtStart;
				liveBookmarkIndex = index;
				bookmarkIndexBuilding = false;
				return index;
			})
			.catch(error => {
				if (bookmarkIndexPromise === buildPromise) {
					bookmarkIndexPromise = null;
					liveBookmarkIndex = null;
					bookmarkIndexBuilding = false;
					bookmarkIndexStartedAt = 0;
				}
				throw error;
			});
		bookmarkIndexPromise = buildPromise;
	}
	return bookmarkIndexPromise;
}

function recoverHungBookmarkIndex(force = false) {
	// Only abandon in-flight builds. Settled successful promises must stay so
	// healthy icon clicks reuse liveBookmarkIndex instead of rebuilding folders.
	if (!bookmarkIndexBuilding) return;

	const aged = bookmarkIndexStartedAt > 0 &&
		(Date.now() - bookmarkIndexStartedAt > INDEX_BUILD_STALE_MS);

	// Force (toolbar/menu refresh) abandons a pending build immediately; otherwise
	// only abandon builds that have already exceeded the stale window.
	if (force || aged) {
		bookmarkIndexBuildId += 1;
		bookmarkIndexPromise = null;
		bookmarkIndexStartedAt = 0;
		bookmarkIndexBuilding = false;
		liveBookmarkIndex = null;
	}
}

// Folder-scoped index only. Unmatched bookmarks are resolved via per-URL search.
// Never use bookmarks.getTree() — a hung/cold getTree wedges the MV3 service worker
// until the browser kills it (matches "leave the window until it goes cold").
function buildBookmarkIndex() {
	const styleIds = new Set((styleRules || []).map(rule => rule.id));

	return resolveConfiguredRules(bookmarkRules).then(rules => {
		if (rules.length === 0) {
			return {
				rules,
				unmatchedBookmarkStyle,
				styleIds,
				indexesUnmatched: false,
				bookmarksByNormalizedUrl: new Map(),
				parentById: new Map(),
				bookmarkById: new Map(),
				urlByBookmarkId: new Map()
			};
		}

		return Promise.all(
			rules.map(rule => browser.bookmarks.getSubTree(rule.folderId))
		).then(subtrees => {
			const bookmarksByNormalizedUrl = new Map();
			const parentById = new Map();
			const bookmarkById = new Map();
			const urlByBookmarkId = new Map();
			for (const subtree of subtrees) {
				addBookmarkTreeToMaps(
					subtree,
					bookmarksByNormalizedUrl,
					parentById,
					bookmarkById,
					urlByBookmarkId
				);
			}
			return {
				rules,
				unmatchedBookmarkStyle,
				styleIds,
				indexesUnmatched: false,
				bookmarksByNormalizedUrl,
				parentById,
				bookmarkById,
				urlByBookmarkId
			};
		});
	});
}

function resolveConfiguredRules(rules) {
	return Promise.all(
		normalizeBookmarkRules(rules)
			.filter(rule => !isUnmatchedBookmarkRule(rule))
			.map(rule =>
				getValidFolderId(rule.folderId).then(folderId => (
					folderId ? { folderId, style: rule.style } : null
				))
			)
	).then(resolved => resolved.filter(Boolean));
}

function invalidateBookmarkCaches() {
	bookmarkCacheGeneration += 1;
	bookmarkIndexBuildId += 1;
	bookmarkStatusMap = new Map();
	unmatchedUrlSet = new Set();
	unmatchedMissSet = new Set();
	tabHrefSets = new Map();
	bookmarkIndexPromise = null;
	liveBookmarkIndex = null;
	bookmarkIndexBuilding = false;
	bookmarkIndexStartedAt = 0;
	abandonUnmatchedSearches();
	clearPendingPositiveStatusBroadcasts();
	clearSessionStatusCache();
}

function clearStatusesForUrls(urls) {
	for (const url of urls || []) {
		if (!url) continue;
		bookmarkStatusMap.delete(url);
		unmatchedMissSet.delete(url);
		for (const hrefSet of tabHrefSets.values()) {
			hrefSet.delete(url);
		}
	}
	schedulePersistStatusCache();
}

function isFolderNode(node) {
	return !!node && (node.type === "folder" || (!node.url && Array.isArray(node.children)));
}

function shouldIndexBookmarkInIndex(index, node) {
	if (!node || !node.url || !isValidBookmarkUrl(node.url)) return false;
	return index.rules.some(rule =>
		isBookmarkUnderFolder(node, rule.folderId, index.parentById)
	);
}

function removeBookmarkIdFromIndex(index, bookmarkId) {
	const affected = [];
	const normalized = index.urlByBookmarkId.get(bookmarkId);
	if (normalized) {
		affected.push(normalized);
		const list = index.bookmarksByNormalizedUrl.get(normalized) || [];
		const next = list.filter(node => node.id !== bookmarkId);
		if (next.length > 0) {
			index.bookmarksByNormalizedUrl.set(normalized, next);
		} else {
			index.bookmarksByNormalizedUrl.delete(normalized);
		}
	}
	index.urlByBookmarkId.delete(bookmarkId);
	index.bookmarkById.delete(bookmarkId);
	index.parentById.delete(bookmarkId);
	return affected;
}

function addBookmarkNodeToIndex(index, node) {
	const affected = [];
	if (!node || !node.id) return affected;

	index.bookmarkById.set(node.id, node);
	if (node.parentId) {
		index.parentById.set(node.id, node.parentId);
	}

	if (!shouldIndexBookmarkInIndex(index, node)) {
		// Outside rule folders: track for unmatched/"seen" without re-searching.
		if (node.url && isValidBookmarkUrl(node.url)) {
			const normalized = normalizeHrefForSearch(node.url);
			affected.push(normalized);
			unmatchedUrlSet.add(normalized);
			if (isUnmatchedStylingEnabled()) {
				setBookmarkStatus(normalized, unmatchedBookmarkStyle);
			} else {
				bookmarkStatusMap.delete(normalized);
				unmatchedMissSet.delete(normalized);
			}
		}
		return affected;
	}

	const normalized = normalizeHrefForSearch(node.url);
	unmatchedUrlSet.delete(normalized);
	index.urlByBookmarkId.set(node.id, normalized);
	if (!index.bookmarksByNormalizedUrl.has(normalized)) {
		index.bookmarksByNormalizedUrl.set(normalized, []);
	}
	const list = index.bookmarksByNormalizedUrl.get(normalized);
	if (!list.some(existing => existing.id === node.id)) {
		list.push(node);
	}
	affected.push(normalized);

	const matched = findMatchingRuleStyle(node, index.rules, index.parentById);
	if (matched) {
		setBookmarkStatus(normalized, matched.styleId);
	} else if (isUnmatchedStylingEnabled()) {
		unmatchedUrlSet.add(normalized);
		setBookmarkStatus(normalized, unmatchedBookmarkStyle);
	} else {
		bookmarkStatusMap.delete(normalized);
		unmatchedMissSet.delete(normalized);
	}
	return affected;
}

function rebuildIndexAfterStructuralChange() {
	invalidateBookmarkCaches();
	scheduleConfigTabsRefresh();
}

function withLiveBookmarkIndex(mutator) {
	return getBookmarkIndex()
		.then(index => {
			const affectedUrls = mutator(index) || [];
			const statusByHref = {};
			for (const url of affectedUrls) {
				if (!url) continue;
				statusByHref[url] = bookmarkStatusMap.get(url) || "none";
			}
			schedulePersistStatusCache();
			if (Object.keys(statusByHref).length > 0) {
				return notifyTabsStatusUpdates(statusByHref);
			}
			return scheduleOptimisticTabsRefresh();
		})
		.catch(() => {
			rebuildIndexAfterStructuralChange();
		});
}

function handleBookmarkCreated(id, bookmark) {
	if (isFolderNode(bookmark)) {
		return withLiveBookmarkIndex(index => {
			index.bookmarkById.set(id, bookmark);
			if (bookmark.parentId) {
				index.parentById.set(id, bookmark.parentId);
			}
			return [];
		});
	}

	return withLiveBookmarkIndex(index => addBookmarkNodeToIndex(index, { ...bookmark, id }));
}

function handleBookmarkRemoved(id, removeInfo) {
	const node = removeInfo && removeInfo.node;
	if (isFolderNode(node)) {
		rebuildIndexAfterStructuralChange();
		return Promise.resolve();
	}

	return withLiveBookmarkIndex(index => {
		const affected = removeBookmarkIdFromIndex(index, id);
		if (node && node.url && isValidBookmarkUrl(node.url)) {
			const normalized = normalizeHrefForSearch(node.url);
			affected.push(normalized);
			unmatchedUrlSet.delete(normalized);
			bookmarkStatusMap.delete(normalized);
		}
		return affected;
	});
}

function handleBookmarkMoved(id, moveInfo) {
	return browser.bookmarks.get(id).then(nodes => {
		const node = nodes && nodes[0];
		if (!node) {
			rebuildIndexAfterStructuralChange();
			return;
		}

		if (isFolderNode(node)) {
			rebuildIndexAfterStructuralChange();
			return;
		}

		return withLiveBookmarkIndex(index => {
			const affected = removeBookmarkIdFromIndex(index, id);
			const updated = {
				...node,
				parentId: moveInfo.parentId
			};
			affected.push(...addBookmarkNodeToIndex(index, updated));
			return affected;
		});
	}).catch(() => {
		rebuildIndexAfterStructuralChange();
	});
}

function handleBookmarkChanged(id, changeInfo) {
	return getBookmarkIndex()
		.then(index => {
			const existing = index.bookmarkById.get(id);
			if (!existing) {
				// Outside the current scoped index: only add if it now qualifies,
				// or track as unmatched.
				return browser.bookmarks.get(id).then(nodes => {
					const node = nodes && nodes[0];
					if (!node || isFolderNode(node)) return [];
					return addBookmarkNodeToIndex(index, node);
				});
			}

			if (isFolderNode(existing)) {
				if (changeInfo.title !== undefined) {
					index.bookmarkById.set(id, { ...existing, title: changeInfo.title });
				}
				return [];
			}

			const affected = [];
			if (changeInfo.url !== undefined) {
				const previousNormalized = index.urlByBookmarkId.get(id);
				affected.push(...removeBookmarkIdFromIndex(index, id));
				if (previousNormalized) {
					unmatchedUrlSet.delete(previousNormalized);
					bookmarkStatusMap.delete(previousNormalized);
				}
				const updated = {
					...existing,
					...changeInfo,
					id,
					parentId: existing.parentId
				};
				affected.push(...addBookmarkNodeToIndex(index, updated));
				return affected;
			}

			const updated = { ...existing, ...changeInfo, id };
			index.bookmarkById.set(id, updated);
			const normalized = index.urlByBookmarkId.get(id);
			if (normalized) {
				const list = index.bookmarksByNormalizedUrl.get(normalized) || [];
				index.bookmarksByNormalizedUrl.set(
					normalized,
					list.map(node => (node.id === id ? updated : node))
				);
			}
			return affected;
		})
		.then(affectedUrls => {
			const statusByHref = {};
			for (const url of affectedUrls || []) {
				if (!url) continue;
				statusByHref[url] = bookmarkStatusMap.get(url) || "none";
			}
			schedulePersistStatusCache();
			if (Object.keys(statusByHref).length > 0) {
				return notifyTabsStatusUpdates(statusByHref);
			}
			return undefined;
		})
		.catch(() => {
			rebuildIndexAfterStructuralChange();
		});
}

function findMatchingRuleStyle(bookmark, rules, parentById) {
	// First matching bookmark rule wins (table order in Bookmark Rules).
	for (let priority = 0; priority < rules.length; priority++) {
		const rule = rules[priority];
		if (!isBookmarkUnderFolder(bookmark, rule.folderId, parentById)) continue;
		return { styleId: rule.style, priority };
	}
	return null;
}

function isBookmarkUnderFolder(bookmark, folderId, parentById) {
	if (!bookmark || !folderId) return false;

	let currentId = bookmark.parentId;
	const visited = new Set();
	while (currentId && !visited.has(currentId)) {
		if (currentId === folderId) return true;
		visited.add(currentId);
		currentId = parentById.get(currentId);
	}
	return false;
}

function addBookmarkTreeToMaps(
	bookmarkTree,
	bookmarksByNormalizedUrl,
	parentById,
	bookmarkById,
	urlByBookmarkId
) {
	function visit(node, parentId = null) {
		if (!node || !node.id) return;

		bookmarkById.set(node.id, node);
		if (parentId) {
			parentById.set(node.id, parentId);
		}

		if (node.url && isValidBookmarkUrl(node.url)) {
			const normalized = normalizeHrefForSearch(node.url);
			urlByBookmarkId.set(node.id, normalized);
			if (!bookmarksByNormalizedUrl.has(normalized)) {
				bookmarksByNormalizedUrl.set(normalized, []);
			}
			bookmarksByNormalizedUrl.get(normalized).push(node);
		}

		if (Array.isArray(node.children)) {
			node.children.forEach(child => visit(child, node.id));
		}
	}

	(bookmarkTree || []).forEach(node => visit(node, null));
}

function isValidBookmarkUrl(href) {
	try {
		const url = new URL(href);
		return url.protocol === "http:" || url.protocol === "https:";
	} catch {
		return false;
	}
}

// On navigate/load, reset this tab's content-side processed state via requery.
// Do not wipe global statuses for URLs still useful to other tabs.
browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
	if (changeInfo.status === "complete" || changeInfo.url) {
		forgetTabHrefTracking(tabId, { dropExclusiveNones: true });
		sendTabMessage(tabId, { refresh: true, mode: "requery" }).catch(() => {});
	}
});

browser.tabs.onRemoved.addListener(tabId => {
	forgetTabHrefTracking(tabId);
});

browser.bookmarks.onRemoved.addListener((id, removeInfo) => {
	handleBookmarkRemoved(id, removeInfo);
});

browser.bookmarks.onCreated.addListener((id, bookmark) => {
	handleBookmarkCreated(id, bookmark);
});

browser.bookmarks.onMoved.addListener((id, moveInfo) => {
	handleBookmarkMoved(id, moveInfo);
});

browser.bookmarks.onChanged.addListener((id, changeInfo) => {
	handleBookmarkChanged(id, changeInfo);
});
