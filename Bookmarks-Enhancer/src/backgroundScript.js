const CONTENT_SCRIPT_FILES = ["browser-polyfill.js", "utils.js", "contentScript.js", "lookShortcuts.js"];

const DEFAULT_ACTION_TITLE = "Bookmarks Enhancer";
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
	Promise.resolve(browser.action.setTitle({ title: "Refreshing looks…" })).catch(() => {});
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

	if (message && message.getPageRunState) {
		const url = message.url || (sender && sender.tab && sender.tab.url) || "";
		ensureSettingsReady()
			.then(() => sendResponse(getPageRunState(url)))
			.catch(error => {
				onError(error);
				sendResponse({
					siteMatch: false,
					runStyling: false,
					runShortcuts: false
				});
			});
		return true;
	}

	if (message && message.getLookShortcutState) {
		const url = message.url || (sender && sender.tab && sender.tab.url) || "";
		ensureSettingsReady()
			.then(() => sendResponse(getLookShortcutState(url)))
			.catch(error => {
				onError(error);
				sendResponse({ ok: false, styleId: "", url });
			});
		return true;
	}

	if (message && message.toggleLookShortcut) {
		const styleId = typeof message.styleId === "string" ? message.styleId : "";
		const url = message.url || (sender && sender.tab && sender.tab.url) || "";
		const title = message.title || (sender && sender.tab && sender.tab.title) || "";
		const tabId = sender && sender.tab ? sender.tab.id : null;
		ensureSettingsReady()
			.then(() => toggleLookShortcut(url, title, styleId, tabId))
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

	if (message && message.getActionPopupState) {
		getActionPopupState()
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

	if (message && message.actionPopupRefreshTab) {
		refreshTabStyling(message.tabId, "authoritative", { showActionBusy: true })
			.then(() => sendResponse({ ok: true }))
			.catch(error => {
				onError(error);
				sendResponse({
					ok: false,
					error: String(error && error.message ? error.message : error)
				});
			});
		return true;
	}

	if (message && message.actionPopupSetRevealHidden) {
		setRevealHiddenOnTab(message.tabId, !!message.enabled)
			.then(revealed => sendResponse({ ok: true, revealHidden: revealed }))
			.catch(error => {
				onError(error);
				sendResponse({
					ok: false,
					revealHidden: false,
					error: String(error && error.message ? error.message : error)
				});
			});
		return true;
	}

	if (message && message.actionPopupStartClassPicker) {
		startClassPickerOnTab(message.tabId)
			.then(() => sendResponse({ ok: true }))
			.catch(error => {
				onError(error);
				sendResponse({
					ok: false,
					error: String(error && error.message ? error.message : error)
				});
			});
		return true;
	}

	if (message && message.actionPopupOpenSettings) {
		openOptionsForPage(message.url)
			.then(() => sendResponse({ ok: true }))
			.catch(error => {
				onError(error);
				sendResponse({
					ok: false,
					error: String(error && error.message ? error.message : error)
				});
			});
		return true;
	}

	if (message && message.actionPopupSearchLinks) {
		ensureSettingsReady()
			.then(() => sendResponse(searchActionPopupLinks(message)))
			.catch(error => {
				onError(error);
				sendResponse({
					ok: false,
					query: "",
					matches: [],
					total: 0,
					truncated: false,
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

function setRevealHiddenOnTab(tabId, enabled) {
	if (tabId == null) {
		return updateRevealHiddenMenuTitle(false).then(() => false);
	}

	return sendTabMessage(tabId, { setRevealHidden: !!enabled })
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
let siteHostIndex = new Map();
const urlNormalizationCache = createUrlNormalizationCache();

let settingsReady = null;
let settingsLoadGeneration = 0;
let pendingIgnoredSiteWrites = 0;
let persistSiteLinksTimer = null;
let persistSiteLinksHosts = new Set();

function lookupEntryStyle(entry) {
	if (!entry) return null;
	return typeof entry === "string" ? entry : (entry.style || null);
}

function matchingSiteConfig(hostname) {
	return findSiteConfigInHostIndex(siteHostIndex, hostname);
}

function rebuildSiteHostIndex() {
	siteHostIndex = buildSiteHostIndex(sites);
}

function rebuildLinkLookup() {
	urlRules = sitesToUrlRules(sites);
	urlNormalizationCache.clear();
	rebuildSiteHostIndex();
	linkLookupBySite = new Map();

	for (const siteConfig of sites) {
		const map = new Map();
		for (const link of siteConfig.links || []) {
			if (!link?.url) continue;
			const key = hrefMatchKey(link.url);
			if (!key || map.has(key)) continue;
			map.set(key, link);
		}
		linkLookupBySite.set(siteConfig.site, map);
	}
}

function applyLoadedSites(nextSites, nextStyleRules, { rebuild = true } = {}) {
	sites = Array.isArray(nextSites) ? nextSites : [];
	styleRules = Array.isArray(nextStyleRules)
		? nextStyleRules
		: DEFAULT_STYLE_RULES.map(rule => ({ ...rule }));
	if (rebuild) rebuildLinkLookup();
	else rebuildSiteHostIndex();
}

function maybeSplitStoredSiteLinks(result, loadedSites) {
	const hasBlob = result &&
		result[STORAGE_KEYS.siteLinks] &&
		typeof result[STORAGE_KEYS.siteLinks] === "object" &&
		!Array.isArray(result[STORAGE_KEYS.siteLinks]);
	const embedded = sitesHaveEmbeddedLinks(result.sites);
	if (!hasBlob && !embedded) {
		return Promise.resolve(loadedSites);
	}

	pendingIgnoredSiteWrites += 1;
	const previousHosts = [...siteLinkHostsFromStorageResult(result)];
	const plan = buildSitesStoragePlan(loadedSites, { previousHosts });
	if (plan.removeKeys.some(Boolean)) pendingIgnoredSiteWrites += 1;
	return persistSitesStoragePlan(plan)
		.catch(error => {
			pendingIgnoredSiteWrites = Math.max(0, pendingIgnoredSiteWrites - 1);
			throw error;
		})
		.then(() => {
			scheduleConfigTabsRefresh();
			return loadedSites;
		});
}

function loadSettings() {
	return browser.storage.local.get(null).then(result => {
		styleRules = migrateStyleRulesFromStorage(result);
		return purgeLegacyStorage(result).then(migratedSites => {
			applyLoadedSites(migratedSites, styleRules);
			return maybeSplitStoredSiteLinks(result, migratedSites);
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
			title: "Select target classes",
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

function persistSites(nextSites, { includeLinks = true, rebuild = includeLinks } = {}) {
	const previousHosts = [...siteHostIndex.keys()];
	sites = Array.isArray(nextSites) ? nextSites : sites;
	if (rebuild) rebuildLinkLookup();
	else {
		urlRules = sitesToUrlRules(sites);
		rebuildSiteHostIndex();
	}

	pendingIgnoredSiteWrites += 1;
	const persist = includeLinks
		? (() => {
			const plan = buildSitesStoragePlan(sites, { previousHosts });
			if (plan.removeKeys.some(Boolean)) pendingIgnoredSiteWrites += 1;
			return persistSitesStoragePlan(plan);
		})()
		: browser.storage.local.set({
			[STORAGE_KEYS.sites]: sites.map(siteConfigToStorageMeta).filter(Boolean)
		});
	return persist.then(() => sites).catch(error => {
		pendingIgnoredSiteWrites = Math.max(0, pendingIgnoredSiteWrites - 1);
		throw error;
	});
}

function schedulePersistSiteLinks(host) {
	if (host) persistSiteLinksHosts.add(host);
	if (persistSiteLinksTimer) clearTimeout(persistSiteLinksTimer);
	persistSiteLinksTimer = setTimeout(() => {
		persistSiteLinksTimer = null;
		const hosts = Array.from(persistSiteLinksHosts);
		persistSiteLinksHosts.clear();
		if (hosts.length === 0) return;

		const writes = {};
		for (const nextHost of hosts) {
			Object.assign(writes, buildHostLinksStorageWrite(
				nextHost,
				sites.find(site => site.site === nextHost)?.links
			));
		}
		if (Object.keys(writes).length === 0) return;

		pendingIgnoredSiteWrites += 1;
		browser.storage.local.set(writes).catch(error => {
			pendingIgnoredSiteWrites = Math.max(0, pendingIgnoredSiteWrites - 1);
			onError(error);
		});
	}, 40);
}

function addSelectionAsTextRule(selection, site, styleId) {
	const next = addTextRuleToSites(sites, site, selection, styleId);
	return persistSites(next, { includeLinks: false }).then(saved => {
		scheduleConfigTabsRefresh();
		return saved;
	});
}

function addUrlToSiteList(url, title, styleId) {
	const result = applySavedLinkToMemory(url, title, styleId, { toggleOff: false });
	if (!result.ok) return Promise.resolve(sites);
	notifyTabsHrefStatus(url, result.styleId);
	let host = "";
	try {
		host = matchingSiteConfig(new URL(url).hostname)?.site || "";
	} catch {
		host = "";
	}
	if (!host) return persistSites(sites, { rebuild: false });
	pendingIgnoredSiteWrites += 1;
	return browser.storage.local.set({
		[STORAGE_KEYS.sites]: sites.map(siteConfigToStorageMeta).filter(Boolean),
		...buildHostLinksStorageWrite(
			host,
			sites.find(site => site.site === host)?.links
		)
	}).then(() => sites).catch(error => {
		pendingIgnoredSiteWrites = Math.max(0, pendingIgnoredSiteWrites - 1);
		throw error;
	});
}

function getPageRunState(url) {
	const idle = { siteMatch: false, runStyling: false, runShortcuts: false };
	if (typeof url !== "string" || !/^https?:/i.test(url)) return idle;
	let hostname = "";
	try {
		hostname = new URL(url).hostname;
	} catch {
		return idle;
	}
	const siteMatch = !!matchingSiteConfig(hostname);
	return {
		siteMatch,
		runShortcuts: siteMatch,
		runStyling: siteMatch
	};
}

function emptyActionPopupPageState() {
	return {
		pageReady: false,
		styled: null,
		hidden: null,
		revealHidden: false
	};
}

function collectActionPopupSiteState(url) {
	if (!isValidHttpUrl(url)) {
		return {
			restricted: true,
			host: "",
			siteMatch: false,
			classGroupCount: 0,
			savedLinkCount: 0,
			lookCount: 0
		};
	}

	let host = "";
	try {
		host = normalizeSite(new URL(url).hostname) || "";
	} catch {
		return {
			restricted: true,
			host: "",
			siteMatch: false,
			classGroupCount: 0,
			savedLinkCount: 0,
			lookCount: 0
		};
	}

	const siteConfig = host ? matchingSiteConfig(host) : null;
	return {
		restricted: false,
		host: siteConfig ? siteConfig.site : host,
		siteMatch: !!siteConfig,
		classGroupCount: siteConfig ? (siteConfig.classGroups || []).length : 0,
		savedLinkCount: siteConfig ? (siteConfig.links || []).length : 0,
		lookCount: siteConfig ? (siteConfig.linkFolders || []).length : 0
	};
}

function getActionPopupState() {
	return browser.tabs.query({ currentWindow: true, active: true }).then(tabs => {
		const tab = tabs[0];
		if (!tab) return { ok: false };

		return ensureSettingsReady().then(() => {
			const siteState = collectActionPopupSiteState(tab.url || "");
			const base = {
				ok: true,
				tabId: tab.id,
				url: tab.url || "",
				...siteState,
				...emptyActionPopupPageState()
			};
			if (tab.id == null || siteState.restricted) {
				return base;
			}

			return sendTabMessage(tab.id, { getActionPopupPageState: true })
				.then(pageState => ({
					...base,
					pageReady: !!(pageState && pageState.pageReady),
					styled: typeof pageState?.styled === "number" ? pageState.styled : null,
					hidden: typeof pageState?.hidden === "number" ? pageState.hidden : null,
					revealHidden: !!(pageState && pageState.revealHidden)
				}))
				.catch(() => base);
		});
	});
}

const ACTION_POPUP_SEARCH_LIMIT = 40;

function getStyleRuleName(styleId) {
	const id = typeof styleId === "string" ? styleId.trim() : "";
	const rule = (styleRules || []).find(entry => entry.id === id);
	if (rule && rule.name) return rule.name;
	return id;
}

function searchActionPopupLinks(options = {}) {
	const query = String(options.query || "").trim().toLowerCase();
	const searchTitles = options.searchTitles !== false;
	const searchUrls = options.searchUrls !== false;
	const allSites = !!options.allSites;
	const host = normalizeSite(options.host) || String(options.host || "").trim();

	if (!query) {
		return { ok: true, query: "", matches: [], total: 0, truncated: false };
	}
	if (!searchTitles && !searchUrls) {
		return { ok: true, query, matches: [], total: 0, truncated: false };
	}

	let siteList = [];
	if (allSites) {
		siteList = Array.isArray(sites) ? sites : [];
	} else if (host) {
		const match = matchingSiteConfig(host);
		siteList = match ? [match] : [];
	}

	const matches = [];
	let total = 0;
	for (const siteConfig of siteList) {
		const site = siteConfig?.site || "";
		for (const link of siteConfig.links || []) {
			const title = typeof link?.title === "string" ? link.title : "";
			const url = typeof link?.url === "string" ? link.url : "";
			if (!title && !url) continue;
			const titleHit = searchTitles && title.toLowerCase().includes(query);
			const urlHit = searchUrls && url.toLowerCase().includes(query);
			if (!titleHit && !urlHit) continue;
			total += 1;
			if (matches.length >= ACTION_POPUP_SEARCH_LIMIT) continue;
			matches.push({
				title,
				url,
				site,
				look: getStyleRuleName(link.style),
				styleId: typeof link.style === "string" ? link.style : ""
			});
		}
	}

	return {
		ok: true,
		query,
		matches,
		total,
		truncated: total > matches.length
	};
}

function getLookShortcutState(url) {
	if (!isValidHttpUrl(url)) {
		return { ok: false, url, styleId: "", site: "" };
	}
	let hostname = "";
	try {
		hostname = new URL(url).hostname;
	} catch {
		return { ok: false, url, styleId: "", site: "" };
	}
	const siteConfig = matchingSiteConfig(hostname);
	return {
		ok: !!siteConfig,
		url,
		styleId: siteConfig
			? (lookupLinkStyleForSite(normalizeHrefForSearch(url), siteConfig) || "")
			: "",
		site: siteConfig ? siteConfig.site : ""
	};
}

function applySavedLinkToMemory(url, title, styleId, { toggleOff = false } = {}) {
	if (!isValidHttpUrl(url) || !styleId) {
		return { ok: false, styleId: "" };
	}

	let hostname = "";
	try {
		hostname = new URL(url).hostname;
	} catch {
		return { ok: false, styleId: "" };
	}

	let siteConfig = matchingSiteConfig(hostname);
	if (!siteConfig) {
		if (toggleOff) return { ok: false, styleId: "" };
		const ensured = ensureSiteConfig(sites, hostname);
		sites = ensured.sites;
		siteConfig = ensured.siteConfig;
		if (!siteConfig) return { ok: false, styleId: "" };
		siteHostIndex.set(siteConfig.site, siteConfig);
	}
	if (!Array.isArray(siteConfig.links)) siteConfig.links = [];

	const pageKey = hrefMatchKey(url);
	if (!pageKey) return { ok: false, styleId: "" };

	let map = linkLookupBySite.get(siteConfig.site);
	if (!map) {
		map = new Map();
		linkLookupBySite.set(siteConfig.site, map);
	}

	const existing = map.get(pageKey);
	if (toggleOff && existing && lookupEntryStyle(existing) === styleId) {
		const idx = siteConfig.links.indexOf(existing);
		if (idx >= 0) siteConfig.links.splice(idx, 1);
		map.delete(pageKey);
		return { ok: true, styleId: "" };
	}

	const savedTitle = normalizeSavedLinkTitle(title);
	if (existing && typeof existing === "object") {
		existing.style = styleId;
		if (savedTitle) existing.title = savedTitle;
		siteConfig.linkFolders = addLinkFolderId(siteConfig.linkFolders, styleId);
		map.set(pageKey, existing);
		return { ok: true, styleId };
	}

	const saved = {
		url: normalizeHrefForSearch(url),
		title: savedTitle,
		style: styleId
	};
	siteConfig.links.push(saved);
	siteConfig.linkFolders = addLinkFolderId(siteConfig.linkFolders, styleId);
	map.set(pageKey, saved);
	return { ok: true, styleId };
}

function toggleLookShortcut(url, title, styleId, senderTabId) {
	if (!isValidHttpUrl(url) || !styleId) {
		return { ok: false };
	}
	if (!styleRules.some(rule => rule.id === styleId && rule.shortcutIcon)) {
		return { ok: false };
	}

	let hostname = "";
	try {
		hostname = new URL(url).hostname;
	} catch {
		return { ok: false };
	}

	const siteConfig = matchingSiteConfig(hostname);
	if (!siteConfig) {
		return { ok: false };
	}

	const result = applySavedLinkToMemory(url, title, styleId, { toggleOff: true });
	if (result.ok) {
		notifyTabsHrefStatus(url, result.styleId, senderTabId);
		schedulePersistSiteLinks(siteConfig.site);
	}
	return result;
}

function notifyTabsHrefStatus(url, styleId, senderTabId) {
	let hostname = "";
	try {
		hostname = new URL(url).hostname;
	} catch {
		return;
	}
	const normalized = normalizeHrefForSearch(url);
	const status = styleId || "none";
	browser.tabs.query({}).then(tabs => {
		for (const tab of tabs) {
			if (!tab?.id || !tab.url) continue;
			let tabHost = "";
			try {
				tabHost = new URL(tab.url).hostname;
			} catch {
				continue;
			}
			if (!hostnameMatchesSite(tabHost, hostname) &&
				!hostnameMatchesSite(hostname, tabHost)) {
				continue;
			}
			const payload = {
				statusUpdates: { [normalized]: status }
			};
			if (senderTabId && tab.id === senderTabId) {
				payload.lookShortcutState = { url, styleId: styleId || "" };
			}
			browser.tabs.sendMessage(tab.id, payload).catch(() => {});
		}
	}).catch(() => {});
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

	const injectSitesUtils = () => browser.scripting.executeScript({
		target: { tabId },
		func: () => typeof mergeClassGroupIntoSites === "function"
	}).then(results => {
		throwIfScriptInjectionFailed(results, "check site utils");
		if (results[0] && results[0].result) return results;
		return browser.scripting.executeScript({
			target: { tabId },
			files: ["utilsSites.js"]
		}).then(injected => throwIfScriptInjectionFailed(injected, "inject site utils"));
	});

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
		.then(injectSitesUtils)
		.then(injectPicker)
		.then(startPicker)
		.catch(error => {
			return injectSitesUtils()
				.then(startPicker)
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

function optionsHashForPageUrl(pageUrl) {
	try {
		const parsed = new URL(pageUrl);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
			return "#sites";
		}
		const host = normalizeSite(parsed.hostname);
		return host ? `#sites/${encodeURIComponent(host)}` : "#sites";
	} catch {
		return "#sites";
	}
}

function openOptionsForPage(pageUrl) {
	const hash = optionsHashForPageUrl(pageUrl);
	const writeRoute = browser.storage.session
		? browser.storage.session.set({ [OPTIONS_HASH_SESSION_KEY]: hash })
		: Promise.resolve();
	return writeRoute
		.then(() => browser.runtime.openOptionsPage())
		.catch(onError);
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
		resolveContextMenuTab(tab)
			.then(resolvedTab => openOptionsForPage(resolvedTab && resolvedTab.url))
			.catch(onError);
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
		title = titleFromPageContext(info.linkText, tab && tab.title);
	} else if (info.menuItemId.startsWith(RULE_PAGE_MENU_PREFIX)) {
		url = tab.url;
		if (!url || !/^https?:/i.test(url)) return;
		styleId = info.menuItemId.slice(RULE_PAGE_MENU_PREFIX.length);
		title = titleFromPageContext("", tab && tab.title);
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
			browser.tabs.sendMessage(t.id, {
				refresh: true,
				mode,
				reloadConfig: true
			}).catch(() => {});
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

function storageChangeHasSiteData(changes) {
	return Object.keys(changes || {}).some(key =>
		key === STORAGE_KEYS.sites ||
		key === STORAGE_KEYS.siteLinks ||
		isSiteLinksStorageKey(key)
	);
}

browser.storage.onChanged.addListener((changes, areaName) => {
	if (areaName !== "local") return;

	let shouldRefreshTabs = false;
	let shouldRefreshMenus = false;

	if (storageChangeHasSiteData(changes)) {
		if (pendingIgnoredSiteWrites > 0) {
			pendingIgnoredSiteWrites -= 1;
		} else {
			const nextMeta = changes[STORAGE_KEYS.sites]
				? changes[STORAGE_KEYS.sites].newValue
				: sites.map(siteConfigToStorageMeta);
			const nextLinks = siteLinksByHostFromSites(sites);
			if (changes[STORAGE_KEYS.siteLinks] &&
				changes[STORAGE_KEYS.siteLinks].newValue &&
				typeof changes[STORAGE_KEYS.siteLinks].newValue === "object" &&
				!Array.isArray(changes[STORAGE_KEYS.siteLinks].newValue)
			) {
				Object.assign(nextLinks, changes[STORAGE_KEYS.siteLinks].newValue);
			}
			for (const [key, change] of Object.entries(changes)) {
				const host = hostFromSiteLinksStorageKey(key);
				if (!host) continue;
				nextLinks[host] = Array.isArray(change.newValue) ? change.newValue : [];
			}
			applyLoadedSites(
				loadSitesFromStorageResult(
					storageResultFromSitesAndLinks(nextMeta, nextLinks),
					{ preserveLinks: true }
				),
				styleRules
			);
			if (changes[STORAGE_KEYS.sites]) {
				shouldRefreshTabs = true;
			}
		}
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

function lookupLinkStyleForSite(normalizedHref, siteConfig) {
	if (!siteConfig) return null;
	return lookupEntryStyle(
		linkLookupBySite.get(siteConfig.site)?.get(hrefMatchKeyFromNormalized(normalizedHref))
	);
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
	return lookupLinkStyleForSite(normalized, matchingSiteConfig(hostname));
}

function searchhrefs(hrefs) {
	const statuses = {};
	let lastHost = "";
	let lastSite = null;
	let haveLastHost = false;

	for (const href of hrefs || []) {
		if (!href) continue;
		let parsed;
		try {
			parsed = new URL(href);
		} catch {
			continue;
		}
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;

		const normalized = normalizeHrefForSearch(href);
		const host = normalizeSite(parsed.hostname);
		if (!haveLastHost || host !== lastHost) {
			lastHost = host;
			lastSite = findSiteConfigByNormalizedHost(siteHostIndex, host);
			haveLastHost = true;
		}
		statuses[normalized] = lookupLinkStyleForSite(normalized, lastSite) || "none";
	}
	return Promise.resolve({ statuses });
}

browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
	if (changeInfo.status !== "complete" && !changeInfo.url) return;
	const url = (tab && tab.url) || changeInfo.url || "";
	ensureSettingsReady()
		.then(() => {
			if (!getPageRunState(url).runStyling) return;
			return sendTabMessage(tabId, { refresh: true, mode: "requery" });
		})
		.catch(() => {});
});
