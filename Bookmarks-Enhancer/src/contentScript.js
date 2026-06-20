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
	// Start processing links now that settings are loaded
	try { initProcessing(); } catch (e) { /* initProcessing may be defined later */ }
}

// Link map state
let linkMap = new Map(); // normalizedHref -> [link elements]
let linkStatusMap = new Map(); // normalizedHref -> { seen, blocked, favorited }
let processedHrefs = new Set();
let observer = null;
let pendingObservedHrefs = new Set();
let mutationDebounceTimer = null;
const mutationDebounceDelay = 200;

function requestBookmarkStatuses(hrefs) {
	if (!hrefs || !hrefs.length) return;
	browser.runtime.sendMessage({ hrefs }).then(applyBookmarkStyling).catch(onError);
}

// Listen for explicit refresh messages from backgroundScript
browser.runtime.onMessage.addListener(message => {
	if (message && message.refresh) {
		sendAllHrefs();
	}
});

// Build a map of normalizedHref -> [link elements], filtering invalid/hidden links
function buildLinkMap() {
	linkMap = new Map();
	for (const link of document.links) {
		collectLink(link);
	}
}

function collectLink(link) {
	const href = link.getAttribute('href') || link.href || '';
	if (!href) return null;
	let normalized;
	try {
		normalized = normalizeHrefForSearch(href);
	} catch { return null; }

	if (!/^https?:/.test(normalized)) return null;

	const style = window.getComputedStyle(link);
	if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return null;

	if (!linkMap.has(normalized)) linkMap.set(normalized, []);
	linkMap.get(normalized).push(link);
	return normalized;
}

function sendUniqueHrefs() {
	if (!searchSite) return; // skip if site not relevant
	buildLinkMap();
	const allHrefs = Array.from(linkMap.keys());
	const newHrefs = allHrefs.filter(h => !processedHrefs.has(h));
	if (newHrefs.length === 0) return;
	newHrefs.forEach(h => processedHrefs.add(h));
	requestBookmarkStatuses(newHrefs);
}

function sendAllHrefs() {
	if (!searchSite) return;
	buildLinkMap();
	const allHrefs = Array.from(linkMap.keys());
	allHrefs.forEach(h => processedHrefs.add(h));
	requestBookmarkStatuses(allHrefs);
}

function applyBookmarkStyling(message) {
	if (!searchSite) return;

	const bookmarkGroups = {
		seen: normalizeBookmarks(message.seen),
		blocked: normalizeBookmarks(message.blocked),
		favorited: normalizeBookmarks(message.favorited)
	};

	// Store known bookmark status per normalized URL for incremental updates
	function cacheBookmarkStatus(bookmarks, type) {
		if (!bookmarks) return;
		for (const bookmark of bookmarks) {
			const norm = bookmark.normalized;
			const status = linkStatusMap.get(norm) || { seen: false, blocked: false, favorited: false };
			status[type] = true;
			linkStatusMap.set(norm, status);
		}
	}

	cacheBookmarkStatus(bookmarkGroups.seen, 'seen');
	cacheBookmarkStatus(bookmarkGroups.blocked, 'blocked');
	cacheBookmarkStatus(bookmarkGroups.favorited, 'favorited');

	function applyLinkResults(bookmarks, styleConfig) {
		for (const bookmark of bookmarks) {
			const els = linkMap.get(bookmark.normalized) || [];
			for (const el of els) {
				Object.assign(el.style, styleConfig.link);
			}
		}
	}

	applyLinkResults(bookmarkGroups.seen, { link: { textDecoration: 'underline dashed' } });
	applyLinkResults(bookmarkGroups.blocked, { link: { display: 'none' } });
	applyLinkResults(bookmarkGroups.favorited, { link: { textDecoration: 'underline double' } });

	// Then run the existing class-based element styling for configured tags
	for (const tag of tagsForSearch) {
		const elements = Array.from(document.getElementsByClassName(tag)).filter(el => {
			const style = window.getComputedStyle(el);
			const isHidden = style.display === 'none';
			const hasUnderlineDouble = style.textDecoration.includes('underline') && style.textDecorationStyle === 'double';
			const hasUnderlineDashed = style.textDecorationLine === 'underline' && style.textDecorationStyle === 'dashed';
			return !isHidden && !hasUnderlineDouble && !hasUnderlineDashed;
		});

		styleElementsForBookmarks(elements, bookmarkGroups);
	}
}

function normalizeBookmarks(bookmarks) {
	if (!bookmarks) return [];
	return bookmarks.map(b => ({
		url: b.url,
		normalized: normalizeHrefForSearch(b.url),
		path: new URL(b.url).pathname
	}));
}

