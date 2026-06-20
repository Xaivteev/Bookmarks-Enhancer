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

let bookmarkStatusMap = new Map(); // href -> { seen, blocked, favorited }
function searchhrefs(hrefs) {
	let blockedFolderName = 'Blocked';
	let favoritedFolderName = 'Favorited';
	
	// contentScript asks if links have been bookmarked
	// Normalize hrefs and prepare lookup
	const normalizedHrefs = hrefs.map(normalizeHrefForSearch);

    // Filter out invalid URLs
	const validHrefs = normalizedHrefs.filter(isValidBookmarkUrl);

	// Filter out hrefs that have already been processed
	const hrefsToSearch = validHrefs.filter(href => !bookmarkStatusMap.has(href));

	// Search for blocked and favorited bookmark folders
	return Promise.all([
		browser.bookmarks.search({ title: blockedFolderName }),
		browser.bookmarks.search({ title: favoritedFolderName }),
		browser.bookmarks.getTree()
	]).then(([blockedFolderNodes, favoritedFolderNodes, bookmarkTree]) => {
		const blockedFolderId = findFolderByTitle(blockedFolderNodes, blockedFolderName)?.id;
		const favoritedFolderId = findFolderByTitle(favoritedFolderNodes, favoritedFolderName)?.id;
		const bookmarksByNormalizedUrl = buildBookmarkUrlMap(bookmarkTree);

		for (const href of hrefsToSearch) {
			const status = {
				seen: null,
				blocked: null,
				favorited: null
			};
			const bookmarkList = bookmarksByNormalizedUrl.get(href) || [];
			const blockedBookmark = bookmarkList.find(bookmark => bookmark.parentId === blockedFolderId);
			const favoritedBookmark = bookmarkList.find(bookmark => bookmark.parentId === favoritedFolderId);
			const seenBookmark = bookmarkList.find(bookmark =>
				bookmark.parentId !== blockedFolderId &&
				bookmark.parentId !== favoritedFolderId
			);

			if (blockedBookmark) status.blocked = blockedBookmark;
			else if (favoritedBookmark) status.favorited = favoritedBookmark;
			else if (seenBookmark) status.seen = seenBookmark;

			bookmarkStatusMap.set(href, status);
		}

		// Collect bookmarks into arrays
		const savedBookmarks = [];
		const blockedBookmarks = [];
		const favoritedBookmarks = [];

		for (const status of bookmarkStatusMap.values()) {
			if (status.seen) savedBookmarks.push(status.seen);
			if (status.blocked) blockedBookmarks.push(status.blocked);
			if (status.favorited) favoritedBookmarks.push(status.favorited);
		}

		const response = {
			seen: savedBookmarks,
			blocked: blockedBookmarks,
			favorited: favoritedBookmarks
		};

		return response;
	});
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

		url.search = "";
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
	removeBookmarkFromCache(id);
});

browser.bookmarks.onMoved.addListener((id, moveInfo) => {
	removeBookmarkFromCache(id);
});

browser.bookmarks.onChanged.addListener((id, changeInfo) => {
	removeBookmarkFromCache(id);
});
function removeBookmarkFromCache(bookmarkId) {
	for (const [href, status] of bookmarkStatusMap.entries()) {
		if (
			status.seen?.id === bookmarkId ||
			status.blocked?.id === bookmarkId ||
			status.favorited?.id === bookmarkId
		) {
			bookmarkStatusMap.delete(href);
		}
	}
}
