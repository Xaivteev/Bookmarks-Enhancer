const INDEX_BUILD_TIMEOUT_MS = 45000;
const SETTINGS_LOAD_TIMEOUT_MS = 15000;
const MAX_STATUS_FILL_RETRIES = 8;
const CONTENT_SCRIPT_FILES = ["browser-polyfill.js", "utils.js", "contentScript.js"];

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
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
	sendRefreshToActiveTab("authoritative");
});

function sendRefreshToActiveTab(mode) {
	return browser.tabs.query({
		currentWindow: true,
		active: true
	}).then(tabs => {
		if (tabs.length > 0) {
			return refreshTabStyling(tabs[0].id, mode);
		}
		return undefined;
	}).catch(onError);
}

function refreshTabStyling(tabId, mode = "authoritative") {
	if (tabId == null) return Promise.resolve();

	// Icon/menu refresh is the recovery path when the SW index is stuck.
	recoverHungBookmarkIndex(true);

	const payload = { refresh: true, mode };
	return browser.tabs.sendMessage(tabId, payload)
		.catch(() => ensureContentScripts(tabId).then(() => browser.tabs.sendMessage(tabId, payload)))
		.catch(onError);
}

function ensureContentScripts(tabId) {
	return browser.scripting.executeScript({
		target: { tabId },
		files: CONTENT_SCRIPT_FILES
	});
}

function onError(error) {
	console.log(`Error: ${error}`);
}

