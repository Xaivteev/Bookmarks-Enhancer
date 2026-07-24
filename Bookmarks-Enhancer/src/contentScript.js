if (!globalThis.__beContentScriptInstalled) {
globalThis.__beContentScriptInstalled = true;

// Storage keys: STORAGE_KEYS from utils.js

// Load settings from config
let searchPairs = [];
let classesForSearch = [];
let urlRules = [];
let preparedStyleRules = DEFAULT_STYLE_RULES.map(rule => ({ ...rule }));
let preparedTextRules = [];
let searchSite = true;
let enableTopBorder = false;
let enableDeepSearch = false;
let onlyUseSites = false;
let managedClassNames = [];
const urlNormalizationCache = createUrlNormalizationCache();

let getting = browser.storage.local.get([
    STORAGE_KEYS.searchPairs,
    STORAGE_KEYS.urlRules,
    STORAGE_KEYS.textRules,
    LEGACY_STORAGE_KEYS.textFilters,
    STORAGE_KEYS.styleRules,
    STORAGE_KEYS.enableTopBorder,
    STORAGE_KEYS.enableDeepSearch,
    STORAGE_KEYS.onlyUseSites
]);
getting.then(onGot, onError);

function onError(error) {
    console.log(`Error: ${error}`);
}

function refreshManagedClassNames() {
	managedClassNames = [
		...preparedStyleRules.map(rule => styleRuleClassName(rule)),
		...STALE_MANAGED_CLASS_NAMES
	];
}

function getStyleConfigById(styleId) {
	const index = preparedStyleRules.findIndex(rule => rule.id === styleId);
	if (index < 0) return null;
	const rule = preparedStyleRules[index];
	return {
		className: styleRuleClassName(rule),
		border: getStyleRuleBorder(rule),
		priority: index
	};
}

function getConfiguredClassGroups(pairs) {
	const classGroups = pairs.flatMap(pair => {
		const classes = typeof pair.classes === "string"
			? pair.classes
			: pair.tag;

		return typeof classes === "string"
			? classes.split(',').map(group => group.trim().replace(/\s+/g, ' ')).filter(Boolean)
			: [];
	});

	return Array.from(new Set(classGroups));
}

function updateClassesForSearch() {
	if (onlyUseSites) {
		const matchingPairs = searchPairs.filter(pair =>
			hostnameMatchesSite(window.location.hostname, pair.site)
		);
		searchSite = matchingPairs.length > 0;
		classesForSearch = getConfiguredClassGroups(matchingPairs);
	} else {
		classesForSearch = getConfiguredClassGroups(searchPairs);
		searchSite = true;
	}
}

function onGot(item) {
	searchPairs = Array.isArray(item[STORAGE_KEYS.searchPairs]) ? item[STORAGE_KEYS.searchPairs] : [];
	urlRules = Array.isArray(item[STORAGE_KEYS.urlRules]) ? item[STORAGE_KEYS.urlRules] : [];
	preparedStyleRules = migrateStyleRulesFromStorage(item);
	refreshManagedClassNames();
	preparedTextRules = preprocessTextRules(migrateTextRulesFromStorage(item));
	enableTopBorder = !!item[STORAGE_KEYS.enableTopBorder];
	enableDeepSearch = !!item[STORAGE_KEYS.enableDeepSearch];
	onlyUseSites = !!item[STORAGE_KEYS.onlyUseSites];
	updateClassesForSearch();
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

	if (changes[STORAGE_KEYS.styleRules]) {
		removeStatusClasses(managedClassNames);
		preparedStyleRules = migrateStyleRulesFromStorage({
			styleRules: changes[STORAGE_KEYS.styleRules].newValue
		});
		refreshManagedClassNames();
		injectBookmarkStyles();
		browser.storage.local.get([
			STORAGE_KEYS.textRules
		]).then(result => {
			preparedTextRules = preprocessTextRules(migrateTextRulesFromStorage(result));
			invalidateTextFilterCache();
			scheduleLocalAuthoritativeRefresh();
		}).catch(onError);
		invalidateUrlDependentCaches();
		needsRefresh = true;
	}

	if (changes[STORAGE_KEYS.textRules]) {
		browser.storage.local.get([
			STORAGE_KEYS.textRules
		]).then(result => {
			preparedTextRules = preprocessTextRules(migrateTextRulesFromStorage(result));
			invalidateTextFilterCache();
			scheduleLocalAuthoritativeRefresh();
		}).catch(onError);
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
		updateClassesForSearch();
		needsRefresh = true;
	}

	if (needsRefresh && (changes[STORAGE_KEYS.searchPairs] || changes[STORAGE_KEYS.onlyUseSites])) {
		updateClassesForSearch();
	}

	if (needsRefresh && searchSite) {
		scheduleLocalAuthoritativeRefresh();
	}
});