function styleElementsForBookmarks(elements, bookmarkGroups) {
	const stylePriority = [
		{ bookmarks: bookmarkGroups.blocked, styleConfig: getBlockedStyleConfig() },
		{ bookmarks: bookmarkGroups.favorited, styleConfig: getFavoritedStyleConfig() },
		{ bookmarks: bookmarkGroups.seen, styleConfig: getSeenStyleConfig() }
	];
	const normalizedCurrentUrl = normalizeHrefForSearch(window.location.href);

	for (const group of stylePriority) {
		for (const bookmark of group.bookmarks) {
			if (normalizedCurrentUrl === bookmark.normalized && enableTopBorder) {
				document.body.style.borderTop = group.styleConfig.border;
			}
		}
	}

	for (const element of elements) {
		const text = element.textContent || "";
		const html = element.innerHTML || "";
		let matchedStyle = null;

		for (const group of stylePriority) {
			for (const bookmark of group.bookmarks) {
				if (elementMatchesBookmark(element, text, html, bookmark)) {
					matchedStyle = group.styleConfig.element;
					break;
				}
			}
			if (matchedStyle) {
				break;
			}
		}

		if (matchedStyle) {
			Object.assign(element.style, matchedStyle);
		}
	}
}

function elementMatchesBookmark(element, text, html, bookmark) {
	const { normalized, path } = bookmark;

	// Match against text or innerHTML
	if (text.includes(normalized) || text.includes(path) ||
		html.includes(normalized) || html.includes(path)) {
		return true;
	}

	// Match against any attribute in any descendant
	const descendants = element.querySelectorAll("*");
	for (const desc of descendants) {
		for (const attr of desc.attributes) {
			const val = attr.value;
			if (val.includes(normalized) || val.includes(path)) {
				return true;
			}
		}
	}

	return false;
}


function getBlockedStyleConfig() {
	return {
		element: { display: "none" },
		link: { display: "none" },
		border: "dashed red"
	};
}

function getFavoritedStyleConfig() {
	return {
		element: { textDecoration: "underline", textDecorationStyle: "double" },
		link: { textDecoration: "underline double" },
		border: "double white"
	};
}

function getSeenStyleConfig() {
	return {
		element: { textDecorationLine: "underline", textDecorationStyle: "dashed" },
		link: { textDecoration: "underline dashed" },
		border: "dashed white"
	};
}

function normalizeHrefForSearch(href) {
	try {
		const url = new URL(href, window.location.origin);
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

// MutationObserver: watch for newly added links and process incrementally
function startMutationObserver() {
	if (observer) return;
	observer = new MutationObserver(mutations => {
		for (const m of mutations) {
			for (const node of m.addedNodes) {
				if (node instanceof HTMLAnchorElement) {
					const norm = collectLink(node);
					if (norm) pendingObservedHrefs.add(norm);
				}
				if (node instanceof Element) {
					const links = node.querySelectorAll ? node.querySelectorAll('a[href]') : [];
					for (const link of links) {
						const norm = collectLink(link);
						if (norm) pendingObservedHrefs.add(norm);
					}
				}
			}
		}
		scheduleObservedHrefProcessing();
	});
	observer.observe(document.documentElement || document.body, { childList: true, subtree: true });
}

function scheduleObservedHrefProcessing() {
	if (mutationDebounceTimer) return;
	mutationDebounceTimer = setTimeout(processObservedHrefs, mutationDebounceDelay);
}

function processObservedHrefs() {
	const hrefs = Array.from(pendingObservedHrefs);
	pendingObservedHrefs = new Set();
	mutationDebounceTimer = null;

	const hrefsToRequest = [];
	for (const norm of hrefs) {
		if (linkStatusMap.has(norm)) {
			applyCachedLinkStatus(norm);
		}
		if (!processedHrefs.has(norm)) {
			processedHrefs.add(norm);
			hrefsToRequest.push(norm);
		}
	}

	requestBookmarkStatuses(hrefsToRequest);
}

function applyCachedLinkStatus(norm) {
	const status = linkStatusMap.get(norm);
	if (!status) return;
	const els = linkMap.get(norm) || [];
	for (const el of els) {
		if (status.blocked) Object.assign(el.style, { display: 'none' });
		else if (status.favorited) Object.assign(el.style, { textDecoration: 'underline double' });
		else if (status.seen) Object.assign(el.style, { textDecoration: 'underline dashed' });
	}
}

function initProcessing() {
	if (!searchSite) return;
	// Build initial map and send unique hrefs
	sendUniqueHrefs();
	// Start observing for incremental additions
	startMutationObserver();
}
