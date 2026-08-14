const CONTENT_SCRIPT_FILES = ["browser-polyfill.js", "utils.js", "contentScript.js", "lookShortcuts.js"];

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

	if (message && message.toggleLookShortcut) {
		const styleId = typeof message.styleId === "string" ? message.styleId : "";
		const url = message.url || (sender && sender.tab && sender.tab.url) || "";
		const title = message.title || (sender && sender.tab && sender.tab.title) || "";
		ensureSettingsReady()
			.then(() => toggleLookShortcut(url, title, styleId))
			.then(sendResponse)
			.catch(error => {
				onError(error);
				sendResponse({
					ok: false,
					error: String(error && error.message ? error.message : error)
				});
			});
		return true;
	}

	if (message && message.hrefs) {
		const tabId = sender && sender.tab ? sender.tab.id : null;
		const authoritative = !!(message.authoritative || message.mode === "authoritative");
		ensureSettingsReady()
			.then(() => searchhrefs(message.hrefs, tabId, { authoritative }))
			.then(sendResponse)
			.catch(error => {
				onError(error);
				sendResponse({ statuses: {}, error: String(error && error.message ? error.message : error) });
			});
		return true;
	}
	return false;
});

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

function refreshAllTabsStyling() {
	return browser.tabs.query({}).then(tabs => {
		const targets = tabs.filter(tab => tab && tab.id != null);
		const busyGeneration = beginActionBusy(Math.max(targets.length, 1));

		invalidateLinkCaches();

		return ensureSettingsReady()
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

let urlRules = [];
let sites = [];
let styleRules = DEFAULT_STYLE_RULES.map(rule => ({ ...rule }));
let linkLookupBySite = new Map();
const urlNormalizationCache = createUrlNormalizationCache();

let settingsReady = null;
let settingsLoadGeneration = 0;

function rebuildLinkLookup() {
	urlRules = sitesToUrlRules(sites);
	urlNormalizationCache.clear();
	linkLookupBySite = new Map();

	for (const siteConfig of sites) {
		const map = new Map();
		for (const link of siteConfig.links || []) {
			if (!link?.url) continue;
			const normalized = normalizeHrefForSearch(link.url);
			if (!normalized || map.has(normalized)) continue;
			map.set(normalized, link.style);
		}
		linkLookupBySite.set(siteConfig.site, map);
	}
}

function applyLoadedSites(nextSites, nextStyleRules) {
	sites = normalizeSites(nextSites);
	styleRules = Array.isArray(nextStyleRules)
		? nextStyleRules
		: DEFAULT_STYLE_RULES.map(rule => ({ ...rule }));
	rebuildLinkLookup();
}

function loadSettings() {
	return browser.storage.local.get(null).then(result => {
		styleRules = migrateStyleRulesFromStorage(result);
		return purgeLegacyStorage(result).then(migratedSites => {
			applyLoadedSites(migratedSites, styleRules);
		});
	});
}

function ensureSettingsReady() {
	if (!settingsReady) {
		const loadGeneration = ++settingsLoadGeneration;
		settingsReady = loadSettings()
			.catch(error => {
				onError(error);
				if (loadGeneration === settingsLoadGeneration) {
					settingsReady = null;
				}
				throw error;
			});
	}
	return settingsReady;
}

ensureSettingsReady().catch(onError);

const RULE_LINK_MENU_PREFIX = "addLinkToList:";
const RULE_PAGE_MENU_PREFIX = "addPageToList:";
const RULE_LINK_MENU_PARENT = "addLinkToListParent";
const RULE_PAGE_MENU_PARENT = "addPageToListParent";
const TEXT_RULE_MENU_PARENT = "addTextRuleParent";
const TEXT_RULE_MENU_PREFIX = "addTextRuleStyle:";
const REFRESH_TAB_STYLING_MENU_ID = "refreshTabStyling";
const REFRESH_ALL_TABS_STYLING_MENU_ID = "refreshAllTabsStyling";
const TOGGLE_REVEAL_HIDDEN_MENU_ID = "toggleRevealHidden";
const OPEN_OPTIONS_MENU_ID = "openOptions";
const LEGACY_LINK_MENU_IDS = [
	"addLinkBlocked",
	"addLinkFavorited",
	"addTextFilter",
	"addLinkToRuleFolderParent",
	"addPageToRuleFolderParent"
];
let listStyleMenuIds = [];
let textRuleMenuIds = [];

function createStaticContextMenus() {
	const menuDefinitions = [
		{
			id: "selectTargetClasses",
			title: "Select Target Classes",
			contexts: ["page", "action"]
		},
		{
			id: TOGGLE_REVEAL_HIDDEN_MENU_ID,
			title: "Show hidden items",
			contexts: ["page", "action"]
		},
		{
			id: REFRESH_TAB_STYLING_MENU_ID,
			title: "Refresh styling on this tab",
			contexts: ["page", "action"]
		},
		{
			id: REFRESH_ALL_TABS_STYLING_MENU_ID,
			title: "Refresh styling on all tabs",
			contexts: ["action"]
		},
		{
			id: OPEN_OPTIONS_MENU_ID,
			title: "Open settings",
			contexts: ["page", "action"]
		}
	];

	browser.contextMenus.remove("authoritativeRefresh").catch(() => {});
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
					console.error("Context menu creation failed", e);
				}
			});
	}
}

