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
	bookmarkRules: "bookmarkRules",
	enableSeenStyling: "enableSeenStyling",
	blockedFolderId: "blockedFolderId",
	favoritedFolderId: "favoritedFolderId"
};

let urlRules = [];
let bookmarkRules = [];
let enableSeenStyling = true;

function loadSettings() {
    return browser.storage.local
        .get([
			STORAGE_KEYS.urlRules,
			STORAGE_KEYS.bookmarkRules,
			STORAGE_KEYS.enableSeenStyling,
			STORAGE_KEYS.blockedFolderId,
			STORAGE_KEYS.favoritedFolderId
		])
        .then(result => {
            urlRules = Array.isArray(result[STORAGE_KEYS.urlRules])
                ? result[STORAGE_KEYS.urlRules]
                : [];
			bookmarkRules = normalizeBookmarkRules(
				migrateBookmarkRulesFromStorage(result)
			);
			enableSeenStyling = result[STORAGE_KEYS.enableSeenStyling] !== false;
        });
}

function normalizeStoredFolderId(value) {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isValidBookmarkRule(rule) {
	return rule &&
		typeof rule.folderId === "string" &&
		rule.folderId.trim() !== "" &&
		(rule.style === "blocked" || rule.style === "favorited");
}

function normalizeBookmarkRules(rules) {
	if (!Array.isArray(rules)) return [];

	const seenFolders = new Set();
	const normalized = [];
	for (const rule of rules) {
		if (!isValidBookmarkRule(rule)) continue;
		const folderId = rule.folderId.trim();
		if (seenFolders.has(folderId)) continue;
		seenFolders.add(folderId);
		normalized.push({
			folderId,
			style: rule.style === "favorited" ? "favorited" : "blocked"
		});
	}
	return normalized;
}

function migrateBookmarkRulesFromStorage(result) {
	if (Array.isArray(result[STORAGE_KEYS.bookmarkRules])) {
		return result[STORAGE_KEYS.bookmarkRules];
	}

	const legacyRules = [];
	const blockedFolderId = normalizeStoredFolderId(result[STORAGE_KEYS.blockedFolderId]);
	const favoritedFolderId = normalizeStoredFolderId(result[STORAGE_KEYS.favoritedFolderId]);
	if (blockedFolderId) {
		legacyRules.push({ folderId: blockedFolderId, style: "blocked" });
	}
	if (favoritedFolderId) {
		legacyRules.push({ folderId: favoritedFolderId, style: "favorited" });
	}
	return legacyRules;
}

const settingsReady = loadSettings().catch(onError);

const RULE_FOLDER_MENU_PREFIX = "addLinkToRuleFolder:";
const RULE_FOLDER_MENU_PARENT = "addLinkToRuleFolderParent";
const LEGACY_LINK_MENU_IDS = ["addLinkBlocked", "addLinkFavorited"];
let ruleFolderMenuIds = [];

// Create context menu items for selection and links
function createContextMenus() {
	const menuDefinitions = [
		{
			id: 'addTextFilter',
			title: 'Add selection to site blocked text',
			contexts: ['selection']
		},
		{
			id: 'selectTargetClasses',
			title: 'Select Target Classes',
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

	refreshRuleFolderContextMenus();
}

function removeContextMenu(id) {
	return browser.contextMenus.remove(id).catch(() => {});
}

function refreshRuleFolderContextMenus() {
	return settingsReady.then(() => {
		const removals = [
			removeContextMenu(RULE_FOLDER_MENU_PARENT),
			...ruleFolderMenuIds.map(removeContextMenu),
			...LEGACY_LINK_MENU_IDS.map(removeContextMenu)
		];
		ruleFolderMenuIds = [];

		return Promise.all(removals).then(() => {
			if (bookmarkRules.length === 0) return;

			browser.contextMenus.create({
				id: RULE_FOLDER_MENU_PARENT,
				title: "Add link to rule folder",
				contexts: ["link"]
			});

			return Promise.all(bookmarkRules.map(rule =>
				getValidFolderId(rule.folderId).then(folderId => {
					if (!folderId) return null;

					return browser.bookmarks.get(folderId).then(nodes => {
						const folder = nodes.find(node => node.type === "folder") || nodes[0];
						if (!folder) return null;

						const styleLabel = rule.style === "favorited" ? "Favorited" : "Blocked";
						const menuId = RULE_FOLDER_MENU_PREFIX + folderId;
						browser.contextMenus.create({
							id: menuId,
							parentId: RULE_FOLDER_MENU_PARENT,
							title: `${folder.title || "Folder"} (${styleLabel})`,
							contexts: ["link"]
						});
						ruleFolderMenuIds.push(menuId);
						return menuId;
					});
				}).catch(onError)
			));
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

function notifyAllTabsRefresh() {
	return browser.tabs.query({}).then(tabs => {
		for (const t of tabs) {
			browser.tabs.sendMessage(t.id, { refresh: true, mode: "optimistic" }).catch(() => {});
		}
	}).catch(() => {});
}

browser.contextMenus.onClicked.addListener((info, tab) => {
	if (!info || !tab) return;

	if (info.menuItemId === 'selectTargetClasses') {
		browser.tabs.sendMessage(tab.id, {
			startClassPicker: true
		}).catch(onError);
		return;
	}

	if (info.menuItemId === 'addTextFilter') {
		const selection = (info.selectionText || '').trim();
		if (!selection) return;
		let site = '';
		try { site = new URL(tab.url).hostname; } catch (e) { site = tab.url || ''; }

		browser.storage.local.get([STORAGE_KEYS.textFilters]).then(result => {
			const existing = Array.isArray(result[STORAGE_KEYS.textFilters]) ? result[STORAGE_KEYS.textFilters] : [];
			const found = existing.find(f => f.site === site);
			const selNormalized = selection.trim();
			if (found) {
				const parts = found.filterText.split(',').map(s => s.trim()).filter(Boolean);
				const lower = parts.map(p => p.toLowerCase());
				if (!lower.includes(selNormalized.toLowerCase())) {
					parts.push(selNormalized);
					found.filterText = parts.join(', ');
				}
			} else {
				existing.push({ site, filterText: selNormalized });
			}
			return browser.storage.local.set({ textFilters: existing });
		}).catch(onError);
		return;
	}

	if (
		typeof info.menuItemId === "string" &&
		info.menuItemId.startsWith(RULE_FOLDER_MENU_PREFIX)
	) {
		const url = info.linkUrl;
		if (!url) return;
		const folderId = info.menuItemId.slice(RULE_FOLDER_MENU_PREFIX.length);
		const title = info.linkText || url;

		settingsReady
			.then(() => createBookmarkInFolder(folderId, url, title))
			.then(() => {
				invalidateBookmarkCaches();
				notifyAllTabsRefresh();
			})
			.catch(onError);
		return;
	}
});

// Listen for storage changes and update settings dynamically
browser.storage.onChanged.addListener((changes, areaName) => {
	if (areaName !== "local") return;

	if (changes[STORAGE_KEYS.urlRules]) {
		urlRules = Array.isArray(changes[STORAGE_KEYS.urlRules].newValue)
			? changes[STORAGE_KEYS.urlRules].newValue
			: [];
		urlNormalizationCache.clear();
		invalidateBookmarkCaches();
	}

	if (changes[STORAGE_KEYS.bookmarkRules]) {
		bookmarkRules = normalizeBookmarkRules(
			changes[STORAGE_KEYS.bookmarkRules].newValue
		);
		invalidateBookmarkCaches();
		refreshRuleFolderContextMenus();
	}

	if (changes[STORAGE_KEYS.enableSeenStyling]) {
		enableSeenStyling = changes[STORAGE_KEYS.enableSeenStyling].newValue !== false;
		invalidateBookmarkCaches();
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
			);
			invalidateBookmarkCaches();
			refreshRuleFolderContextMenus();
		}).catch(onError);
	}

});

// Cache for URL normalization to avoid repeated calculations
const urlNormalizationCache = new Map(); // href -> normalized href

let bookmarkStatusMap = new Map(); // href -> { seen, blocked, favorited }
let bookmarkIndexPromise = null;
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

			for (const bookmark of bookmarkList) {
				const matchedStyle = findMatchingRuleStyle(
					bookmark,
					index.rules,
					index.parentById
				);
				if (matchedStyle === "blocked") {
					status = "blocked";
					break;
				}
				if (matchedStyle === "favorited" && status !== "blocked") {
					status = "favorited";
				}
			}

			if (
				status === "none" &&
				index.enableSeenStyling &&
				bookmarkList.length > 0
			) {
				status = "seen";
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
		bookmarkIndexPromise = buildBookmarkIndex().catch(error => {
			bookmarkIndexPromise = null;
			throw error;
		});
	}
	return bookmarkIndexPromise;
}

function buildBookmarkIndex() {
	return Promise.all([
		resolveConfiguredRules(bookmarkRules),
		browser.bookmarks.getTree()
	]).then(([rules, bookmarkTree]) => {
		const { bookmarksByNormalizedUrl, parentById } = buildBookmarkMaps(bookmarkTree);
		return {
			rules,
			enableSeenStyling,
			bookmarksByNormalizedUrl,
			parentById
		};
	});
}

function resolveConfiguredRules(rules) {
	return Promise.all(
		normalizeBookmarkRules(rules).map(rule =>
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
}

function findMatchingRuleStyle(bookmark, rules, parentById) {
	let matchedStyle = null;
	for (const rule of rules) {
		if (!isBookmarkUnderFolder(bookmark, rule.folderId, parentById)) continue;
		if (rule.style === "blocked") return "blocked";
		if (rule.style === "favorited") matchedStyle = "favorited";
	}
	return matchedStyle;
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

	function visit(node, parentId = null) {
		if (parentId) {
			parentById.set(node.id, parentId);
		}

		if (node.url && isValidBookmarkUrl(node.url)) {
			const normalized = normalizeHrefForSearch(node.url);
			if (!bookmarksByNormalizedUrl.has(normalized)) {
				bookmarksByNormalizedUrl.set(normalized, []);
			}
			bookmarksByNormalizedUrl.get(normalized).push(node);
		}

		if (Array.isArray(node.children)) {
			node.children.forEach(child => visit(child, node.id));
		}
	}

	bookmarkTree.forEach(node => visit(node, null));
	return { bookmarksByNormalizedUrl, parentById };
}

function isValidBookmarkUrl(href) {
	try {
		const url = new URL(href);
		return url.protocol === "http:" || url.protocol === "https:";
	} catch {
		return false;
	}
}

// Clear cached bookmarks when refreshed or navigated
browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
	if (changeInfo.status === "complete") {
		bookmarkStatusMap = new Map();
	}
});

browser.bookmarks.onRemoved.addListener((id, removeInfo) => {
	invalidateBookmarkCaches();
});

browser.bookmarks.onCreated.addListener((id, bookmark) => {
	invalidateBookmarkCaches();
});

browser.bookmarks.onMoved.addListener((id, moveInfo) => {
	invalidateBookmarkCaches();
});

browser.bookmarks.onChanged.addListener((id, changeInfo) => {
	invalidateBookmarkCaches();
});
