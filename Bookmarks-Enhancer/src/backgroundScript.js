var port;

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
	var activeTab = browser.tabs.query({
		currentWindow: true,
		active: true
	});
	activeTab.then(connectToTab, onError);
});

browser.pageAction.onClicked.addListener(() => {
	var activeTab = browser.tabs.query({
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

function searchhrefs(hrefs) {
	var searches = [];
	var blockedFolderName = 'Blocked';
	var favoritedFolderName = 'Favorited';
	
	// contentScript asks if links have been bookmarked
	// Search for bookmarks
	for (var i = 0; i < hrefs.length; i++) {
		var href = hrefs[i].split('?p=')[0];
		searches.push(browser.bookmarks.search({url: href}));
	}
	
	// Search for blocked and favorited bookmark folders
	browser.bookmarks.search({title: blockedFolderName}).then(function (blockedFolderNode) {
		browser.bookmarks.search({title: favoritedFolderName}).then(function (favoritedFolderNode) {
			//Search for bookmarks
			Promise.all(searches).then(function (bookmarkedArray) {
				var savedBookmarks = [];
				var blockedBookmarks = [];
				var favoritedBookmarks = [];
				// Collect bookmarks into arrays
				for (var i = 0; i < bookmarkedArray.length; i++) {
					var bookmark = bookmarkedArray[i];

					if (bookmark.length > 0) {
						if (!!blockedFolderNode && bookmark[0].parentId === blockedFolderNode[0].id) {
							blockedBookmarks.push(bookmark[0]);
						} else if (!!favoritedFolderNode && bookmark[0].parentId === favoritedFolderNode[0].id) {
							favoritedBookmarks.push(bookmark[0]);
						} else if (bookmark[0].title !== blockedFolderName &&
									bookmark[0].title !== favoritedFolderName) {
							savedBookmarks.push(bookmark[0]);			
						}
							
					}
				}
				
				// Pass bookmark arrays back to contentScript
				var msg = { blocked: blockedBookmarks,
							favorited: favoritedBookmarks,
							seen: savedBookmarks};
							
				port.postMessage(msg);
			});
		});
	});
}