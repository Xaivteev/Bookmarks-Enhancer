// Storage key constants
const STORAGE_KEYS = {
	searchPairs: "searchPairs",
	urlRules: "urlRules",
	textFilters: "textFilters",
	enableTopBorder: "enableTopBorder",
	onlyUseSites: "onlyUseSites"
};

// Load settings from config
let searchPairs = [];
let tagsForSearch = [];
let urlRules = [];
let textFilters = [];
let searchSite = true;
let enableTopBorder = false;
let onlyUseSites = false;

let getting = browser.storage.local.get([
    STORAGE_KEYS.searchPairs,
    STORAGE_KEYS.urlRules,
    STORAGE_KEYS.textFilters,
    STORAGE_KEYS.enableTopBorder,
    STORAGE_KEYS.onlyUseSites
]);
getting.then(onGot, onError);

function onError(error) {
    console.log(`Error: ${error}`);
}

function updateTagsForSearch() {
	if (onlyUseSites) {
		searchSite = false;
		const matchedPair = searchPairs.find(pair =>
			hostnameMatchesSite(window.location.hostname, pair.site)
		);
		if (matchedPair) {
			searchSite = true;
			tagsForSearch = matchedPair.tag.split(',').map(tag => tag.trim()).filter(Boolean);
		}
	} else {
		tagsForSearch = searchPairs.flatMap(pair => pair.tag.split(',').map(tag => tag.trim()).filter(Boolean));
		searchSite = true;
	}
}

function onGot(item) {
	searchPairs = Array.isArray(item[STORAGE_KEYS.searchPairs]) ? item[STORAGE_KEYS.searchPairs] : [];
	urlRules = Array.isArray(item[STORAGE_KEYS.urlRules]) ? item[STORAGE_KEYS.urlRules] : [];
	textFilters = Array.isArray(item[STORAGE_KEYS.textFilters]) ? item[STORAGE_KEYS.textFilters] : [];
	enableTopBorder = !!item[STORAGE_KEYS.enableTopBorder];
	onlyUseSites = !!item[STORAGE_KEYS.onlyUseSites];
	updateTagsForSearch();
	// Start processing links now that settings are loaded
	try { initProcessing(); } catch (e) { /* initProcessing may be defined later */ }
}

// Listen for storage changes and update settings dynamically
browser.storage.onChanged.addListener((changes, areaName) => {
	if (areaName !== "local") return;

	let needsRefresh = false;

	if (changes[STORAGE_KEYS.searchPairs]) {
		searchPairs = Array.isArray(changes[STORAGE_KEYS.searchPairs].newValue) ? changes[STORAGE_KEYS.searchPairs].newValue : [];
		needsRefresh = true;
	}

	if (changes[STORAGE_KEYS.urlRules]) {
		urlRules = Array.isArray(changes[STORAGE_KEYS.urlRules].newValue) ? changes[STORAGE_KEYS.urlRules].newValue : [];
		needsRefresh = true;
	}

	if (changes[STORAGE_KEYS.textFilters]) {
		textFilters = Array.isArray(changes[STORAGE_KEYS.textFilters].newValue) ? changes[STORAGE_KEYS.textFilters].newValue : [];
		textFilterCache.clear();
		needsRefresh = true;
	}

	if (changes[STORAGE_KEYS.enableTopBorder]) {
		enableTopBorder = !!changes[STORAGE_KEYS.enableTopBorder].newValue;
	}

	if (changes[STORAGE_KEYS.onlyUseSites]) {
		onlyUseSites = !!changes[STORAGE_KEYS.onlyUseSites].newValue;
		updateTagsForSearch();
		needsRefresh = true;
	}

	if (needsRefresh && (changes[STORAGE_KEYS.searchPairs] || changes[STORAGE_KEYS.onlyUseSites])) {
		updateTagsForSearch();
	}

	if (needsRefresh && searchSite) {
		sendAllHrefs();
		applyTextFilters();
	}
});

// Caches for performance optimization
const urlNormalizationCache = new Map(); // href -> normalized href
const textFilterCache = new Map(); // element -> normalized text

// Link map state
let linkMap = new Map(); // normalizedHref -> [link elements]
let linkStatusMap = new Map(); // normalizedHref -> { seen, blocked, favorited }
let processedHrefs = new Set();
let observer = null;
let pendingObservedHrefs = new Set();
let mutationDebounceTimer = null;
const mutationDebounceDelay = 200;
const statusClasses = {
	blocked: 'be-bookmarks-enhancer-blocked',
	favorited: 'be-bookmarks-enhancer-favorited',
	seen: 'be-bookmarks-enhancer-seen',
	textFiltered: 'be-bookmarks-enhancer-text-filtered'
};
const statusClassNames = Object.values(statusClasses);

function requestBookmarkStatuses(hrefs) {
	if (!hrefs || !hrefs.length) return;
	browser.runtime.sendMessage({ hrefs }).then(applyBookmarkStyling).catch(onError);
}

