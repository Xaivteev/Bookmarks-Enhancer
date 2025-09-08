// Load settings from config
let searchPairs = [];
let tagsForSearch = [];
let searchSite = true;
let enableTopBorder = false;

let getting = browser.storage.local.get(["searchPairs", "enableTopBorder", "onlyUseSites"]);
getting.then(onGot, onError);
function onError(error) {
    console.log(`Error: ${error}`);
}

function onGot(item) {
	searchPairs = Array.isArray(item.searchPairs) ? item.searchPairs : [];
	
	if (item.onlyUseSites) {
		searchSite = false;
		// Find pair where site matches current URL
		const matchedPair = searchPairs.find(pair => window.location.href.includes(pair.site));

		if (matchedPair) {
			searchSite = true;
			tagsForSearch = matchedPair.tag.split(',').map(tag => tag.trim()).filter(Boolean);
		}

	} else {
        tagsForSearch = searchPairs.flatMap(pair => pair.tag.split(',').map(tag => tag.trim()).filter(Boolean));
		searchSite = true;
	}

    enableTopBorder = !!item.enableTopBorder;
}

// Set up communication port for initial styling

let port = browser.runtime.connect({name:"bookmark-highlighter"});

// Listen for response from background script

port.onMessage.addListener(applyBookmarkStyling);

// Ask background script to check for bookmarks

port.postMessage({ hrefs: collectNormalizedHrefs() });

// Connection from backgroundScript if update button is pressed
browser.runtime.onConnect.addListener(connected);
function connected(p) {
	port = p;
	port.onMessage.addListener(applyBookmarkStyling);
		
	port.postMessage({ hrefs: collectNormalizedHrefs() });
}

function collectNormalizedHrefs() {
	const hrefs = [];
	for (const link of document.links) {
		hrefs.push(normalizeHrefForSearch(link.href));
	}
	return hrefs;
}

function applyBookmarkStyling(message) {
	if (!searchSite) return;

	for (const tag of tagsForSearch) {
		const elements = Array.from(document.getElementsByClassName(tag)).filter(el => {
			const style = window.getComputedStyle(el);

			// filter out hidden elements and those already styled
			const isHidden = style.display === 'none';
			const hasUnderlineDouble = style.textDecoration.includes('underline') && style.textDecorationStyle === 'double';
			const hasUnderlineDashed = style.textDecorationLine === 'underline' && style.textDecorationStyle === 'dashed';

			return !isHidden && !hasUnderlineDouble && !hasUnderlineDashed;
		});

		if (message.seen) styleSeen(message.seen, elements);
		if (message.blocked) styleBlocked(message.blocked, elements);
		if (message.favorited) styleFavorited(message.favorited, elements);
	}
}
function styleBookmarks(bookmarks, elements, styleConfig) {
	// Style matching elements
	for (const element of elements) {
		const content = element.innerHTML.trim();
		for (const bookmark of bookmarks) {
			const path = new URL(bookmark.url).pathname;
			if (content.includes(path)) {
				Object.assign(element.style, styleConfig.element);
			}
			if (window.location.href.includes(bookmark.url) && enableTopBorder) {
				document.body.style.borderTop = styleConfig.border;
			}
		}
	}

	// Style matching links
	for (const link of document.links) {
		for (const bookmark of bookmarks) {
			if (hrefsMatch(link.href, bookmark.url)) {
				Object.assign(link.style, styleConfig.link);
			}
		}
	}
}

function styleBlocked(blocked, element) {
	styleBookmarks(blocked, element, {
		element: { display: "none" },
		link: { display: "none" },
		border: "dashed red"
	});
}

function styleFavorited(favorited, element) {
	styleBookmarks(favorited, element, {
		element: { textDecoration: "underline", textDecorationStyle: "double" },
		link: { textDecoration: "underline double" },
		border: "double white"
	});
}

function styleSeen(seen, element) {
	styleBookmarks(seen, element, {
		element: { textDecorationLine: "underline", textDecorationStyle: "dashed" },
		link: { textDecoration: "underline dashed" },
		border: "dashed white"
	});
}

// Compare two hrefs for equality after normalization
function hrefsMatch(linkHref, bookmarkUrl) {
	try {
		const normalizedLink = normalizeHrefForSearch(linkHref);
		const normalizedBookmark = normalizeHrefForSearch(bookmarkUrl);
		return normalizedLink === normalizedBookmark;
	} catch {
		return false;
	}
}

function normalizeHrefForSearch(href) {
	try {
		const url = new URL(href);
		// Absolute URL (http/https)
		if (url.protocol === "http:" || url.protocol === "https:") {
			return url.href;
		}
		// Protocol-relative (e.g., //cdn.example.com/lib.js)
		if (url.protocol === "") {
			return new URL(href, window.location.origin).href;
		}
	} catch {
		// Likely a relative path
		try {
			return new URL(href, window.location.origin).href;
		} catch {
			// Final fallback: return original href value
			return href;
		}
	}

	// Fallback
	return href;
}
