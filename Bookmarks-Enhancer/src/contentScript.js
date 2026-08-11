// Shared with utils.js (normalizeHrefForSearch). Must stay at content-script top
// level — not inside the install guard — or URL normalization throws ReferenceError.
var urlRules = urlRules || [];
var urlNormalizationCache = urlNormalizationCache || createUrlNormalizationCache();

if (!globalThis.__beContentScriptInstalled) {
globalThis.__beContentScriptInstalled = true;

// Storage keys: STORAGE_KEYS from utils.js

// Load settings from config
let searchPairs = [];
let classesForSearch = [];
let preparedStyleRules = DEFAULT_STYLE_RULES.map(rule => ({ ...rule }));
let preparedTextRules = [];
let searchSite = true;
let enableTopBorder = false;
let enableDeepSearch = false;
let onlyUseSites = false;
let managedClassNames = [];
// Defaults only include built-in ids (blocked/favorited/seen). Custom UUID styles
// arrive via storage — gate lookups until then so early requery cannot stick
// positives in processedHrefs that applyBookmarkStyling silently skips.
let settingsLoaded = false;
let pendingRuntimeMessages = [];

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
	settingsLoaded = true;
	// Start processing links now that settings are loaded
	try { initProcessing(); } catch (e) { /* initProcessing may be defined later */ }
	flushPendingRuntimeMessages();
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
let processedHrefs = new Set(); // positive resolutions only
// Soft "none" results — skipped on ordinary scans to avoid message spam, cleared
// on requery / visibility / authoritative so folder re-checks can recover.
let softMissHrefs = new Set();
let pendingStatusHrefs = new Set(); // in-flight lookups; not yet successfully processed
let urlCacheGeneration = 0;
let observer = null;
let pendingObservedHrefs = new Set();
let mutationDebounceTimer = null;
let originalBodyBorderTop = null;
let visibilityListenersAttached = false;
let pageWasHidden = typeof document !== "undefined" && document.visibilityState === "hidden";
let visibilityRescanTimer = null;
let lookupRetryTimer = null;
let lookupRetryHrefs = new Set();
let lookupRetryAttempt = 0;
let warmupRescanTimers = [];

function isResolvableStyleId(styleId) {
	return !!(styleId && styleId !== "none" && getStyleConfigById(styleId));
}

// Only mark processed when the style id is resolvable; otherwise keep retryable
// and remember the status so a later styleRules load can apply it.
function rememberPositiveStatus(href, status) {
	if (!href || !status || status === "none") return false;
	linkStatusMap.set(href, status);
	if (isResolvableStyleId(status)) {
		softMissHrefs.delete(href);
		processedHrefs.add(href);
		return true;
	}
	processedHrefs.delete(href);
	// Settings are loaded but this id is unknown (dangling reference) — avoid
	// a lookup spin. A later styleRules change triggers a full refresh.
	if (settingsLoaded) {
		softMissHrefs.add(href);
	}
	return false;
}

function reapplyStoredLinkStatuses(includeHidden = false) {
	if (!searchSite || linkStatusMap.size === 0) return;
	buildLinkMap(includeHidden);
	const statuses = {};
	for (const [href, status] of linkStatusMap) {
		if (status && status !== "none") statuses[href] = status;
	}
	if (Object.keys(statuses).length === 0) return;
	applyBookmarkStyling({ statuses }, includeHidden);
}

function enqueueRuntimeMessage(message) {
	pendingRuntimeMessages.push(message);
}

function flushPendingRuntimeMessages() {
	if (!settingsLoaded || pendingRuntimeMessages.length === 0) return;
	const queued = pendingRuntimeMessages.slice();
	pendingRuntimeMessages = [];
	for (const message of queued) {
		handleRuntimeMessage(message);
	}
}

const STYLING_INDICATOR_DELAY_MS = 300;
const STYLING_INDICATOR_HOST_ID = "bookmarks-enhancer-loading";
let stylingIndicatorDepth = 0;
let stylingIndicatorShowTimer = null;
let stylingIndicatorHost = null;

function beginStylingIndicator() {
	stylingIndicatorDepth += 1;
	if (stylingIndicatorDepth !== 1) return;
	if (stylingIndicatorShowTimer) return;
	stylingIndicatorShowTimer = setTimeout(() => {
		stylingIndicatorShowTimer = null;
		if (stylingIndicatorDepth > 0) {
			showStylingIndicator();
		}
	}, STYLING_INDICATOR_DELAY_MS);
}

function endStylingIndicator() {
	if (stylingIndicatorDepth <= 0) return;
	stylingIndicatorDepth -= 1;
	if (stylingIndicatorDepth > 0) return;
	if (stylingIndicatorShowTimer) {
		clearTimeout(stylingIndicatorShowTimer);
		stylingIndicatorShowTimer = null;
	}
	hideStylingIndicator();
}

function showStylingIndicator() {
	if (stylingIndicatorHost?.isConnected) {
		stylingIndicatorHost.hidden = false;
		return;
	}

	const existing = document.getElementById(STYLING_INDICATOR_HOST_ID);
	if (existing) {
		existing.remove();
	}

	const host = document.createElement("div");
	host.id = STYLING_INDICATOR_HOST_ID;
	host.setAttribute("data-be-styling-indicator", "host");
	host.setAttribute("role", "status");
	host.setAttribute("aria-live", "polite");
	host.style.cssText = [
		"all: initial",
		"position: fixed",
		"z-index: 2147483646",
		"right: 16px",
		"bottom: 16px",
		"pointer-events: none"
	].join(";");

	const shadow = host.attachShadow({ mode: "open" });
	const style = document.createElement("style");
	style.textContent = `
		:host {
			display: block !important;
		}
		.toast {
			display: flex;
			align-items: center;
			gap: 8px;
			max-width: min(280px, calc(100vw - 32px));
			padding: 10px 12px;
			border: 1px solid #475569;
			border-radius: 8px;
			background: #0f172a;
			color: #f8fafc;
			box-shadow: 0 10px 28px rgb(0 0 0 / 35%);
			font: 13px/1.35 system-ui, -apple-system, sans-serif;
		}
		.spinner {
			box-sizing: border-box;
			width: 14px;
			height: 14px;
			flex: 0 0 auto;
			border: 2px solid #94a3b8;
			border-top-color: #f8fafc;
			border-radius: 50%;
			animation: be-spin 0.7s linear infinite;
		}
		@keyframes be-spin {
			to { transform: rotate(360deg); }
		}
	`;

	const toast = document.createElement("div");
	toast.className = "toast";

	const spinner = document.createElement("div");
	spinner.className = "spinner";
	spinner.setAttribute("aria-hidden", "true");

	const label = document.createElement("span");
	label.textContent = "Applying bookmark styles…";

	toast.append(spinner, label);
	shadow.append(style, toast);

	const root = document.documentElement || document.body;
	if (!root) return;
	root.appendChild(host);
	stylingIndicatorHost = host;
}

function hideStylingIndicator() {
	if (!stylingIndicatorHost) {
		const existing = document.getElementById(STYLING_INDICATOR_HOST_ID);
		if (existing) existing.remove();
		return;
	}
	stylingIndicatorHost.remove();
	stylingIndicatorHost = null;
}

function notifyRefreshBusyComplete(actionBusyGeneration) {
	browser.runtime.sendMessage({
		refreshBusyComplete: true,
		actionBusyGeneration
	}).catch(() => {});
}

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
	softMissHrefs = new Set();
	pendingStatusHrefs = new Set();
	pendingObservedHrefs = new Set();
	lookupRetryHrefs = new Set();
	lookupRetryAttempt = 0;
	if (lookupRetryTimer) {
		clearTimeout(lookupRetryTimer);
		lookupRetryTimer = null;
	}

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

function scheduleLookupRetry(hrefs) {
	if (!hrefs || !hrefs.length) return;
	for (const href of hrefs) {
		if (href) lookupRetryHrefs.add(href);
	}
	if (lookupRetryTimer || lookupRetryHrefs.size === 0) return;

	const delay = Math.min(8000, 400 * (2 ** Math.min(lookupRetryAttempt, 4)));
	lookupRetryAttempt += 1;
	lookupRetryTimer = setTimeout(() => {
		lookupRetryTimer = null;
		const batch = Array.from(lookupRetryHrefs);
		lookupRetryHrefs = new Set();
		for (const href of batch) {
			softMissHrefs.delete(href);
			pendingStatusHrefs.delete(href);
		}
		requestBookmarkStatuses(batch, { force: true });
	}, delay);
}

function clearSoftMissesAndRescan(options = {}) {
	if (!searchSite) return;
	softMissHrefs = new Set();
	sendUniqueHrefs({ includeHidden: true, ...options });
}

function scheduleWarmupRescans() {
	for (const timer of warmupRescanTimers) {
		clearTimeout(timer);
	}
	warmupRescanTimers = [];
	// Cold SW / folder index often settles shortly after first paint when the
	// Firefox window was just focused. Retry soft misses without waiting for
	// another visibility edge.
	for (const delay of [1200, 3500]) {
		warmupRescanTimers.push(setTimeout(() => {
			clearSoftMissesAndRescan();
		}, delay));
	}
}

function requestBookmarkStatuses(hrefs, options = {}) {
	if (!hrefs || !hrefs.length) return;

	const unique = [];
	for (const href of hrefs) {
		if (!href) continue;
		if (pendingStatusHrefs.has(href)) continue;
		if (!options.force && (processedHrefs.has(href) || softMissHrefs.has(href))) continue;
		pendingStatusHrefs.add(href);
		unique.push(href);
	}
	if (!unique.length) return;

	const showLoading = !!options.showLoading;
	if (showLoading) beginStylingIndicator();
	const requestGeneration = urlCacheGeneration;

	const releasePending = () => {
		for (const href of unique) {
			pendingStatusHrefs.delete(href);
		}
	};

	browser.runtime.sendMessage({ hrefs: unique })
		.then(message => {
			if (requestGeneration !== urlCacheGeneration) {
				releasePending();
				return;
			}
			if (message && message.error) {
				releasePending();
				onError(message.error);
				// Cold SW / index build races often surface as errors; retry shortly.
				scheduleLookupRetry(unique);
				return;
			}

			const statuses = message && message.statuses && typeof message.statuses === "object"
				? message.statuses
				: {};
			const partial = !!(message && message.partial);
			let sawPositive = false;

			for (const href of unique) {
				pendingStatusHrefs.delete(href);
				// Partial responses omit URLs still in unmatched search; keep those
				// pending until statusUpdates arrives so we do not stick on "none".
				if (!partial || Object.prototype.hasOwnProperty.call(statuses, href)) {
					const status = statuses[href];
					if (status && status !== "none") {
						if (rememberPositiveStatus(href, status)) {
							sawPositive = true;
						}
					} else {
						// Soft miss — retry on requery / visibility / index-ready.
						softMissHrefs.add(href);
						processedHrefs.delete(href);
						linkStatusMap.delete(href);
					}
				} else {
					pendingStatusHrefs.add(href);
				}
			}
			if (sawPositive) {
				lookupRetryAttempt = 0;
			}
			applyBookmarkStyling(message);
		})
		.catch(error => {
			releasePending();
			onError(error);
			scheduleLookupRetry(unique);
		})
		.finally(() => {
			if (showLoading) endStylingIndicator();
		});
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

function isRevealHidden() {
	return document.documentElement.classList.contains(REVEAL_HIDDEN_CLASS);
}

function setRevealHidden(enabled) {
	document.documentElement.classList.toggle(REVEAL_HIDDEN_CLASS, !!enabled);
	return isRevealHidden();
}

function toggleRevealHidden() {
	return setRevealHidden(!isRevealHidden());
}

// Listen for explicit refresh messages from backgroundScript
browser.runtime.onMessage.addListener(message => {
	if (message && message.toggleRevealHidden) {
		return Promise.resolve({ revealHidden: toggleRevealHidden() });
	}

	if (message && message.getRevealHidden) {
		return Promise.resolve({ revealHidden: isRevealHidden() });
	}

	if (message && typeof message.setRevealHidden === "boolean") {
		return Promise.resolve({ revealHidden: setRevealHidden(message.setRevealHidden) });
	}

	if (
		message &&
		(message.bookmarkIndexReady || message.statusUpdates || message.refresh)
	) {
		// Early tabs.onUpdated requery can beat storage.local.get; queue until
		// custom styleRules are loaded so UUID statuses are resolvable.
		if (!settingsLoaded) {
			enqueueRuntimeMessage(message);
			return;
		}
		handleRuntimeMessage(message);
	}
});

function handleRuntimeMessage(message) {
	if (!message) return;

	if (message.bookmarkIndexReady) {
		// Folder index settled after SW wake — retry soft misses cheaply.
		clearSoftMissesAndRescan();
		reapplyStoredLinkStatuses(true);
		return;
	}

	if (message.statusUpdates) {
		if (!searchSite) return;
		buildLinkMap(true);
		const classNames = managedClassNames.filter(Boolean);
		for (const [href, status] of Object.entries(message.statusUpdates)) {
			pendingStatusHrefs.delete(href);
			if (status && status !== "none") {
				rememberPositiveStatus(href, status);
			} else {
				softMissHrefs.add(href);
				processedHrefs.delete(href);
				linkStatusMap.delete(href);
			}
			const links = linkMap.get(href) || [];
			for (const link of links) {
				if (classNames.length) link.classList.remove(...classNames);
			}
		}
		applyBookmarkStyling({
			statuses: Object.fromEntries(linkStatusMap)
		}, true);
		return;
	}

	if (message.refresh) {
		if (message.mode === "authoritative") {
			performAuthoritativeRefresh({
				showActionBusy: !!message.showActionBusy,
				actionBusyGeneration: message.actionBusyGeneration,
				authoritativeLookup: true
			});
		} else if (message.mode === "rebuild") {
			// Background already wiped caches and rebuilt the index once.
			performAuthoritativeRefresh({
				showActionBusy: !!message.showActionBusy,
				actionBusyGeneration: message.actionBusyGeneration,
				authoritativeLookup: false
			});
		} else if (message.mode === "requery") {
			performRequeryRefresh();
		} else {
			sendUniqueHrefs();
		}
	}
}

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

function sendUniqueHrefs(options = {}) {
	if (!searchSite) return; // skip if site not relevant
	buildLinkMap(!!options.includeHidden);
	const allHrefs = Array.from(linkMap.keys());
	for (const href of allHrefs) {
		if (linkStatusMap.has(href)) {
			applyCachedLinkStatus(href);
		}
	}
	const newHrefs = allHrefs.filter(h =>
		!processedHrefs.has(h) &&
		!softMissHrefs.has(h) &&
		!pendingStatusHrefs.has(h)
	);
	if (newHrefs.length === 0) return;
	requestBookmarkStatuses(newHrefs, options);
}

function sendAllHrefs() {
	if (!searchSite) return;
	buildLinkMap();
	const allHrefs = Array.from(linkMap.keys());
	requestBookmarkStatuses(allHrefs, { force: true });
}

// Soft re-resolve after background cleared this tab's statuses (navigate/load).
// Re-asks even for hrefs previously recorded as soft misses.
function performRequeryRefresh() {
	if (!searchSite) return;

	buildLinkMap();
	processedHrefs = new Set();
	softMissHrefs = new Set();
	pendingStatusHrefs = new Set();
	for (const [href, status] of Array.from(linkStatusMap.entries())) {
		if (!status || status === "none") {
			linkStatusMap.delete(href);
		} else {
			applyCachedLinkStatus(href);
		}
	}

	const allHrefs = Array.from(linkMap.keys());
	if (allHrefs.length === 0) return;
	requestBookmarkStatuses(allHrefs, { force: true });
}

function performAuthoritativeRefresh(options = {}) {
	const showActionBusy = !!options.showActionBusy;
	const actionBusyGeneration = options.actionBusyGeneration;
	const authoritativeLookup = options.authoritativeLookup !== false;
	const finishBusy = () => {
		endStylingIndicator();
		if (showActionBusy) {
			notifyRefreshBusyComplete(actionBusyGeneration);
		}
	};

	if (!searchSite) {
		if (showActionBusy) notifyRefreshBusyComplete(actionBusyGeneration);
		return;
	}

	// Host pages sometimes remove our stylesheet; refresh must recreate it.
	injectBookmarkStyles();

	urlCacheGeneration += 1;
	const refreshGeneration = urlCacheGeneration;
	softMissHrefs = new Set();
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

		const statuses = message && message.statuses && typeof message.statuses === "object"
			? message.statuses
			: {};
		const partial = !!(message && message.partial);

		linkMap = authoritativeLinkMap;
		linkStatusMap = new Map();
		pendingObservedHrefs = new Set();
		softMissHrefs = new Set();
		textFilterCache.clear();
		removeStatusClasses(managedClassNames);
		clearExtensionTopBorder();

		processedHrefs = new Set();
		pendingStatusHrefs = new Set();
		for (const href of allHrefs) {
			if (!Object.prototype.hasOwnProperty.call(statuses, href)) {
				if (partial) pendingStatusHrefs.add(href);
				else softMissHrefs.add(href);
				continue;
			}
			const status = statuses[href];
			if (status && status !== "none") {
				rememberPositiveStatus(href, status);
			} else {
				softMissHrefs.add(href);
			}
		}

		applyBookmarkStyling(message, true);

		// Pick up any links added while the authoritative request was running.
		sendUniqueHrefs();
	}

	// No links yet — keep existing styles instead of wiping to empty.
	if (allHrefs.length === 0) {
		if (showActionBusy) notifyRefreshBusyComplete(actionBusyGeneration);
		return;
	}

	beginStylingIndicator();
	const payload = authoritativeLookup
		? { hrefs: allHrefs, authoritative: true }
		: { hrefs: allHrefs };
	browser.runtime.sendMessage(payload)
		.then(applyAuthoritativeResults)
		.catch(onError)
		.finally(finishBusy);
}

function applyBookmarkStyling(message, includeHidden = false) {
	if (!searchSite) return;

	const statuses = message && message.statuses && typeof message.statuses === "object"
		? message.statuses
		: {};
	const statusLookup = buildBookmarkStatusLookup(statuses);

	for (const [normalized, status] of Object.entries(statuses)) {
		if (status && status !== "none" && getStyleConfigById(status)) {
			linkStatusMap.set(normalized, status);
			softMissHrefs.delete(normalized);
			processedHrefs.add(normalized);
		} else if (status === "none") {
			linkStatusMap.delete(normalized);
			softMissHrefs.add(normalized);
			processedHrefs.delete(normalized);
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
		if (
			!processedHrefs.has(norm) &&
			!softMissHrefs.has(norm) &&
			!pendingStatusHrefs.has(norm)
		) {
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

function scheduleVisibilityRescan() {
	if (visibilityRescanTimer) return;
	visibilityRescanTimer = setTimeout(() => {
		visibilityRescanTimer = null;
		performVisibilityRescan();
	}, 100);
}

function performVisibilityRescan() {
	if (!searchSite) return;
	if (document.visibilityState === "hidden") return;

	// Retry soft misses: a prior pass may have resolved before the folder index
	// was complete. Background re-checks the folder map cheaply.
	clearSoftMissesAndRescan();
}

function onVisibilityChange() {
	if (document.visibilityState === "hidden") {
		pageWasHidden = true;
		return;
	}
	if (!pageWasHidden) return;
	pageWasHidden = false;
	scheduleVisibilityRescan();
}

function onPageShow(event) {
	if (document.visibilityState === "hidden") {
		pageWasHidden = true;
		return;
	}
	// bfcache restore, or a background tab that becomes usable on show.
	if (event.persisted || pageWasHidden) {
		pageWasHidden = false;
		scheduleVisibilityRescan();
	}
}

function onWindowFocus() {
	// Focusing the Firefox window does not always flip document.visibilityState
	// when this tab was already the active tab in a backgrounded window.
	if (document.visibilityState === "hidden") {
		pageWasHidden = true;
		return;
	}
	if (softMissHrefs.size === 0 && lookupRetryHrefs.size === 0) return;
	scheduleVisibilityRescan();
}

function ensureVisibilityRescanListeners() {
	if (visibilityListenersAttached) return;
	visibilityListenersAttached = true;
	document.addEventListener("visibilitychange", onVisibilityChange);
	window.addEventListener("pageshow", onPageShow);
	window.addEventListener("focus", onWindowFocus);
}

function initProcessing() {
	if (!searchSite) return;
	injectBookmarkStyles();
	ensureVisibilityRescanListeners();
	// Build initial map and send unique hrefs
	sendUniqueHrefs({ showLoading: true });
	// Start observing for incremental additions
	startMutationObserver();
	scheduleWarmupRescans();

	// Background tabs often finish the first scan while still hidden; rescan
	// once when the user first focuses the tab.
	if (document.visibilityState === "hidden") {
		pageWasHidden = true;
	}
}

} // end __beContentScriptInstalled install guard