function injectBookmarkStyles() {
	if (document.getElementById('bookmarks-enhancer-styles')) return;

	const style = document.createElement('style');
	style.id = 'bookmarks-enhancer-styles';
	style.textContent = `
		.${statusClasses.blocked} {
			display: none !important;
		}

		.${statusClasses.favorited} {
			text-decoration-line: underline !important;
			text-decoration-style: double !important;
		}

		.${statusClasses.seen} {
			text-decoration-line: underline !important;
			text-decoration-style: dashed !important;
		}

		.${statusClasses.textFiltered} {
			display: none !important;
		}
	`;
	(document.head || document.documentElement).appendChild(style);
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
				applyStatusClass(el, styleConfig.className);
			}
		}
	}

	applyLinkResults(bookmarkGroups.seen, getSeenStyleConfig());
	applyLinkResults(bookmarkGroups.favorited, getFavoritedStyleConfig());
	applyLinkResults(bookmarkGroups.blocked, getBlockedStyleConfig());

	// Then run the existing class-based element styling for configured tags
	for (const tag of tagsForSearch) {
		const elements = Array.from(document.getElementsByClassName(tag)).filter(el => {
			const style = window.getComputedStyle(el);
			const isHidden = style.display === 'none';
			return !isHidden && !hasStatusClass(el);
		});

		styleElementsForBookmarks(elements, bookmarkGroups);
	}

	// Apply text filters on the same tags
	applyTextFilters();
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
		{ type: 'blocked', bookmarks: bookmarkGroups.blocked, styleConfig: getBlockedStyleConfig() },
		{ type: 'favorited', bookmarks: bookmarkGroups.favorited, styleConfig: getFavoritedStyleConfig() },
		{ type: 'seen', bookmarks: bookmarkGroups.seen, styleConfig: getSeenStyleConfig() }
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
		let matchedClassName = findStatusClassFromLinks(element, stylePriority);

		if (!matchedClassName) {
			const text = element.textContent || "";
			const html = element.innerHTML || "";

			for (const group of stylePriority) {
				for (const bookmark of group.bookmarks) {
					if (elementMatchesBookmarkFallback(element, text, html, bookmark)) {
						matchedClassName = group.styleConfig.className;
						break;
					}
				}
				if (matchedClassName) {
					break;
				}
			}
		}

		if (matchedClassName) {
			applyStatusClass(element, matchedClassName);
		}
	}
}

function findStatusClassFromLinks(element, stylePriority) {
	const linkHrefs = getElementLinkHrefSet(element);
	if (linkHrefs.size === 0) return null;

	for (const group of stylePriority) {
		for (const bookmark of group.bookmarks) {
			if (linkHrefs.has(bookmark.normalized)) {
				return group.styleConfig.className;
			}
		}
	}

	return null;
}

function getElementLinkHrefSet(element) {
	const links = element instanceof HTMLAnchorElement
		? [element, ...element.querySelectorAll('a[href]')]
		: Array.from(element.querySelectorAll('a[href]'));
	const normalizedHrefs = new Set();

	for (const link of links) {
		const href = link.getAttribute('href') || link.href || '';
		if (!href) continue;

		const normalized = normalizeHrefForSearch(href);
		if (/^https?:/.test(normalized)) {
			normalizedHrefs.add(normalized);
		}
	}

	return normalizedHrefs;
}

function elementMatchesBookmarkFallback(element, text, html, bookmark) {
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
		className: statusClasses.blocked,
		border: "dashed red"
	};
}

function getFavoritedStyleConfig() {
	return {
		className: statusClasses.favorited,
		border: "double white"
	};
}

function getSeenStyleConfig() {
	return {
		className: statusClasses.seen,
		border: "dashed white"
	};
}

function applyStatusClass(element, className) {
	element.classList.remove(...statusClassNames);
	element.classList.add(className);
}

function hasStatusClass(element) {
	return statusClassNames.some(className => element.classList.contains(className));
}


function getMatchingTextFilters() {
	const currentHost = window.location.hostname;
	return textFilters.filter(filter =>
		hostnameMatchesSite(currentHost, filter.site)
	);
}

function applyTextFilters() {
	const matchingFilters = getMatchingTextFilters();
	if (matchingFilters.length === 0) return;

	for (const tag of tagsForSearch) {
		const elements = Array.from(document.getElementsByClassName(tag)).filter(el => {
			const style = window.getComputedStyle(el);
			const isHidden = style.display === 'none';
			return !isHidden && !hasStatusClass(el);
		});
		applyTextFiltersTo(elements, matchingFilters);
	}
}

function applyTextFiltersTo(elements, matchingFilters) {
	if (!elements || elements.length === 0) return;
	matchingFilters = matchingFilters || getMatchingTextFilters();
	if (matchingFilters.length === 0) return;

	for (const element of elements) {
		const style = window.getComputedStyle(element);
		if (style.display === 'none' || hasStatusClass(element)) continue;

		let normalizedText = textFilterCache.get(element);
		if (!normalizedText) {
			normalizedText = (element.textContent || "").toLowerCase();
			textFilterCache.set(element, normalizedText);
		}

		for (const filter of matchingFilters) {
			const filterTexts = filter.filterText
				.split(',')
				.map(text => text.trim())
				.filter(Boolean);

			for (const text of filterTexts) {
				if (normalizedText.includes(text.toLowerCase())) {
					applyStatusClass(element, statusClasses.textFiltered);
					break;
				}
			}

			if (hasStatusClass(element)) break;
		}
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

					// Collect newly added elements that match configured tags for text filtering
					if (tagsForSearch && tagsForSearch.length) {
						const elems = [];
						for (const tag of tagsForSearch) {
							try {
								if (node.classList && node.classList.contains(tag)) elems.push(node);
								const found = node.getElementsByClassName ? node.getElementsByClassName(tag) : [];
								for (const f of found) elems.push(f);
							} catch (e) { /* ignore DOM exceptions */ }
						}

						if (elems.length) {
							applyTextFiltersTo(elems, getMatchingTextFilters());
						}
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
		if (status.blocked) applyStatusClass(el, statusClasses.blocked);
		else if (status.favorited) applyStatusClass(el, statusClasses.favorited);
		else if (status.seen) applyStatusClass(el, statusClasses.seen);
	}
}

function initProcessing() {
	if (!searchSite) return;
	injectBookmarkStyles();
	// Build initial map and send unique hrefs
	sendUniqueHrefs();
	// Start observing for incremental additions
	startMutationObserver();
}