function scheduleDeferredDynamicMenus() {
	const run = () => {
		refreshTextRuleContextMenus();
		refreshSavedListContextMenus();
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

function createStyleChildMenus(parentId, idPrefix, contexts) {
	const styles = Array.isArray(styleRules) ? styleRules : [];

	return Promise.all(styles.map(styleRule => {
		const menuId = idPrefix + styleRule.id;
		browser.contextMenus.create({
			id: menuId,
			parentId,
			title: styleRule.name || styleRule.id,
			contexts
		});
		listStyleMenuIds.push(menuId);
		return menuId;
	}));
}

function refreshSavedListContextMenus() {
	return ensureSettingsReady().then(() => {
		const removals = [
			removeContextMenu(RULE_LINK_MENU_PARENT),
			removeContextMenu(RULE_PAGE_MENU_PARENT),
			...listStyleMenuIds.map(removeContextMenu)
		];
		listStyleMenuIds = [];

		return Promise.all(removals).then(() => {
			if (!Array.isArray(styleRules) || styleRules.length === 0) return;

			browser.contextMenus.create({
				id: RULE_LINK_MENU_PARENT,
				title: "Add link to list",
				contexts: ["link"]
			});
			browser.contextMenus.create({
				id: RULE_PAGE_MENU_PARENT,
				title: "Add page to list",
				contexts: ["page"]
			});

			return Promise.all([
				createStyleChildMenus(RULE_LINK_MENU_PARENT, RULE_LINK_MENU_PREFIX, ["link"]),
				createStyleChildMenus(RULE_PAGE_MENU_PARENT, RULE_PAGE_MENU_PREFIX, ["page"])
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
			const styles = Array.isArray(styleRules) ? styleRules : [];
			if (styles.length === 0) return;

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

function persistSites(nextSites) {
	const normalized = normalizeSites(nextSites);
	return browser.storage.local.set({
		[STORAGE_KEYS.sites]: normalized
	}).then(() => {
		applyLoadedSites(normalized, styleRules);
		return normalized;
	});
}

function addSelectionAsTextRule(selection, site, styleId) {
	return browser.storage.local.get(null).then(result => {
		const existing = migrateSitesFromStorage(result);
		const next = addTextRuleToSites(existing, site, selection, styleId);
		return persistSites(next);
	});
}

function addUrlToSiteList(url, title, styleId) {
	return browser.storage.local.get(null).then(result => {
		const existing = migrateSitesFromStorage(result);
		const next = upsertSiteLink(existing, url, title, styleId);
		return persistSites(next);
	});
}

function toggleLookShortcut(url, title, styleId) {
	if (!isValidHttpUrl(url) || !styleId) {
		return Promise.resolve({ ok: false });
	}
	if (!styleRules.some(rule => rule.id === styleId && rule.shortcutIcon)) {
		return Promise.resolve({ ok: false });
	}

	let hostname = "";
	try {
		hostname = new URL(url).hostname;
	} catch {
		return Promise.resolve({ ok: false });
	}

	return browser.storage.local.get(null).then(result => {
		const existing = migrateSitesFromStorage(result);
		if (!findMatchingSiteConfig(existing, hostname)) {
			return { ok: false };
		}
		const next = toggleSiteLookShortcut(existing, url, title, styleId);
		return persistSites(next).then(() => ({ ok: true }));
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
	if (changeInfo.status === "complete" && tab && tab.active) {
		syncRevealHiddenMenuForTab(tabId);
	}
});

browser.contextMenus.onClicked.addListener((info, tab) => {
	if (!info) return;

	if (info.menuItemId === OPEN_OPTIONS_MENU_ID) {
		browser.runtime.openOptionsPage().catch(onError);
		return;
	}

	resolveContextMenuTab(tab).then(resolvedTab => {
		if (!resolvedTab) return;
		handleContextMenuClick(info, resolvedTab);
	}).catch(onError);
});

function handleContextMenuClick(info, tab) {
	if (info.menuItemId === "selectTargetClasses") {
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
		const selection = (info.selectionText || "").trim();
		if (!selection) return;
		const styleId = info.menuItemId.slice(TEXT_RULE_MENU_PREFIX.length);
		let site = "";
		try { site = normalizeSite(new URL(tab.url).hostname); }
		catch (e) { site = tab.url || ""; }

		addSelectionAsTextRule(selection, site, styleId).catch(onError);
		return;
	}

	if (typeof info.menuItemId !== "string") return;

	let url = null;
	let title = null;
	let styleId = null;

	if (info.menuItemId.startsWith(RULE_LINK_MENU_PREFIX)) {
		url = info.linkUrl;
		if (!url) return;
		styleId = info.menuItemId.slice(RULE_LINK_MENU_PREFIX.length);
		title = info.linkText || url;
	} else if (info.menuItemId.startsWith(RULE_PAGE_MENU_PREFIX)) {
		url = tab.url;
		if (!url || !/^https?:/i.test(url)) return;
		styleId = info.menuItemId.slice(RULE_PAGE_MENU_PREFIX.length);
		title = tab.title || url;
	} else {
		return;
	}

	ensureSettingsReady()
		.then(() => addUrlToSiteList(url, title, styleId))
		.catch(onError);
}

function notifyAllTabsRefresh(mode = "optimistic") {
	return browser.tabs.query({}).then(tabs => {
		for (const t of tabs) {
			browser.tabs.sendMessage(t.id, { refresh: true, mode }).catch(() => {});
		}
	}).catch(() => {});
}

let configRefreshNotifyTimer = null;

function scheduleConfigTabsRefresh() {
	if (configRefreshNotifyTimer) {
		clearTimeout(configRefreshNotifyTimer);
	}
	configRefreshNotifyTimer = setTimeout(() => {
		configRefreshNotifyTimer = null;
		notifyAllTabsRefresh("authoritative");
	}, 75);
}

const CONFIG_REFRESH_STORAGE_KEY_SET = new Set(CONFIG_REFRESH_STORAGE_KEYS);

browser.storage.onChanged.addListener((changes, areaName) => {
	if (areaName !== "local") return;

	let shouldRefreshTabs = false;
	let shouldRefreshMenus = false;

	if (changes[STORAGE_KEYS.sites]) {
		sites = migrateSitesFromStorage({
			sites: changes[STORAGE_KEYS.sites].newValue
		});
		rebuildLinkLookup();
		shouldRefreshTabs = true;
	}

	if (changes[STORAGE_KEYS.styleRules]) {
		styleRules = migrateStyleRulesFromStorage({
			styleRules: changes[STORAGE_KEYS.styleRules].newValue
		});
		shouldRefreshTabs = true;
		shouldRefreshMenus = true;
	}

	for (const key of Object.keys(changes)) {
		if (CONFIG_REFRESH_STORAGE_KEY_SET.has(key)) {
			shouldRefreshTabs = true;
			break;
		}
	}

	if (shouldRefreshMenus) {
		scheduleDeferredDynamicMenus();
	}

	if (shouldRefreshTabs) {
		scheduleConfigTabsRefresh();
	}
});

function invalidateLinkCaches() {
	urlNormalizationCache.clear();
	rebuildLinkLookup();
}

function lookupLinkStyle(href) {
	if (!href) return null;
	const normalized = normalizeHrefForSearch(href);
	let hostname = "";
	try {
		hostname = new URL(normalized).hostname;
	} catch {
		try {
			hostname = new URL(href).hostname;
		} catch {
			return null;
		}
	}

	const siteConfig = findMatchingSiteConfig(sites, hostname);
	if (!siteConfig) return null;
	return linkLookupBySite.get(siteConfig.site)?.get(normalized) || null;
}

function searchhrefs(hrefs) {
	const statuses = {};
	for (const href of hrefs || []) {
		if (!href || !isValidHttpUrl(href)) continue;
		const normalized = normalizeHrefForSearch(href);
		statuses[normalized] = lookupLinkStyle(href) || "none";
	}
	return Promise.resolve({ statuses });
}

browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
	if (changeInfo.status === "complete" || changeInfo.url) {
		sendTabMessage(tabId, { refresh: true, mode: "requery" }).catch(() => {});
	}
});