function withTimeout(promise, ms, message) {
	let timeoutId = null;
	const timeoutPromise = new Promise((_, reject) => {
		timeoutId = setTimeout(() => {
			reject(new Error(message || `Timed out after ${ms}ms`));
		}, ms);
	});

	return Promise.race([promise, timeoutPromise]).finally(() => {
		if (timeoutId) clearTimeout(timeoutId);
	});
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
		settingsReady = withTimeout(
			loadSettings().then(() => restoreStatusCacheFromSession()),
			SETTINGS_LOAD_TIMEOUT_MS,
			"Settings load timed out"
		).catch(error => {
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

ensureSettingsReady().catch(onError);

const SESSION_STATUS_CACHE_KEY = "beBookmarkStatusCache";

const RULE_LINK_MENU_PREFIX = "addLinkToRuleFolder:";
const RULE_PAGE_MENU_PREFIX = "addPageToRuleFolder:";
const RULE_LINK_MENU_PARENT = "addLinkToRuleFolderParent";
const RULE_PAGE_MENU_PARENT = "addPageToRuleFolderParent";
const TEXT_RULE_MENU_PARENT = "addTextRuleParent";
const TEXT_RULE_MENU_PREFIX = "addTextRuleStyle:";
const REFRESH_TAB_STYLING_MENU_ID = "refreshTabStyling";
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
			id: REFRESH_TAB_STYLING_MENU_ID,
			title: 'Refresh styling on this tab',
			contexts: ['page', 'action']
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

function startClassPickerOnTab(tabId) {
	if (tabId == null) return Promise.resolve();

	const start = () => browser.tabs.sendMessage(tabId, { startClassPicker: true });

	return browser.scripting.executeScript({
		target: { tabId },
		files: ["classPicker.js"]
	})
		.then(start)
		.catch(error => {
			// Picker may already be running from a prior inject; try messaging directly.
			return start().catch(() => {
				onError(error);
			});
		});
}

browser.contextMenus.onClicked.addListener((info, tab) => {
	if (!info || !tab) return;

	if (info.menuItemId === 'selectTargetClasses') {
		startClassPickerOnTab(tab.id);
		return;
	}

	if (info.menuItemId === REFRESH_TAB_STYLING_MENU_ID) {
		refreshTabStyling(tab.id, "authoritative");
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
		.then(() => {
			invalidateBookmarkCaches();
			notifyAllTabsRefresh();
		})
		.catch(onError);
});

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

let bookmarkStatusMap = new Map(); // href -> status string
let tabHrefSets = new Map(); // tabId -> Set of normalized hrefs seen from that tab
let bookmarkIndexPromise = null;
let liveBookmarkIndex = null;
let bookmarkCacheGeneration = 0;
let bookmarkIndexBuildId = 0;
let bookmarkIndexStartedAt = 0;
let bookmarkIndexBuilding = false;
let persistStatusCacheTimer = null;

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
		if (!cached.statuses || typeof cached.statuses !== "object") return;

		bookmarkStatusMap = new Map(Object.entries(cached.statuses));
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
		browser.storage.session.set({
			[SESSION_STATUS_CACHE_KEY]: {
				fingerprint: getStatusCacheFingerprint(),
				statuses: Object.fromEntries(bookmarkStatusMap)
			}
		}).catch(() => {});
	}, 400);
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

function clearStatusesForTab(tabId) {
	const hrefSet = tabHrefSets.get(tabId);
	if (!hrefSet) return;

	for (const href of hrefSet) {
		bookmarkStatusMap.delete(href);
	}
	tabHrefSets.delete(tabId);
	schedulePersistStatusCache();
}

function searchhrefs(hrefs, tabId = null, options = {}) {
	// contentScript asks if links have been bookmarked
	// Normalize once; retries reuse validHrefs instead of re-entering searchhrefs.
	const normalizedHrefs = hrefs.map(normalizeHrefForSearch);
	const validHrefs = normalizedHrefs.filter(isValidBookmarkUrl);
	rememberTabHrefs(tabId, validHrefs);

	// Hard refresh must bypass in-memory/session status hits and re-resolve.
	if (options && options.authoritative) {
		clearStatusesForUrls(validHrefs);
	}

	return fillBookmarkStatuses(validHrefs);
}

function fillBookmarkStatuses(validHrefs, retryCount = 0) {
	const hrefsToSearch = validHrefs.filter(href => !bookmarkStatusMap.has(href));
	if (hrefsToSearch.length === 0) {
		return Promise.resolve(buildStatusResponse(validHrefs));
	}

	// getBookmarkIndex() chains through stale builds once for all waiters.
	// Only re-run status fills if the cache generation moved after the index settled.
	return getBookmarkIndex().then(index => {
		if (index.generation !== bookmarkCacheGeneration) {
			if (retryCount >= MAX_STATUS_FILL_RETRIES) {
				throw new Error("Bookmark status lookup aborted after repeated cache invalidation");
			}
			return fillBookmarkStatuses(validHrefs, retryCount + 1);
		}

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

			if (
				status === "none" &&
				index.unmatchedBookmarkStyle &&
				bookmarkList.length > 0 &&
				index.styleIds.has(index.unmatchedBookmarkStyle)
			) {
				status = index.unmatchedBookmarkStyle;
			}

			bookmarkStatusMap.set(href, status);
		}

		if (index.generation !== bookmarkCacheGeneration) {
			// invalidateBookmarkCaches() replaced the status map; retry against the new generation.
			if (retryCount >= MAX_STATUS_FILL_RETRIES) {
				throw new Error("Bookmark status lookup aborted after repeated cache invalidation");
			}
			return fillBookmarkStatuses(validHrefs, retryCount + 1);
		}

		schedulePersistStatusCache();
		return buildStatusResponse(validHrefs);
	});
}

function buildStatusResponse(requestedHrefs) {
	const statuses = {};

	for (const href of new Set(requestedHrefs)) {
		const status = bookmarkStatusMap.get(href);
		if (!status) continue;

		statuses[href] = status;
	}

	return { statuses };
}

function getBookmarkIndex() {
	if (liveBookmarkIndex && liveBookmarkIndex.generation === bookmarkCacheGeneration) {
		return Promise.resolve(liveBookmarkIndex);
	}

	// If a prior build exceeded the timeout but somehow remained pending, drop it
	// so page reloads can recover without waiting on the dead promise.
	recoverHungBookmarkIndex(false);

	if (!bookmarkIndexPromise) {
		const generationAtStart = bookmarkCacheGeneration;
		const buildId = ++bookmarkIndexBuildId;
		bookmarkIndexStartedAt = Date.now();
		bookmarkIndexBuilding = true;
		const buildPromise = withTimeout(
			buildBookmarkIndex(),
			INDEX_BUILD_TIMEOUT_MS,
			"Bookmark index build timed out"
		)
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
	// healthy icon clicks reuse liveBookmarkIndex instead of rebuilding getTree.
	if (!bookmarkIndexBuilding) return;

	const aged = bookmarkIndexStartedAt > 0 &&
		(Date.now() - bookmarkIndexStartedAt > INDEX_BUILD_TIMEOUT_MS);

	// Force (toolbar/menu refresh) abandons a pending build immediately; otherwise
	// only abandon builds that have already exceeded the timeout window.
	if (force || aged) {
		bookmarkIndexBuildId += 1;
		bookmarkIndexPromise = null;
		bookmarkIndexStartedAt = 0;
		bookmarkIndexBuilding = false;
		liveBookmarkIndex = null;
	}
}

function indexesUnmatchedBookmarks(styleIds) {
	return !!(unmatchedBookmarkStyle && styleIds.has(unmatchedBookmarkStyle));
}

function buildBookmarkIndex() {
	const styleIds = new Set((styleRules || []).map(rule => rule.id));
	const shouldIndexUnmatched = indexesUnmatchedBookmarks(styleIds);

	return resolveConfiguredRules(bookmarkRules).then(rules => {
		if (shouldIndexUnmatched) {
			return browser.bookmarks.getTree().then(bookmarkTree => {
				const maps = buildBookmarkMaps(bookmarkTree);
				return {
					rules,
					unmatchedBookmarkStyle,
					styleIds,
					indexesUnmatched: true,
					...maps
				};
			});
		}

		// None for unmatched: only index bookmarks under configured rule folders.
		if (rules.length === 0) {
			return {
				rules,
				unmatchedBookmarkStyle: "",
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
				unmatchedBookmarkStyle: "",
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
	tabHrefSets = new Map();
	bookmarkIndexPromise = null;
	liveBookmarkIndex = null;
	bookmarkIndexBuilding = false;
	bookmarkIndexStartedAt = 0;
	clearSessionStatusCache();
}

function clearStatusesForUrls(urls) {
	for (const url of urls || []) {
		if (!url) continue;
		bookmarkStatusMap.delete(url);
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
	if (index.indexesUnmatched) return true;
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
		return affected;
	}

	const normalized = normalizeHrefForSearch(node.url);
	index.urlByBookmarkId.set(node.id, normalized);
	if (!index.bookmarksByNormalizedUrl.has(normalized)) {
		index.bookmarksByNormalizedUrl.set(normalized, []);
	}
	const list = index.bookmarksByNormalizedUrl.get(normalized);
	if (!list.some(existing => existing.id === node.id)) {
		list.push(node);
	}
	affected.push(normalized);
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
			clearStatusesForUrls(affectedUrls);
			scheduleConfigTabsRefresh();
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

	return withLiveBookmarkIndex(index => removeBookmarkIdFromIndex(index, id));
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
				// Outside the current scoped index: only add if it now qualifies.
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
				affected.push(...removeBookmarkIdFromIndex(index, id));
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
			clearStatusesForUrls(affectedUrls || []);
			scheduleConfigTabsRefresh();
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

function buildBookmarkMaps(bookmarkTree) {
	const bookmarksByNormalizedUrl = new Map();
	const parentById = new Map();
	const bookmarkById = new Map();
	const urlByBookmarkId = new Map();
	addBookmarkTreeToMaps(
		bookmarkTree,
		bookmarksByNormalizedUrl,
		parentById,
		bookmarkById,
		urlByBookmarkId
	);
	return { bookmarksByNormalizedUrl, parentById, bookmarkById, urlByBookmarkId };
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

// Clear only this tab's cached statuses when it navigates or finishes loading.
browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
	if (changeInfo.status === "complete" || changeInfo.url) {
		clearStatusesForTab(tabId);
	}
});

browser.tabs.onRemoved.addListener(tabId => {
	clearStatusesForTab(tabId);
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
