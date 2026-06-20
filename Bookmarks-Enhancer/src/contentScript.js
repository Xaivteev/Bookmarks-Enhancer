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

	// Store known bookmark status per normalized URL for incremental updates
	function cacheBookmarkStatus(bookmarks, type) {
		if (!bookmarks) return;
		for (const b of bookmarks) {
			const norm = normalizeHrefForSearch(b.url);
			const status = linkStatusMap.get(norm) || { seen: false, blocked: false, favorited: false };
			status[type] = true;
			linkStatusMap.set(norm, status);
		}
	}

	cacheBookmarkStatus(message.seen, 'seen');
	cacheBookmarkStatus(message.blocked, 'blocked');
	cacheBookmarkStatus(message.favorited, 'favorited');

	function applyLinkResults(bookmarks, styleConfig) {
		if (!bookmarks) return;
		for (const b of bookmarks) {
			const norm = normalizeHrefForSearch(b.url);
			const els = linkMap.get(norm) || [];
			for (const el of els) {
				Object.assign(el.style, styleConfig.link);
			}
		}
	}

	if (message.seen) applyLinkResults(message.seen, { link: { textDecoration: 'underline dashed' } });
	if (message.blocked) applyLinkResults(message.blocked, { link: { display: 'none' } });
	if (message.favorited) applyLinkResults(message.favorited, { link: { textDecoration: 'underline double' } });

	// Then run the existing class-based element styling for configured tags
	for (const tag of tagsForSearch) {
		const elements = Array.from(document.getElementsByClassName(tag)).filter(el => {
			const style = window.getComputedStyle(el);
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
	const normalizedBookmarks = bookmarks.map(b => ({
		url: b.url,
		normalized: normalizeHrefForSearch(b.url),
		path: new URL(b.url).pathname
	}));

	for (const element of elements) {
		const text = element.textContent || "";
		const html = element.innerHTML || "";

		let matched = false;

		for (const bookmark of normalizedBookmarks) {
			const { normalized, path } = bookmark;

			// Match against text or innerHTML
			if (text.includes(normalized) || text.includes(path) ||
				html.includes(normalized) || html.includes(path)) {
				matched = true;
				break;
			}

			// Match against any attribute in any descendant
			const descendants = element.querySelectorAll("*");
			for (const desc of descendants) {
				for (const attr of desc.attributes) {
					const val = attr.value;
					if (val.includes(normalized) || val.includes(path)) {
						matched = true;
						break;
					}
				}
				if (matched) break;
			}

			if (matched) break;
		}

		if (matched) {
			Object.assign(element.style, styleConfig.element);
		}
	}

	// Style matching links
	for (const link of document.links) {
		const normalizedLink = normalizeHrefForSearch(link.href);
		for (const bookmark of normalizedBookmarks) {
			if (normalizedLink === bookmark.normalized) {
				Object.assign(link.style, styleConfig.link);
			}
		}
	}

	// top border styling
	for (const bookmark of normalizedBookmarks) {
		if (window.location.href.includes(bookmark.normalized) && enableTopBorder) {
			document.body.style.borderTop = styleConfig.border;
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

// MutationObserver: watch for newly added links and process incrementally
function startMutationObserver() {
	if (observer) return;
	observer = new MutationObserver(mutations => {
		const newHrefs = new Set();
		for (const m of mutations) {
			for (const node of m.addedNodes) {
				if (node instanceof HTMLAnchorElement) {
					const norm = collectLink(node);
					if (norm) newHrefs.add(norm);
				}
				if (node instanceof Element) {
					const links = node.querySelectorAll ? node.querySelectorAll('a[href]') : [];
					for (const link of links) {
						const norm = collectLink(link);
						if (norm) newHrefs.add(norm);
					}
				}
			}
		}
		for (const norm of newHrefs) {
			if (linkStatusMap.has(norm)) {
				applyCachedLinkStatus(norm);
			}
			if (!processedHrefs.has(norm)) {
				processedHrefs.add(norm);
				requestBookmarkStatuses([norm]);
			}
		}
	});
	observer.observe(document.documentElement || document.body, { childList: true, subtree: true });
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
