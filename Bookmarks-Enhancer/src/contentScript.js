// Storage key constants
const STORAGE_KEYS = {
	searchPairs: "searchPairs",
	urlRules: "urlRules",
	textFilters: "textFilters",
	enableTopBorder: "enableTopBorder",
	enableDeepSearch: "enableDeepSearch",
	onlyUseSites: "onlyUseSites"
};

// Load settings from config
let searchPairs = [];
let tagsForSearch = [];
let urlRules = [];
let preparedTextFilters = [];
let searchSite = true;
let enableTopBorder = false;
let enableDeepSearch = false;
let onlyUseSites = false;

let getting = browser.storage.local.get([
    STORAGE_KEYS.searchPairs,
    STORAGE_KEYS.urlRules,
    STORAGE_KEYS.textFilters,
    STORAGE_KEYS.enableTopBorder,
    STORAGE_KEYS.enableDeepSearch,
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
	preparedTextFilters = preprocessTextFilters(item[STORAGE_KEYS.textFilters]);
	enableTopBorder = !!item[STORAGE_KEYS.enableTopBorder];
	enableDeepSearch = !!item[STORAGE_KEYS.enableDeepSearch];
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
		invalidateUrlDependentCaches();
		needsRefresh = true;
	}

	if (changes[STORAGE_KEYS.textFilters]) {
		preparedTextFilters = preprocessTextFilters(changes[STORAGE_KEYS.textFilters].newValue);
		invalidateTextFilterCache();
		needsRefresh = true;
	}

	if (changes[STORAGE_KEYS.enableTopBorder]) {
		enableTopBorder = !!changes[STORAGE_KEYS.enableTopBorder].newValue;
		if (!enableTopBorder) {
			clearExtensionTopBorder();
		}
	}

	if (changes[STORAGE_KEYS.enableDeepSearch]) {
		enableDeepSearch = !!changes[STORAGE_KEYS.enableDeepSearch].newValue;
		invalidateUrlDependentCaches();
		needsRefresh = true;
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
let urlCacheGeneration = 0;
let observer = null;
let pendingObservedHrefs = new Set();
let mutationDebounceTimer = null;
let originalBodyBorderTop = null;
const mutationDebounceDelay = 200;
const statusClasses = {
	blocked: 'be-bookmarks-enhancer-blocked',
	favorited: 'be-bookmarks-enhancer-favorited',
	seen: 'be-bookmarks-enhancer-seen',
	textFiltered: 'be-bookmarks-enhancer-text-filtered'
};
const statusClassNames = Object.values(statusClasses);

function removeStatusClasses(classNames) {
	const selector = classNames.map(className => `.${className}`).join(',');
	if (!selector) return;

	for (const element of document.querySelectorAll(selector)) {
		element.classList.remove(...classNames);
	}
}

function invalidateUrlDependentCaches() {
	urlCacheGeneration += 1;
	urlNormalizationCache.clear();
	linkMap = new Map();
	linkStatusMap = new Map();
	processedHrefs = new Set();
	pendingObservedHrefs = new Set();

	if (mutationDebounceTimer) {
		clearTimeout(mutationDebounceTimer);
		mutationDebounceTimer = null;
	}

	removeStatusClasses([
		statusClasses.blocked,
		statusClasses.favorited,
		statusClasses.seen
	]);
}

function invalidateTextFilterCache() {
	textFilterCache.clear();
	removeStatusClasses([statusClasses.textFiltered]);
}

function requestBookmarkStatuses(hrefs) {
	if (!hrefs || !hrefs.length) return;
	const requestGeneration = urlCacheGeneration;
	browser.runtime.sendMessage({ hrefs })
		.then(message => {
			if (requestGeneration === urlCacheGeneration) {
				applyBookmarkStyling(message);
			}
		})
		.catch(onError);
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
		if (message.mode === "authoritative") {
			performAuthoritativeRefresh();
		} else {
			sendUniqueHrefs();
		}
	}
});

// Build a map of normalizedHref -> [link elements], filtering invalid/hidden links
function buildLinkMap(includeHidden = false) {
	linkMap = new Map();
	for (const link of document.links) {
		collectLink(link, includeHidden);
	}
}

