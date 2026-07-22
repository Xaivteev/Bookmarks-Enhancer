browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
	if (message && message.hrefs) {
		settingsReady
			.then(() => searchhrefs(message.hrefs))
			.then(sendResponse)
			.catch(error => {
				onError(error);
				sendResponse({ statuses: {} });
			});
		return true;
	}
	return false;
});

// Full refresh when the toolbar icon is clicked
browser.browserAction.onClicked.addListener(() => {
	sendRefreshToActiveTab("authoritative");
});

browser.pageAction.onClicked.addListener(() => {
	sendRefreshToActiveTab("authoritative");
});

function sendRefreshToActiveTab(mode) {
	return browser.tabs.query({
		currentWindow: true,
		active: true
	}).then(tabs => {
		if (tabs.length > 0) {
			return browser.tabs.sendMessage(tabs[0].id, { refresh: true, mode });
		}
		return undefined;
	}).catch(onError);
}

function onError(error) {
	console.log(`Error: ${error}`);
}

// Storage key constants
const STORAGE_KEYS = {
	urlRules: "urlRules",
	textFilters: "textFilters",
	textRules: "textRules",
	styleRules: "styleRules",
	bookmarkRules: "bookmarkRules",
	enableSeenStyling: "enableSeenStyling",
	blockedFolderId: "blockedFolderId",
	favoritedFolderId: "favoritedFolderId"
};

let urlRules = [];
let bookmarkRules = [];
let unmatchedBookmarkStyle = "";
let styleRules = DEFAULT_STYLE_RULES.map(rule => ({ ...rule }));

function loadSettings() {
    return browser.storage.local
        .get([
			STORAGE_KEYS.urlRules,
			STORAGE_KEYS.bookmarkRules,
			STORAGE_KEYS.styleRules,
			STORAGE_KEYS.enableSeenStyling,
			STORAGE_KEYS.blockedFolderId,
			STORAGE_KEYS.favoritedFolderId
		])
        .then(result => {
            urlRules = Array.isArray(result[STORAGE_KEYS.urlRules])
                ? result[STORAGE_KEYS.urlRules]
                : [];
			const migratedRules = migrateBookmarkRulesFromStorage(result);
			bookmarkRules = migratedRules.filter(rule => !isUnmatchedBookmarkRule(rule));
			unmatchedBookmarkStyle = migratedRules.find(isUnmatchedBookmarkRule)?.style || "";
			styleRules = migrateStyleRulesFromStorage(result);
        });
}

const settingsReady = loadSettings().catch(onError);

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

