let port;

// initial page setup
function connected(p) {
	port = p;

    port.onMessage.addListener(function(m) {
        if (m.hrefs) {
			searchhrefs(m.hrefs);
        };
    });
}

browser.runtime.onConnect.addListener(connected);

// trigger update styling if button is clicked
browser.browserAction.onClicked.addListener(() => {
	let activeTab = browser.tabs.query({
		currentWindow: true,
		active: true
	});
	activeTab.then(connectToTab, onError);
});

browser.pageAction.onClicked.addListener(() => {
	let activeTab = browser.tabs.query({
		currentWindow: true,
		active: true
	});
	activeTab.then(connectToTab, onError);
});

function connectToTab(tabs) {
	if (tabs.length > 0) {
		port = browser.tabs.connect(tabs[0].id, {
			name: "bookmark-highlighter",
		});
		
		port.onMessage.addListener(function(m) {
			if (m.hrefs) {
				searchhrefs(m.hrefs);
			};
		});
	}
}

function onError(error) {
	console.log(`Error: ${error}`);
}

let bookmarkStatusMap = new Map(); // href -> { seen, blocked, favorited }
function searchhrefs(hrefs) {
	let blockedFolderName = 'Blocked';
	let favoritedFolderName = 'Favorited';
	
	// contentScript asks if links have been bookmarked
	// Normalize hrefs and prepare lookup
	const normalizedHrefs = hrefs.map(href => href.split('?p=')[0]);

	// Filter out hrefs that have already been processed
    const hrefsToSearch = normalizedHrefs.filter(href => !bookmarkStatusMap.has(href));

	// Prepare search promises
	const searches = hrefsToSearch.map(href => browser.bookmarks.search({ url: href }));

	// Search for blocked and favorited bookmark folders
	Promise.all([
		browser.bookmarks.search({ title: blockedFolderName }),
		browser.bookmarks.search({ title: favoritedFolderName }),
		Promise.all(searches)
	]).then(([blockedFolderNode, favoritedFolderNode, bookmarkedArray]) => {
		const blockedFolderId = blockedFolderNode?.[0]?.id;
		const favoritedFolderId = favoritedFolderNode?.[0]?.id;

		for (let i = 0; i < bookmarkedArray.length; i++) {
			const bookmarkList = bookmarkedArray[i];
			const href = normalizedHrefs[i];

			const status = {
				seen: null,
				blocked: null,
				favorited: null
			};

			if (bookmarkList.length > 0) {
				const bookmark = bookmarkList[0];

				if (bookmark.parentId === blockedFolderId) {
					status.blocked = bookmark;
				} else if (bookmark.parentId === favoritedFolderId) {
					status.favorited = bookmark;
				} else if (
					bookmark.title !== blockedFolderName &&
					bookmark.title !== favoritedFolderName
				) {
					status.seen = bookmark;
				}
			}

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

		// Pass bookmark arrays back to contentScript
		port.postMessage({
			seen: savedBookmarks,
			blocked: blockedBookmarks,
			favorited: favoritedBookmarks
		});
	});
}

// Clear cached bookmarks when refreshed or navigated
browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
	if (changeInfo.status === "complete") {
		bookmarkStatusMap = new Map();
	}
});