let localAuthoritativeRefreshTimer = null;
function scheduleLocalAuthoritativeRefresh() {
	if (localAuthoritativeRefreshTimer) {
		clearTimeout(localAuthoritativeRefreshTimer);
	}
	localAuthoritativeRefreshTimer = setTimeout(() => {
		localAuthoritativeRefreshTimer = null;
		if (searchSite) {
			performAuthoritativeRefresh();
		}
	}, 100);
}

// Caches for performance optimization
const textFilterCache = new Map(); // element -> normalized text

// Link map state
let linkMap = new Map(); // normalizedHref -> [link elements]
let linkStatusMap = new Map(); // normalizedHref -> status string
let processedHrefs = new Set();
let urlCacheGeneration = 0;
let observer = null;
let pendingObservedHrefs = new Set();
let mutationDebounceTimer = null;
let originalBodyBorderTop = null;
const mutationDebounceDelay = 200;

function removeStatusClasses(classNames) {
	const names = (classNames || []).filter(Boolean);
	const selector = names.map(className => `.${className}`).join(',');
	if (!selector) return;

	for (const element of document.querySelectorAll(selector)) {
		element.classList.remove(...names);
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

	removeStatusClasses(managedClassNames);
}

function invalidateTextFilterCache() {
	textFilterCache.clear();
	removeStatusClasses(managedClassNames);
}

function requestBookmarkStatuses(hrefs) {
	if (!hrefs || !hrefs.length) return;
	const requestGeneration = urlCacheGeneration;
	browser.runtime.sendMessage({ hrefs })
		.then(message => {
			if (requestGeneration !== urlCacheGeneration) return;
			if (message && message.error) {
				onError(message.error);
				return;
			}
			applyBookmarkStyling(message);
		})
		.catch(onError);
}

function injectBookmarkStyles() {
	let style = document.getElementById('bookmarks-enhancer-styles');
	if (!style) {
		style = document.createElement('style');
		style.id = 'bookmarks-enhancer-styles';
		(document.head || document.documentElement).appendChild(style);
	}
	style.textContent = buildStyleRulesCss(preparedStyleRules);
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

	// Host pages sometimes remove our stylesheet; refresh must recreate it.
	injectBookmarkStyles();

	urlCacheGeneration += 1;
	const refreshGeneration = urlCacheGeneration;
	buildLinkMap(true);
	const authoritativeLinkMap = linkMap;
	const allHrefs = Array.from(authoritativeLinkMap.keys());

	function applyAuthoritativeResults(message) {
		if (refreshGeneration !== urlCacheGeneration) return;

		// Failed lookups used to return empty statuses and wipe the page.
		if (message && message.error) {
			onError(message.error);
			return;
		}

		linkMap = authoritativeLinkMap;
		linkStatusMap = new Map();
		processedHrefs = new Set(allHrefs);
		pendingObservedHrefs = new Set();
		textFilterCache.clear();
		removeStatusClasses(managedClassNames);
		clearExtensionTopBorder();
		applyBookmarkStyling(message, true);

		// Pick up any links added while the authoritative request was running.
		sendUniqueHrefs();
	}

	if (allHrefs.length === 0) {
		applyAuthoritativeResults({ statuses: {} });
		return;
	}

	browser.runtime.sendMessage({ hrefs: allHrefs, authoritative: true })
		.then(applyAuthoritativeResults)
		.catch(onError);
}

function applyBookmarkStyling(message, includeHidden = false) {
	if (!searchSite) return;

	const statuses = message && message.statuses && typeof message.statuses === "object"
		? message.statuses
		: {};
	const statusLookup = buildBookmarkStatusLookup(statuses);

	for (const [normalized, status] of Object.entries(statuses)) {
		if (status === "none" || getStyleConfigById(status)) {
			linkStatusMap.set(normalized, status);
		}
	}

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

	// Then run the existing class-based element styling for configured classes
	for (const classGroup of classesForSearch) {
		const elements = Array.from(document.getElementsByClassName(classGroup)).filter(el => {
			if (hasStatusClass(el)) return false;
			if (includeHidden) return true;

			return window.getComputedStyle(el).display !== 'none';
		});

		styleElementsForBookmarks(elements, statusLookup);
	}

	// Apply text filters on the same classes
	applyTextFilters(includeHidden);
}

function buildBookmarkStatusLookup(statuses) {
	const statusLookup = new Map();

	for (const [normalized, status] of Object.entries(statuses)) {
		const style = getStyleConfigById(status);
		if (!style) continue;

		let path;
		try {
			path = new URL(normalized).pathname;
		} catch {
			continue;
		}

		statusLookup.set(normalized, {
			normalized,
			path,
			className: style.className,
			border: style.border,
			priority: style.priority
		});
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


function clearExtensionTopBorder() {
	if (originalBodyBorderTop === null || !document.body) return;

	document.body.style.borderTop = originalBodyBorderTop;
	originalBodyBorderTop = null;
}

function applyStatusClass(element, className) {
	if (!className) return;
	if (managedClassNames.length) {
		element.classList.remove(...managedClassNames);
	}
	element.classList.add(className);
}

function hasStatusClass(element) {
	return managedClassNames.some(className => element.classList.contains(className));
}

function preprocessTextRules(rules) {
	const normalized = normalizeTextRules(rules);
	return normalized.map(rule => {
		const style = getStyleConfigById(rule.style);
		if (!style) return null;
		return {
			site: rule.site,
			text: rule.text.toLowerCase(),
			styleId: rule.style,
			priority: style.priority,
			className: style.className
		};
	}).filter(Boolean)
		.sort((a, b) => a.priority - b.priority);
}

function getMatchingTextRules() {
	const currentHost = window.location.hostname;
	return preparedTextRules.filter(rule =>
		hostnameMatchesSite(currentHost, rule.site)
	);
}

function getTargetedClassElements(includeHidden = false) {
	const elements = [];
	for (const classGroup of classesForSearch) {
		for (const el of document.getElementsByClassName(classGroup)) {
			if (hasStatusClass(el)) continue;
			if (!includeHidden && window.getComputedStyle(el).display === 'none') continue;
			elements.push(el);
		}
	}
	return elements;
}

function applyTextFilters(includeHidden = false) {
	const matchingRules = getMatchingTextRules();
	if (matchingRules.length === 0 || !classesForSearch.length) return;
	applyTextRulesTo(getTargetedClassElements(includeHidden), matchingRules, includeHidden);
}

function applyTextRulesTo(elements, matchingRules, includeHidden = false) {
	if (!elements || elements.length === 0) return;
	matchingRules = matchingRules || getMatchingTextRules();
	if (matchingRules.length === 0) return;

	for (const element of elements) {
		if (hasStatusClass(element)) continue;
		if (!includeHidden && window.getComputedStyle(element).display === 'none') continue;

		let normalizedText = textFilterCache.get(element);
		if (!normalizedText) {
			normalizedText = (element.textContent || "").toLowerCase();
			textFilterCache.set(element, normalizedText);
		}

		for (const rule of matchingRules) {
			if (normalizedText.includes(rule.text)) {
				applyStatusClass(element, rule.className);
				break;
			}
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

					// Collect newly added elements that match configured classes for text filtering
					const matchingRules = getMatchingTextRules();
					if (matchingRules.length && classesForSearch && classesForSearch.length) {
						const elems = [];
						for (const classGroup of classesForSearch) {
							try {
								const requiredClasses = classGroup.split(/\s+/).filter(Boolean);
								if (
									node.classList &&
									requiredClasses.every(className => node.classList.contains(className))
								) {
									elems.push(node);
								}
								const found = node.getElementsByClassName
									? node.getElementsByClassName(classGroup)
									: [];
								for (const f of found) elems.push(f);
							} catch (e) { /* ignore DOM exceptions */ }
						}

						if (elems.length) {
							applyTextRulesTo(elems, matchingRules);
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
	if (!status || status === "none") return;
	const style = getStyleConfigById(status);
	if (!style) return;

	const els = linkMap.get(norm) || [];
	for (const el of els) {
		if (hasStatusClass(el)) continue;
		applyStatusClass(el, style.className);
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

} // end __beContentScriptInstalled install guard