function collectLink(link, includeHidden = false) {
	const href = link.getAttribute('href') || link.href || '';
	if (!href) return null;
	let normalized;
	try {
		normalized = normalizeHrefForSearch(href);
	} catch { return null; }

	if (!/^https?:/.test(normalized)) return null;

	if (!includeHidden) {
		const style = window.getComputedStyle(link);
		if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return null;
	}

	if (!linkMap.has(normalized)) linkMap.set(normalized, []);
	linkMap.get(normalized).push(link);
	return normalized;
}

function sendUniqueHrefs() {
	if (!searchSite) return; // skip if site not relevant
	buildLinkMap();
	const allHrefs = Array.from(linkMap.keys());
	for (const href of allHrefs) {
		if (linkStatusMap.has(href)) {
			applyCachedLinkStatus(href);
		}
	}
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

function performAuthoritativeRefresh() {
	if (!searchSite) return;

	urlCacheGeneration += 1;
	const refreshGeneration = urlCacheGeneration;
	buildLinkMap(true);
	const authoritativeLinkMap = linkMap;
	const allHrefs = Array.from(authoritativeLinkMap.keys());

	function applyAuthoritativeResults(message) {
		if (refreshGeneration !== urlCacheGeneration) return;

		linkMap = authoritativeLinkMap;
		linkStatusMap = new Map();
		processedHrefs = new Set(allHrefs);
		pendingObservedHrefs = new Set();
		textFilterCache.clear();
		removeStatusClasses(statusClassNames);
		clearExtensionTopBorder();
		applyBookmarkStyling(message, true);

		// Pick up any links added while the authoritative request was running.
		sendUniqueHrefs();
	}

	if (allHrefs.length === 0) {
		applyAuthoritativeResults({ seen: [], blocked: [], favorited: [] });
		return;
	}

	browser.runtime.sendMessage({ hrefs: allHrefs })
		.then(applyAuthoritativeResults)
		.catch(onError);
}

function applyBookmarkStyling(message, includeHidden = false) {
	if (!searchSite) return;

	const bookmarkGroups = {
		seen: normalizeBookmarks(message.seen),
		blocked: normalizeBookmarks(message.blocked),
		favorited: normalizeBookmarks(message.favorited)
	};
	const statusLookup = buildBookmarkStatusLookup(bookmarkGroups);

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

	for (const [normalized, status] of statusLookup) {
		const elements = linkMap.get(normalized) || [];
		for (const element of elements) {
			applyStatusClass(element, status.className);
		}
	}

	if (enableTopBorder) {
		const normalizedCurrentUrl = normalizeHrefForSearch(window.location.href);
		const currentStatus = statusLookup.get(normalizedCurrentUrl);
		if (currentStatus) {
			if (originalBodyBorderTop === null) {
				originalBodyBorderTop = document.body.style.borderTop;
			}
			document.body.style.borderTop = currentStatus.border;
		}
	}

	// Then run the existing class-based element styling for configured tags
	for (const tag of tagsForSearch) {
		const elements = Array.from(document.getElementsByClassName(tag)).filter(el => {
			if (hasStatusClass(el)) return false;
			if (includeHidden) return true;

			return window.getComputedStyle(el).display !== 'none';
		});

		styleElementsForBookmarks(elements, statusLookup);
	}

	// Apply text filters on the same tags
	applyTextFilters(includeHidden);
}

function normalizeBookmarks(bookmarks) {
	if (!bookmarks) return [];
	return bookmarks.map(b => ({
		url: b.url,
		normalized: normalizeHrefForSearch(b.url),
		path: new URL(b.url).pathname
	}));
}

function buildBookmarkStatusLookup(bookmarkGroups) {
	const stylePriority = [
		{ type: 'blocked', bookmarks: bookmarkGroups.blocked, styleConfig: getBlockedStyleConfig() },
		{ type: 'favorited', bookmarks: bookmarkGroups.favorited, styleConfig: getFavoritedStyleConfig() },
		{ type: 'seen', bookmarks: bookmarkGroups.seen, styleConfig: getSeenStyleConfig() }
	];
	const statusLookup = new Map();

	// Add lower priorities first so higher-priority statuses overwrite them.
	for (let priority = stylePriority.length - 1; priority >= 0; priority -= 1) {
		const group = stylePriority[priority];
		for (const bookmark of group.bookmarks) {
			statusLookup.set(bookmark.normalized, {
				normalized: bookmark.normalized,
				path: bookmark.path,
				className: group.styleConfig.className,
				border: group.styleConfig.border,
				priority
			});
		}
	}

	return statusLookup;
}

function styleElementsForBookmarks(elements, statusLookup) {
	const statusesByPriority = enableDeepSearch
		? Array.from(statusLookup.values()).sort((a, b) => a.priority - b.priority)
		: [];

	for (const element of elements) {
		let matchedClassName = findStatusClassFromLinks(element, statusLookup);

		if (enableDeepSearch && !matchedClassName) {
			const text = element.textContent || "";
			const html = element.innerHTML || "";

			for (const bookmark of statusesByPriority) {
				if (elementMatchesBookmarkFallback(element, text, html, bookmark)) {
					matchedClassName = bookmark.className;
					break;
				}
			}
		}

		if (matchedClassName) {
			applyStatusClass(element, matchedClassName);
		}
	}
}

function findStatusClassFromLinks(element, statusLookup) {
	const linkHrefs = getElementLinkHrefSet(element);
	if (linkHrefs.size === 0) return null;
	let matchedStatus = null;

	for (const href of linkHrefs) {
		const status = statusLookup.get(href);
		if (status && (!matchedStatus || status.priority < matchedStatus.priority)) {
			matchedStatus = status;
		}
	}

	return matchedStatus?.className || null;
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

function clearExtensionTopBorder() {
	if (originalBodyBorderTop === null || !document.body) return;

	document.body.style.borderTop = originalBodyBorderTop;
	originalBodyBorderTop = null;
}

function applyStatusClass(element, className) {
	element.classList.remove(...statusClassNames);
	element.classList.add(className);
}

function hasStatusClass(element) {
	return statusClassNames.some(className => element.classList.contains(className));
}


function preprocessTextFilters(filters) {
	if (!Array.isArray(filters)) return [];

	return filters.map(filter => ({
		site: typeof filter.site === "string" ? filter.site.trim().toLowerCase() : "",
		filterTexts: typeof filter.filterText === "string"
			? Array.from(new Set(
				filter.filterText
					.split(',')
					.map(text => text.trim().toLowerCase())
					.filter(Boolean)
			))
			: []
	})).filter(filter => filter.site && filter.filterTexts.length > 0);
}

function getMatchingTextFilters() {
	const currentHost = window.location.hostname;
	return preparedTextFilters.filter(filter =>
		hostnameMatchesSite(currentHost, filter.site)
	);
}

function applyTextFilters(includeHidden = false) {
	const matchingFilters = getMatchingTextFilters();
	if (matchingFilters.length === 0) return;

	for (const tag of tagsForSearch) {
		const elements = Array.from(document.getElementsByClassName(tag)).filter(el => {
			if (hasStatusClass(el)) return false;
			if (includeHidden) return true;

			return window.getComputedStyle(el).display !== 'none';
		});
		applyTextFiltersTo(elements, matchingFilters, includeHidden);
	}
}

function applyTextFiltersTo(elements, matchingFilters, includeHidden = false) {
	if (!elements || elements.length === 0) return;
	matchingFilters = matchingFilters || getMatchingTextFilters();
	if (matchingFilters.length === 0) return;

	for (const element of elements) {
		if (hasStatusClass(element)) continue;
		if (!includeHidden && window.getComputedStyle(element).display === 'none') continue;

		let normalizedText = textFilterCache.get(element);
		if (!normalizedText) {
			normalizedText = (element.textContent || "").toLowerCase();
			textFilterCache.set(element, normalizedText);
		}

		for (const filter of matchingFilters) {
			for (const text of filter.filterTexts) {
				if (normalizedText.includes(text)) {
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
		if (hasStatusClass(el)) continue;

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