// Create context menu items for selection and links
function createContextMenus() {
	const menuDefinitions = [
		{
			id: 'selectTargetClasses',
			title: 'Select Target Classes',
			contexts: ['page', 'browser_action', 'page_action']
		},
		{
			id: REFRESH_TAB_STYLING_MENU_ID,
			title: 'Refresh styling on this tab',
			contexts: ['page', 'browser_action', 'page_action']
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

	refreshTextRuleContextMenus();
	refreshRuleFolderContextMenus();
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
	return settingsReady.then(() => {
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
	return settingsReady.then(() => {
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

createContextMenus();

function getValidFolderId(folderId) {
	if (!folderId) return Promise.resolve(null);
	return browser.bookmarks.get(folderId).then(nodes => {
		const folder = nodes.find(node => node.type === "folder");
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

const CONFIG_REFRESH_STORAGE_KEYS = new Set([
	STORAGE_KEYS.urlRules,
	STORAGE_KEYS.bookmarkRules,
	STORAGE_KEYS.styleRules,
	STORAGE_KEYS.textRules,
	STORAGE_KEYS.textFilters,
	"searchPairs",
	"enableDeepSearch",
	"onlyUseSites",
	"enableTopBorder"
]);

function addSelectionAsTextRule(selection, site, styleId) {
	const style = styleId || "blocked";
	return browser.storage.local.get([
		STORAGE_KEYS.textRules,
		STORAGE_KEYS.textFilters
	]).then(result => {
		const existing = Array.isArray(result[STORAGE_KEYS.textRules])
			? result[STORAGE_KEYS.textRules].slice()
			: [];

		if (!Array.isArray(result[STORAGE_KEYS.textRules]) && Array.isArray(result[STORAGE_KEYS.textFilters])) {
			for (const filter of result[STORAGE_KEYS.textFilters]) {
				if (!filter || typeof filter.filterText !== "string") continue;
				const legacySite = typeof filter.site === "string" ? filter.site : "";
				const texts = filter.filterText.split(',').map(text => text.trim()).filter(Boolean);
				for (const text of texts) {
					existing.push({
						site: legacySite,
						text,
						style: "blocked"
					});
				}
			}
		}

		const alreadyExists = existing.some(rule =>
			(rule.site || "") === site &&
			typeof rule.text === "string" &&
			rule.text.trim().toLowerCase() === selection.toLowerCase() &&
			(rule.style || "blocked") === style
		);
		if (!alreadyExists) {
			existing.push({
				site,
				text: selection,
				style
			});
		}

		return browser.storage.local.set({
			textRules: existing
		}).then(() => browser.storage.local.remove([STORAGE_KEYS.textFilters]));
	});
}

browser.contextMenus.onClicked.addListener((info, tab) => {
	if (!info || !tab) return;

	if (info.menuItemId === 'selectTargetClasses') {
		browser.tabs.sendMessage(tab.id, {
			startClassPicker: true
		}).catch(onError);
		return;
	}

	if (info.menuItemId === REFRESH_TAB_STYLING_MENU_ID) {
		browser.tabs.sendMessage(tab.id, {
			refresh: true,
			mode: "authoritative"
		}).catch(onError);
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
		try { site = normalizeSiteForMatching(new URL(tab.url).hostname); }
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

	settingsReady
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

	if (changes[STORAGE_KEYS.enableSeenStyling]) {
		// Legacy key: keep unmatched style in sync until options are re-saved.
		if (!Array.isArray(changes[STORAGE_KEYS.bookmarkRules]?.newValue)) {
			unmatchedBookmarkStyle = changes[STORAGE_KEYS.enableSeenStyling].newValue === false
				? ""
				: "seen";
			invalidateBookmarkCaches();
			shouldRefreshTabs = true;
		}
	}

	if (
		changes[STORAGE_KEYS.blockedFolderId] ||
		changes[STORAGE_KEYS.favoritedFolderId]
	) {
		browser.storage.local.get([
			STORAGE_KEYS.bookmarkRules,
			STORAGE_KEYS.blockedFolderId,
			STORAGE_KEYS.favoritedFolderId
		]).then(result => {
			if (Array.isArray(result[STORAGE_KEYS.bookmarkRules])) return;
			bookmarkRules = normalizeBookmarkRules(
				migrateBookmarkRulesFromStorage(result)
			).filter(rule => !isUnmatchedBookmarkRule(rule));
			unmatchedBookmarkStyle = migrateUnmatchedBookmarkStyle(result);
			invalidateBookmarkCaches();
			refreshRuleFolderContextMenus();
			scheduleConfigTabsRefresh();
		}).catch(onError);
	}

	for (const key of Object.keys(changes)) {
		if (CONFIG_REFRESH_STORAGE_KEYS.has(key)) {
			shouldRefreshTabs = true;
			break;
		}
	}

	if (shouldRefreshTabs) {
		scheduleConfigTabsRefresh();
	}
});

// Cache for URL normalization to avoid repeated calculations
const urlNormalizationCache = new Map(); // href -> normalized href

let bookmarkStatusMap = new Map(); // href -> status string
let bookmarkIndexPromise = null;
let liveBookmarkIndex = null;
let bookmarkCacheGeneration = 0;

function searchhrefs(hrefs) {
	const requestGeneration = bookmarkCacheGeneration;
	// contentScript asks if links have been bookmarked
	// Normalize hrefs and prepare lookup
	const normalizedHrefs = hrefs.map(normalizeHrefForSearch);

    // Filter out invalid URLs
	const validHrefs = normalizedHrefs.filter(isValidBookmarkUrl);

	// Filter out hrefs that have already been processed
	const hrefsToSearch = validHrefs.filter(href => !bookmarkStatusMap.has(href));
	if (hrefsToSearch.length === 0) {
		return Promise.resolve(buildStatusResponse(validHrefs));
	}

	return getBookmarkIndex().then(index => {
		if (requestGeneration !== bookmarkCacheGeneration) {
			return searchhrefs(hrefs);
		}

		for (const href of hrefsToSearch) {
			const bookmarkList = index.bookmarksByNormalizedUrl.get(href) || [];
			let status = "none";
			let bestPriority = Infinity;

			for (const bookmark of bookmarkList) {
				const matched = findMatchingRuleStyle(
					bookmark,
					index.rules,
					index.parentById,
					index.stylePriorityById
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
				index.stylePriorityById.has(index.unmatchedBookmarkStyle)
			) {
				status = index.unmatchedBookmarkStyle;
			}

			bookmarkStatusMap.set(href, status);
		}

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
	if (!bookmarkIndexPromise) {
		bookmarkIndexPromise = buildBookmarkIndex()
			.then(index => {
				liveBookmarkIndex = index;
				return index;
			})
			.catch(error => {
				bookmarkIndexPromise = null;
				liveBookmarkIndex = null;
				throw error;
			});
	}
	return bookmarkIndexPromise;
}

function indexesUnmatchedBookmarks(stylePriorityById) {
	return !!(
		unmatchedBookmarkStyle &&
		stylePriorityById.has(unmatchedBookmarkStyle)
	);
}

function buildBookmarkIndex() {
	const stylePriorityById = getStyleRulePriorityMap(styleRules);
	const shouldIndexUnmatched = indexesUnmatchedBookmarks(stylePriorityById);

	return resolveConfiguredRules(bookmarkRules).then(rules => {
		if (shouldIndexUnmatched) {
			return browser.bookmarks.getTree().then(bookmarkTree => {
				const maps = buildBookmarkMaps(bookmarkTree);
				return {
					rules,
					unmatchedBookmarkStyle,
					stylePriorityById,
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
				stylePriorityById,
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
				stylePriorityById,
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
	bookmarkStatusMap = new Map();
	bookmarkIndexPromise = null;
	liveBookmarkIndex = null;
}

function clearStatusesForUrls(urls) {
	for (const url of urls) {
		if (url) bookmarkStatusMap.delete(url);
	}
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

function findMatchingRuleStyle(bookmark, rules, parentById, stylePriorityById) {
	let best = null;
	for (const rule of rules) {
		if (!isBookmarkUnderFolder(bookmark, rule.folderId, parentById)) continue;
		const priority = stylePriorityById.has(rule.style)
			? stylePriorityById.get(rule.style)
			: Number.MAX_SAFE_INTEGER;
		if (!best || priority < best.priority) {
			best = { styleId: rule.style, priority };
			if (priority === 0) break;
		}
	}
	return best;
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

// Clear cached statuses when a tab finishes loading so the next query is fresh.
browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
	if (changeInfo.status === "complete") {
		bookmarkStatusMap = new Map();
	}
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
