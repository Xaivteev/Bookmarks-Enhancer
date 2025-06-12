import { styleSeen, styleBlocked, styleFavorited } from './style.js'; }

// Load settings from config
var tagsForSearch = [];
var searchSite = true;
var enableTopBorder = false;

var getting = browser.storage.local.get(["sitesForSearch", "tagsForSearch", "enableTopBorder", "onlyUseSites"]);
getting.then(onGot, onError);

// Set up communication port for initial styling
var port = browser.runtime.connect({name:"bookmark-highlighter"});

// Listen for response from background script
port.onMessage.addListener(function(m) {
	if (searchSite) {
		for (var i = 0; i < tagsForSearch.length; i++) {
			var divs = document.getElementsByClassName(tagsForSearch[i]);
			if (m.seen) {
				styleSeen(m.seen, divs, enableTopBorder);
			}
			if (m.blocked) {
				styleBlocked(m.blocked, divs, enableTopBorder);
			}
			if (m.favorited) {
				styleFavorited(m.favorited, divs, enableTopBorder);
			}
		}
	}
});

// Collect list of links
var hrefs = [];
for (var i = 0; i < document.links.length; i++) {
    var item = document.links[i];
    hrefs.push(item.href);
}

// Ask background script to check for bookmarks
port.postMessage({hrefs: hrefs});

// Connection from backgroundScript if update button is pressed
browser.runtime.onConnect.addListener(connected);
function connected(p) {
	port = p;
	port.onMessage.addListener(function(m) {
		if (searchSite) {
			for (var i = 0; i < tagsForSearch.length; i++) {
				var divs = document.getElementsByClassName(tagsForSearch[i]);
				if (m.seen) {
					styleSeen(m.seen, divs, enableTopBorder);
				}
				if (m.blocked) {
					styleBlocked(m.blocked, divs, enableTopBorder);
				}
				if (m.favorited) {
					styleFavorited(m.favorited, divs, enableTopBorder);
				}
			}
		}
	});

	var hrefs = [];

	for (var i = 0; i < document.links.length; i++) {
		var item = document.links[i];
		hrefs.push(item.href);
	}
		
	port.postMessage({hrefs: hrefs});
}

function onError(error) {
	console.log(`Error: ${error}`);
}

// Function to handle the settings retrieved from storage
function onGot(item) {
	if (item.tagsForSearch) {
		tagsForSearch = item.tagsForSearch.split(',');
		for (var i = 0; i < tagsForSearch.length; i++) {
			tagsForSearch[i] = tagsForSearch[i].trim();
		}
	}

    // Check if onlyUseSites is enabled and set searchSite accordingly to determine if we should search bookmarks based on the current site
	if (!!item.onlyUseSites) {
		searchSite = false;
		if (item.sitesForSearch) {
			sitesForSearch = item.sitesForSearch.split(',');
			for (var i = 0; i < sitesForSearch.length; i++) {
				sitesForSearch[i] = sitesForSearch[i].trim();
			}
			for (var i = 0; i < sitesForSearch.length; i++) {
				if (window.location.href.includes(sitesForSearch[i])) {
					searchSite = true;
				}
			}
		}
	} else {
		searchSite = true;
	}

	if (!!item.enableTopBorder) {
		enableTopBorder = item.enableTopBorder;
	}
}

