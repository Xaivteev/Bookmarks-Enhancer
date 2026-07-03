browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
	if (message && message.hrefs) {
		searchhrefs(message.hrefs).then(sendResponse).catch(error => {
			onError(error);
			sendResponse({ seen: [], blocked: [], favorited: [] });
		});
		return true;
	}
	return false;
});

// trigger update styling if button is clicked
browser.browserAction.onClicked.addListener(() => {
	let activeTab = browser.tabs.query({
		currentWindow: true,
		active: true
	});
	activeTab.then(tabs => {
		if (tabs.length > 0) {
			browser.tabs.sendMessage(tabs[0].id, { refresh: true }).catch(onError);
		}
	}, onError);
});

browser.pageAction.onClicked.addListener(() => {
	let activeTab = browser.tabs.query({
		currentWindow: true,
		active: true
	});
	activeTab.then(tabs => {
		if (tabs.length > 0) {
			browser.tabs.sendMessage(tabs[0].id, { refresh: true }).catch(onError);
		}
	}, onError);
});

function onError(error) {
	console.log(`Error: ${error}`);
}

let urlRules = [];
let textFilters = [];
function loadUrlRules() {
    return browser.storage.local
        .get("urlRules")
        .then(result => {
            urlRules = Array.isArray(result.urlRules)
                ? result.urlRules
                : [];
        });
}

function loadTextFilters() {
    return browser.storage.local
        .get("textFilters")
        .then(result => {
            textFilters = Array.isArray(result.textFilters)
                ? result.textFilters
                : [];
        });
}

loadUrlRules();
loadTextFilters();

// Listen for storage changes and update settings dynamically
browser.storage.onChanged.addListener((changes, areaName) => {
	if (areaName !== "local") return;

	if (changes.urlRules) {
		urlRules = Array.isArray(changes.urlRules.newValue)
			? changes.urlRules.newValue
			: [];
	}

	if (changes.textFilters) {
		textFilters = Array.isArray(changes.textFilters.newValue)
			? changes.textFilters.newValue
			: [];
	}
});

let bookmarkStatusMap = new Map(); // href -> { seen, blocked, favorited }
let bookmarkIndexPromise = null;
function searchhrefs(hrefs) {
	// contentScript asks if links have been bookmarked
	// Normalize hrefs and prepare lookup
	const normalizedHrefs = hrefs.map(normalizeHrefForSearch);

    // Filter out invalid URLs
	const validHrefs = normalizedHrefs.filter(isValidBookmarkUrl);

	// Filter out hrefs that have already been processed
	const hrefsToSearch = validHrefs.filter(href => !bookmarkStatusMap.has(href));
	if (hrefsToSearch.length === 0) return Promise.resolve(buildStatusResponse());

	return getBookmarkIndex().then(index => {
		for (const href of hrefsToSearch) {
			const status = {
				seen: null,
				blocked: null,
				favorited: null
			};
			const bookmarkList = index.bookmarksByNormalizedUrl.get(href) || [];
			const blockedBookmark = bookmarkList.find(bookmark => bookmark.parentId === index.blockedFolderId);
			const favoritedBookmark = bookmarkList.find(bookmark => bookmark.parentId === index.favoritedFolderId);
			const seenBookmark = bookmarkList.find(bookmark =>
				bookmark.parentId !== index.blockedFolderId &&
				bookmark.parentId !== index.favoritedFolderId
			);

			if (blockedBookmark) status.blocked = blockedBookmark;
			else if (favoritedBookmark) status.favorited = favoritedBookmark;
			else if (seenBookmark) status.seen = seenBookmark;

			bookmarkStatusMap.set(href, status);
		}

		return buildStatusResponse();
	});
}

function buildStatusResponse() {
	const savedBookmarks = [];
	const blockedBookmarks = [];
	const favoritedBookmarks = [];

	for (const status of bookmarkStatusMap.values()) {
		if (status.seen) savedBookmarks.push(status.seen);
		if (status.blocked) blockedBookmarks.push(status.blocked);
		if (status.favorited) favoritedBookmarks.push(status.favorited);
	}

	return {
		seen: savedBookmarks,
		blocked: blockedBookmarks,
		favorited: favoritedBookmarks
	};
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

function normalizeHrefForSearch(href) {
	try {
		const url = new URL(href);
		if (url.protocol !== "http:" && url.protocol !== "https:") return href;

		const rule = urlRules.find(rule =>
			url.hostname.includes(rule.site)
		);

		if (rule) {
			const keptParams = new URLSearchParams();

			const params = rule.keepParams
				.split(',')
				.map(p => p.trim())
				.filter(Boolean);

			for (const param of params) {
				const value = url.searchParams.get(param);

				if (value !== null) {
					keptParams.set(param, value);
				}
			}

			url.search = keptParams.toString()
				? `?${keptParams.toString()}`
				: "";
		}
		else {
			url.search = "";
		}
		url.hash = "";

		let normalized = url.href;
		if (url.pathname !== "/" && normalized.endsWith("/")) {
			normalized = normalized.slice(0, -1);
		}

		return normalized;
	} catch {
		return href;
	}
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

browser.storage.onChanged.addListener((changes, area) => {
    if (
        area === "local" &&
        changes.urlRules
    ) {
        urlRules = changes.urlRules.newValue || [];
        invalidateBookmarkCaches();
    }
});