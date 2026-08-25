/* Background message router, tab refresh, context menus, and class picker.
 * Link-index state and lookups live in backgroundLinks.js (loaded first).
 */

const CONTENT_SCRIPT_FILES = [
	"browser-polyfill.js",
	"utils.js",
	"contentScript.js",
	"contentToasts.js",
	"contentDuplicates.js",
	"lookShortcuts.js"
];

const CLASS_PICKER_SITE_UTILS_FILES = ["utilsSites.js", "utilsSitesPicker.js"];

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
				sendResponse(idlePageRunState());
			});
		return true;
	}

	if (message && message.getLookShortcutState) {
		const url = message.url || (sender && sender.tab && sender.tab.url) || "";
		ensureSettingsReady()
			.then(() => ensureHostLinksReadyForUrl(url))
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
			.then(() => ensureHostLinksReadyForUrl(url))
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
			.then(() => message.allSites
				? ensureAllHostLinksReady()
				: ensureHostLinksReady(message.host)
			)
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

	if (message && message.matchDuplicateListingTitles) {
		const candidates = Array.isArray(message.candidates) ? message.candidates : [];
		ensureSettingsReady()
			.then(() => ensureHostLinksReadyForHrefs(
				candidates.map(candidate => candidate && candidate.href).filter(Boolean)
			))
			.then(() => sendResponse(matchDuplicateListingTitles(candidates)))
			.catch(error => {
				onError(error);
				sendResponse({
					ok: false,
					hrefs: [],
					error: String(error && error.message ? error.message : error)
				});
			});
		return true;
	}

	if (message && message.matchDuplicatePageTitle) {
		const url = message.url || (sender && sender.tab && sender.tab.url) || "";
		const title = message.title || (sender && sender.tab && sender.tab.title) || "";
		ensureSettingsReady()
			.then(() => ensureHostLinksReadyForUrl(url))
			.then(() => sendResponse(matchDuplicatePageTitle(url, title)))
			.catch(error => {
				onError(error);
				sendResponse({
					ok: false,
					matches: [],
					error: String(error && error.message ? error.message : error)
				});
			});
		return true;
	}

	if (message && message.hrefs) {
		ensureSettingsReady()
			.then(() => ensureHostLinksReadyForHrefs(message.hrefs))
			.then(() => searchhrefs(message.hrefs))
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

	return Promise.all(menuDefinitions.map(definition =>
		Promise.resolve(browser.contextMenus.create(definition)).catch(error => {
			console.error("Context menu creation failed", error);
		})
	));
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

function installContextMenus() {
	listStyleMenuIds = [];
	textRuleMenuIds = [];
	return Promise.resolve(browser.contextMenus.removeAll())
		.catch(() => {})
		.then(() => createStaticContextMenus())
		.then(() => Promise.all([
			refreshTextRuleContextMenus(),
			refreshSavedListContextMenus()
		]));
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

browser.runtime.onInstalled.addListener(() => {
	installContextMenus().catch(onError);
});

browser.tabs.query({ currentWindow: true, active: true })
	.then(tabs => {
		if (!tabs[0]) return;
		syncRevealHiddenMenuForTab(tabs[0].id);
		prefetchHostLinksForUrl(tabs[0].url);
	})
	.catch(() => {});

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
			files: CLASS_PICKER_SITE_UTILS_FILES
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
	prefetchHostLinksForTab(tabId);
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
		isSiteLinksStorageKey(key) ||
		isSiteLinksDeltaStorageKey(key)
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
			const nextLinks = {};
			for (const siteConfig of sites) {
				if (siteConfig?.site && hostsLoaded.has(siteConfig.site)) {
					nextLinks[siteConfig.site] = siteConfig.links || [];
				}
			}
			const changedHosts = new Set();
			const blobChangedHosts = new Set();
			const nextDeltas = {};
			if (changes[STORAGE_KEYS.siteLinks] &&
				changes[STORAGE_KEYS.siteLinks].newValue &&
				typeof changes[STORAGE_KEYS.siteLinks].newValue === "object" &&
				!Array.isArray(changes[STORAGE_KEYS.siteLinks].newValue)
			) {
				Object.assign(nextLinks, changes[STORAGE_KEYS.siteLinks].newValue);
				for (const host of Object.keys(changes[STORAGE_KEYS.siteLinks].newValue)) {
					if (host) {
						changedHosts.add(host);
						blobChangedHosts.add(host);
					}
				}
			}
			for (const [key, change] of Object.entries(changes)) {
				const host = hostFromSiteLinksStorageKey(key);
				if (host) {
					nextLinks[host] = Array.isArray(change.newValue) ? change.newValue : [];
					changedHosts.add(host);
					blobChangedHosts.add(host);
					continue;
				}
				const deltaHost = hostFromSiteLinksDeltaStorageKey(key);
				if (!deltaHost) continue;
				changedHosts.add(deltaHost);
				nextDeltas[deltaHost] = change.newValue;
				siteLinksDeltasByHost.set(
					deltaHost,
					change.newValue == null
						? emptySiteLinksDelta()
						: normalizeSiteLinksDelta(change.newValue)
				);
			}
			for (const host of blobChangedHosts) {
				if (!Object.prototype.hasOwnProperty.call(nextDeltas, host)) {
					siteLinksDeltasByHost.set(host, emptySiteLinksDelta());
				}
			}
			const storageResult = storageResultFromSitesAndLinks(nextMeta, nextLinks);
			for (const [host, value] of Object.entries(nextDeltas)) {
				const deltaKey = siteLinksDeltaStorageKey(host);
				if (deltaKey && value != null) storageResult[deltaKey] = value;
			}
			const loadedSites = loadSitesFromStorageResult(
				storageResult,
				{ preserveLinks: true }
			);
			const nextLoaded = new Set();
			for (const siteConfig of loadedSites) {
				if (!siteConfig?.site) continue;
				if (hostsLoaded.has(siteConfig.site) || changedHosts.has(siteConfig.site)) {
					nextLoaded.add(siteConfig.site);
				}
			}
			hostsLoaded = nextLoaded;
			applyLoadedSites(loadedSites, styleRules);
			if (changes[STORAGE_KEYS.sites]) {
				shouldRefreshTabs = true;
			}
		}
	}

	if (changes[STORAGE_KEYS.styleRules]) {
		styleRules = migrateStyleRulesFromStorage({
			styleRules: changes[STORAGE_KEYS.styleRules].newValue
		});
		rebuildStyleRuleIndex();
		shouldRefreshTabs = true;
		shouldRefreshMenus = true;
	}

	if (Object.prototype.hasOwnProperty.call(changes, STORAGE_KEYS.enableDuplicateWarning)) {
		applyDuplicateWarningSetting(changes[STORAGE_KEYS.enableDuplicateWarning].newValue);
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

browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
	if (changeInfo.status !== "complete" && !changeInfo.url) return;
	const url = (tab && tab.url) || changeInfo.url || "";
	ensureSettingsReady()
		.then(() => {
			if (!getPageRunState(url).runStyling) return;
			prefetchHostLinksForUrl(url);
			return sendTabMessage(tabId, { refresh: true, mode: "requery" });
		})
		.catch(() => {});
});
