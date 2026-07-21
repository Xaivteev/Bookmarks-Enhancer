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

// trigger update styling if button is clicked
browser.browserAction.onClicked.addListener(() => {
	sendRefreshToActiveTab("optimistic");
});

browser.pageAction.onClicked.addListener(() => {
	sendRefreshToActiveTab("optimistic");
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
	textFilters: "textFilters"
};

let urlRules = [];

function loadSettings() {
    return browser.storage.local
        .get([STORAGE_KEYS.urlRules])
        .then(result => {
            urlRules = Array.isArray(result[STORAGE_KEYS.urlRules])
                ? result[STORAGE_KEYS.urlRules]
                : [];
        });
}

const settingsReady = loadSettings().catch(onError);

// Create context menu items for selection and links
function createContextMenus() {
	try {
		browser.contextMenus.create({
			id: 'addTextFilter',
			title: 'Add selection to site blocked text',
			contexts: ['selection']
		});

		browser.contextMenus.create({
			id: 'addLinkBlocked',
			title: 'Add link to Blocked bookmarks',
			contexts: ['link']
		});

		browser.contextMenus.create({
			id: 'addLinkFavorited',
			title: 'Add link to Favorited bookmarks',
			contexts: ['link']
		});

		browser.contextMenus.create({
			id: 'authoritativeRefresh',
			title: 'Authoritative Refresh',
			contexts: ['browser_action', 'page_action']
		});

		browser.contextMenus.create({
			id: 'selectTargetClasses',
			title: 'Select Target Classes',
			contexts: ['browser_action', 'page_action']
		});
	} catch (e) {
		console.error('Context menu creation failed', e);
	}
}

createContextMenus();

// Helper: ensure folder exists then create bookmark inside it
function ensureFolderAndCreateBookmark(folderTitle, url, title) {
	return browser.bookmarks.search({ title: folderTitle }).then(nodes => {
		const folder = nodes.find(n => n.title === folderTitle && n.type === 'folder');
		if (folder) return folder.id;
		return browser.bookmarks.create({ title: folderTitle }).then(f => f.id);
	}).then(folderId => {
		return browser.bookmarks.create({ parentId: folderId, title: title || url, url });
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

	if (info.menuItemId === 'authoritativeRefresh') {
		browser.tabs.sendMessage(tab.id, {
			refresh: true,
			mode: "authoritative"
		}).catch(onError);
		return;
	}

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

	if (info.menuItemId === 'addLinkBlocked' || info.menuItemId === 'addLinkFavorited') {
		const url = info.linkUrl;
		if (!url) return;
		const folder = info.menuItemId === 'addLinkBlocked' ? 'Blocked' : 'Favorited';
		const title = info.linkText || url;

		ensureFolderAndCreateBookmark(folder, url, title).then(() => {
			invalidateBookmarkCaches();
			notifyAllTabsRefresh();
		}).catch(onError);
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
			const blockedBookmark = bookmarkList.find(bookmark => bookmark.parentId === index.blockedFolderId);
			const favoritedBookmark = bookmarkList.find(bookmark => bookmark.parentId === index.favoritedFolderId);
			const seenBookmark = bookmarkList.find(bookmark =>
				bookmark.parentId !== index.blockedFolderId &&
				bookmark.parentId !== index.favoritedFolderId
			);

			let status = "none";
			if (blockedBookmark) status = "blocked";
			else if (favoritedBookmark) status = "favorited";
			else if (seenBookmark) status = "seen";

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
	const blockedFolderName = 'Blocked';
	const favoritedFolderName = 'Favorited';

	return Promise.all([
		browser.bookmarks.search({ title: blockedFolderName }),
		browser.bookmarks.search({ title: favoritedFolderName }),
		browser.bookmarks.getTree()
	]).then(([blockedFolderNodes, favoritedFolderNodes, bookmarkTree]) => ({
		blockedFolderId: findFolderByTitle(blockedFolderNodes, blockedFolderName)?.id,
		favoritedFolderId: findFolderByTitle(favoritedFolderNodes, favoritedFolderName)?.id,
		bookmarksByNormalizedUrl: buildBookmarkUrlMap(bookmarkTree)
	}));
}

function invalidateBookmarkCaches() {
	bookmarkCacheGeneration += 1;
	bookmarkStatusMap = new Map();
	bookmarkIndexPromise = null;
}

function findFolderByTitle(nodes, title) {
	return nodes.find(node => node.title === title && node.type === "folder");
}

function buildBookmarkUrlMap(bookmarkTree) {
	const bookmarksByNormalizedUrl = new Map();

	function visit(node) {
		if (node.url && isValidBookmarkUrl(node.url)) {
			const normalized = normalizeHrefForSearch(node.url);
			if (!bookmarksByNormalizedUrl.has(normalized)) {
				bookmarksByNormalizedUrl.set(normalized, []);
			}
			bookmarksByNormalizedUrl.get(normalized).push(node);
		}

		if (Array.isArray(node.children)) {
			node.children.forEach(visit);
		}
	}

	bookmarkTree.forEach(visit);
	return bookmarksByNormalizedUrl;
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
