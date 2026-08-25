// Bookmark import/export helpers live in utilsSitesExtra.js and are not injected here.
var urlRules = urlRules || [];
var urlNormalizationCache = urlNormalizationCache || createUrlNormalizationCache();
setHrefNormalizationContext(urlRules, urlNormalizationCache);

if (!globalThis.__beContentScriptInstalled) {
globalThis.__beContentScriptInstalled = true;

// Storage keys: STORAGE_KEYS from utils.js

// Load settings from config
let loadedSites = [];
let classesForSearch = [];
let preparedStyleRules = DEFAULT_STYLE_RULES.map(rule => ({ ...rule }));
let styleConfigById = new Map();
let managedClassNames = [];
let managedClassNameSet = new Set();
let preparedTextRules = [];
let searchSite = true;
let enableTopBorder = false;
let enableDeepSearch = false;
let enableToastNotifications = true;
let enableDuplicateWarning = false;
// Defaults only include built-in ids (blocked/favorited/seen). Custom UUID styles
// arrive via storage — gate lookups until then so early requery cannot stick
// positives in processedHrefs that applyBookmarkStyling silently skips.
let settingsLoaded = false;
let pendingRuntimeMessages = [];

const CONTENT_SETTINGS_KEYS = [
	STORAGE_KEYS.sites,
	LEGACY_STORAGE_KEYS.searchPairs,
	LEGACY_STORAGE_KEYS.urlRules,
	LEGACY_STORAGE_KEYS.textRules,
	LEGACY_STORAGE_KEYS.textFilters,
	STORAGE_KEYS.styleRules,
	STORAGE_KEYS.enableTopBorder,
	STORAGE_KEYS.enableDeepSearch,
	STORAGE_KEYS.enableToastNotifications,
	STORAGE_KEYS.enableDuplicateWarning
];

function loadContentSettings() {
	return browser.storage.local.get(CONTENT_SETTINGS_KEYS);
}

function requestPageRunState() {
	return browser.runtime.sendMessage({
		getPageRunState: true,
		url: location.href
	}).catch(() => ({
		siteMatch: true,
		runStyling: true,
		runShortcuts: false
	}));
}

function startContentScript() {
	requestPageRunState().then(state => {
		if (!state || !state.runStyling) {
			searchSite = false;
			settingsLoaded = true;
			flushPendingRuntimeMessages();
			return;
		}
		return loadContentSettings().then(onGot, onError);
	}).catch(onError);
}

startContentScript();

function refreshManagedClassNames() {
	styleConfigById = new Map();
	managedClassNames = [];
	for (let index = 0; index < preparedStyleRules.length; index++) {
		const rule = preparedStyleRules[index];
		if (!rule?.id) continue;
		const className = styleRuleClassName(rule);
		styleConfigById.set(rule.id, {
			className,
			border: getStyleRuleBorder(rule),
			priority: index
		});
		if (className) managedClassNames.push(className);
	}
	for (const className of STALE_MANAGED_CLASS_NAMES) {
		if (className) managedClassNames.push(className);
	}
	managedClassNameSet = new Set(managedClassNames);
}

function getStyleConfigById(styleId) {
	if (!styleId) return null;
	return styleConfigById.get(styleId) || null;
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

refreshManagedClassNames();

function updateClassesForSearch() {
	const host = normalizeSite(window.location.hostname);
	const matchingSites = loadedSites.filter(siteConfig =>
		hostnameMatchesNormalized(host, siteConfig.site)
	);
	searchSite = matchingSites.length > 0;
	classesForSearch = getConfiguredClassGroups(sitesToSearchPairs(matchingSites));
}

function classGroupsFromSiteConfig(siteConfig) {
	const raw = siteConfig?.classGroups;
	if (Array.isArray(raw)) return raw;
	if (typeof raw === "string") return raw.split(",");
	return [];
}

function applySitesConfig(item) {
	const raw = Array.isArray(item?.[STORAGE_KEYS.sites])
		? item[STORAGE_KEYS.sites]
		: (Array.isArray(item?.sites) ? item.sites : []);
	loadedSites = raw.map(siteConfig => ({
		site: siteConfig?.site || "",
		classGroups: classGroupsFromSiteConfig(siteConfig),
		keepParams: typeof siteConfig?.keepParams === "string" ? siteConfig.keepParams : "",
		textRules: Array.isArray(siteConfig?.textRules) ? siteConfig.textRules : [],
		linkFolders: Array.isArray(siteConfig?.linkFolders) ? siteConfig.linkFolders : []
	})).filter(siteConfig => siteConfig.site);
	urlRules = sitesToUrlRules(loadedSites);
	setHrefNormalizationContext(urlRules, urlNormalizationCache);
	preparedTextRules = preprocessTextRules(sitesToTextRules(loadedSites));
	updateClassesForSearch();
}

function applyLoadedSettings(item) {
	preparedStyleRules = migrateStyleRulesFromStorage(item);
	refreshManagedClassNames();
	enableTopBorder = !!item[STORAGE_KEYS.enableTopBorder];
	enableDeepSearch = !!item[STORAGE_KEYS.enableDeepSearch];
	enableToastNotifications = item[STORAGE_KEYS.enableToastNotifications] !== false;
	enableDuplicateWarning = !!item[STORAGE_KEYS.enableDuplicateWarning];
	applySitesConfig(item);
	settingsLoaded = true;
}

function onGot(item) {
	applyLoadedSettings(item);
	try { initProcessing(); } catch (e) { /* initProcessing may be defined later */ }
	flushPendingRuntimeMessages();
}

function stopPageProcessing() {
	searchSite = false;
	if (observer) {
		observer.disconnect();
		observer = null;
	}
	if (mutationFrameId) {
		cancelAnimationFrame(mutationFrameId);
		mutationFrameId = 0;
	}
	pendingAddedNodes = [];
	pendingAddedOffset = 0;
	pendingObservedHrefs = new Set();
	pendingObservedTextElements = new Set();
	if (mutationDebounceTimer) {
		clearTimeout(mutationDebounceTimer);
		mutationDebounceTimer = null;
	}
	clearWarmupRescanTimer();
	initScanHref = "";
	if (lookupRetryTimer) {
		clearTimeout(lookupRetryTimer);
		lookupRetryTimer = null;
	}
	if (typeof managedClassNames !== "undefined" && managedClassNames.length) {
		removeStatusClasses(managedClassNames);
	}
	if (typeof clearExtensionTopBorder === "function") {
		clearExtensionTopBorder();
	}
	clearDuplicateWarningPass();
	hideDuplicateWarningToast();
}

function reloadContentSettings() {
	return requestPageRunState().then(state => {
		if (!state || !state.runStyling) {
			stopPageProcessing();
			settingsLoaded = true;
			return;
		}

		return loadContentSettings().then(item => {
			const previousClassNames = managedClassNames.slice();
			applyLoadedSettings(item);
			if (!searchSite) {
				stopPageProcessing();
				return;
			}
			if (!enableTopBorder) {
				clearExtensionTopBorder();
			}
			if (!enableToastNotifications) {
				stylingIndicatorDepth = 0;
				if (stylingIndicatorShowTimer) {
					clearTimeout(stylingIndicatorShowTimer);
					stylingIndicatorShowTimer = null;
				}
				hideStylingIndicator();
			}
			if (!enableDuplicateWarning) {
				hideDuplicateWarningToast();
			}
			removeStatusClasses(previousClassNames);
			injectBookmarkStyles();
			invalidateUrlDependentCaches();
			invalidateTextFilterCache();
		});
	}).catch(onError);
}

function handleConfigRefresh(message) {
	if (message.mode === "authoritative") {
		return performAuthoritativeRefresh({
			showActionBusy: !!message.showActionBusy,
			actionBusyGeneration: message.actionBusyGeneration,
			authoritativeLookup: true
		});
	}
	if (message.mode === "rebuild") {
		return performAuthoritativeRefresh({
			showActionBusy: !!message.showActionBusy,
			actionBusyGeneration: message.actionBusyGeneration,
			authoritativeLookup: false
		});
	}
	if (message.mode === "requery") {
		performRequeryRefresh();
		return Promise.resolve();
	}
	sendUniqueHrefs();
	return Promise.resolve();
}

// Caches for performance optimization
const textFilterCache = new Map(); // element -> normalized text

// Link map state
let linkMap = new Map(); // normalizedHref -> [link elements]
let linkStatusMap = new Map(); // normalizedHref -> status string
let processedHrefs = new Set(); // positive resolutions only
// Soft "none" results — skipped on ordinary scans to avoid message spam, cleared
// on requery / warmup / authoritative so later folder re-checks can recover.
let softMissHrefs = new Set();
let pendingStatusHrefs = new Set(); // in-flight lookups; not yet successfully processed
let urlCacheGeneration = 0;
let observer = null;
let pendingObservedHrefs = new Set();
let pendingObservedTextElements = new Set();
let pendingAddedNodes = [];
let pendingAddedOffset = 0;
let mutationFrameId = 0;
let mutationDebounceTimer = null;
let originalBodyBorderTop = null;
let visibilityListenersAttached = false;
let pageWasHidden = typeof document !== "undefined" && document.visibilityState === "hidden";
let visibilityRescanTimer = null;
let lookupRetryTimer = null;
let lookupRetryHrefs = new Set();
let lookupRetryAttempt = 0;
let warmupRescanTimer = null;
let warmupPendingRetries = 0;
// Location href last scanned by init or requery. Same-document tabs.onUpdated
// requery is skipped when init already ran for this URL.
let initScanHref = "";

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

function reapplyStoredLinkStatuses() {
	if (!searchSite || linkStatusMap.size === 0) return;
	const statuses = {};
	for (const [href, status] of linkStatusMap) {
		if (status && status !== "none") statuses[href] = status;
	}
	if (Object.keys(statuses).length === 0) return;
	applyBookmarkStyling({ statuses });
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

function countStyledAndHiddenElements() {
	const hideClassNames = new Set();
	for (const rule of preparedStyleRules) {
		if (styleRuleHidesElements(rule)) {
			hideClassNames.add(styleRuleClassName(rule));
		}
	}

	const seen = new Set();
	let styled = 0;
	let hidden = 0;

	for (const className of managedClassNames) {
		if (!className) continue;
		for (const element of document.getElementsByClassName(className)) {
			if (seen.has(element)) continue;
			seen.add(element);

			const isHidden = [...element.classList].some(name =>
				hideClassNames.has(name)
			);
			if (isHidden) {
				hidden += 1;
			} else {
				styled += 1;
			}
		}
	}

	return { styled, hidden };
}

function getActionPopupPageState() {
	const counts = countStyledAndHiddenElements();
	return {
		pageReady: settingsLoaded,
		revealHidden: isRevealHidden(),
		styled: counts.styled,
		hidden: counts.hidden
	};
}

function notifyRefreshBusyComplete(actionBusyGeneration) {
	browser.runtime.sendMessage({
		refreshBusyComplete: true,
		actionBusyGeneration
	}).catch(() => {});
}

const mutationDebounceDelay = 200;
const MUTATION_FRAME_BUDGET_MS = 8;

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
	pendingObservedTextElements = new Set();
	pendingAddedNodes = [];
	pendingAddedOffset = 0;
	if (mutationFrameId) {
		cancelAnimationFrame(mutationFrameId);
		mutationFrameId = 0;
	}
	lookupRetryHrefs = new Set();
	lookupRetryAttempt = 0;
	if (lookupRetryTimer) {
		clearTimeout(lookupRetryTimer);
		lookupRetryTimer = null;
	}
	clearWarmupRescanTimer();

	if (mutationDebounceTimer) {
		clearTimeout(mutationDebounceTimer);
		mutationDebounceTimer = null;
	}

	clearDuplicateWarningPass();
	lastDuplicatePageToastKey = "";
	lastPageTitleScanUrl = "";
	lastPageTitleScanTitle = "";
	pageTitleScanPendingUrl = "";
	pageTitleScanPendingTitle = "";
	hideDuplicateWarningToast();

	removeStatusClasses(managedClassNames);
}

function invalidateTextFilterCache() {
	textFilterCache.clear();
	removeStatusClasses(managedClassNames);
}

function flushLookupRetriesNow() {
	if (lookupRetryTimer) {
		clearTimeout(lookupRetryTimer);
		lookupRetryTimer = null;
	}
	if (lookupRetryHrefs.size === 0) return;
	const batch = Array.from(lookupRetryHrefs);
	lookupRetryHrefs = new Set();
	for (const href of batch) {
		softMissHrefs.delete(href);
		pendingStatusHrefs.delete(href);
	}
	requestBookmarkStatuses(batch, { force: true });
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
		flushLookupRetriesNow();
	}, delay);
}

function clearSoftMissesAndRescan(options = {}) {
	if (!searchSite) return;
	softMissHrefs = new Set();
	sendUniqueHrefs(options);
}

function clearWarmupRescanTimer() {
	if (warmupRescanTimer) {
		clearTimeout(warmupRescanTimer);
		warmupRescanTimer = null;
	}
	warmupPendingRetries = 0;
}

function scheduleWarmupRescan() {
	clearWarmupRescanTimer();
	// One delayed retry is enough now that the first pass waits for settings.
	// 1.2s sits after first paint without the later hitch of a 3.5s second pass.
	warmupRescanTimer = setTimeout(runWarmupRescan, 1200);
}

function runWarmupRescan() {
	warmupRescanTimer = null;
	if (!searchSite) return;
	if (pendingStatusHrefs.size > 0 && warmupPendingRetries < 5) {
		warmupPendingRetries += 1;
		warmupRescanTimer = setTimeout(runWarmupRescan, 400);
		return;
	}
	warmupPendingRetries = 0;
	if (softMissHrefs.size === 0) return;
	clearSoftMissesAndRescan();
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
						// Soft miss — retry on requery / warmup / index-ready.
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
			if (showLoading) endStylingIndicator(countStyledAndHiddenElements());
			scheduleDuplicateWarningPass();
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

	if (message && message.getActionPopupPageState) {
		return Promise.resolve(getActionPopupPageState());
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
		return handleRuntimeMessage(message);
	}
});

function handleRuntimeMessage(message) {
	if (!message) return;

	if (message.bookmarkIndexReady) {
		// Folder index settled after SW wake — retry soft misses cheaply.
		clearSoftMissesAndRescan();
		reapplyStoredLinkStatuses();
		return;
	}

	if (message.statusUpdates) {
		applyHrefStatusUpdates(message.statusUpdates);
		return;
	}

	if (message.refresh) {
		if (message.reloadConfig) {
			const wasIdle = !observer;
			return reloadContentSettings().then(() => {
				if (!searchSite) return;
				if (wasIdle) {
					initProcessing();
					return;
				}
				return handleConfigRefresh(message);
			});
		}
		if (!searchSite) return Promise.resolve();
		return handleConfigRefresh(message);
	}
}

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

	if (!linkMap.has(normalized)) linkMap.set(normalized, []);
	linkMap.get(normalized).push(link);
	return normalized;
}

function linksForHref(href) {
	const links = linkMap.get(href);
	if (!links || links.length === 0) return [];
	const live = [];
	let dropped = false;
	for (const link of links) {
		if (link && link.isConnected) live.push(link);
		else dropped = true;
	}
	if (dropped) {
		if (live.length) linkMap.set(href, live);
		else linkMap.delete(href);
	}
	return live;
}

function sendUniqueHrefs(options = {}) {
	if (!searchSite) return; // skip if site not relevant
	if (options.rebuildMap !== false || linkMap.size === 0) buildLinkMap();
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
	if (newHrefs.length === 0) {
		scheduleDuplicateWarningPass();
		return;
	}
	requestBookmarkStatuses(newHrefs, options);
}

// Soft re-resolve after background cleared this tab's statuses (navigate/load).
// Re-asks even for hrefs previously recorded as soft misses.
function performRequeryRefresh() {
	if (!searchSite) return;
	// Skip a duplicate scan only when this URL already got positive looks.
	// A first pass that ran before the style index was ready leaves only
	// soft misses; tabs.onUpdated must be allowed to ask again.
	if (initScanHref === location.href && processedHrefs.size > 0) return;
	initScanHref = location.href;

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
		endStylingIndicator(countStyledAndHiddenElements());
		if (showActionBusy) {
			notifyRefreshBusyComplete(actionBusyGeneration);
		}
	};

	if (!searchSite) {
		if (showActionBusy) notifyRefreshBusyComplete(actionBusyGeneration);
		return Promise.resolve();
	}

	// Host pages sometimes remove our stylesheet; refresh must recreate it.
	injectBookmarkStyles();

	urlCacheGeneration += 1;
	const refreshGeneration = urlCacheGeneration;
	softMissHrefs = new Set();
	buildLinkMap();
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

		applyBookmarkStyling(message);

		// Pick up any links added while the authoritative request was running.
		sendUniqueHrefs({ rebuildMap: false });
	}

	// No links yet — keep existing styles instead of wiping to empty.
	if (allHrefs.length === 0) {
		stylingIndicatorUserDismissed = false;
		showStylingResult(countStyledAndHiddenElements());
		scheduleDuplicateWarningPass();
		if (showActionBusy) notifyRefreshBusyComplete(actionBusyGeneration);
		return Promise.resolve();
	}

	beginStylingIndicator();
	const payload = authoritativeLookup
		? { hrefs: allHrefs, authoritative: true }
		: { hrefs: allHrefs };
	return browser.runtime.sendMessage(payload)
		.then(applyAuthoritativeResults)
		.catch(onError)
		.finally(finishBusy);
}

function positiveStatusesFromLinkMap() {
	const statuses = {};
	for (const [href, status] of linkStatusMap) {
		if (status && status !== "none") statuses[href] = status;
	}
	return statuses;
}

function closestConfiguredCards(element) {
	if (!(element instanceof Element) || !classesForSearch.length) return [];
	const cards = [];
	const seen = new Set();
	for (const classGroup of classesForSearch) {
		const required = classGroup.split(/\s+/).filter(Boolean);
		if (!required.length) continue;
		let node = element;
		while (node && node.nodeType === 1) {
			if (required.every(name => node.classList.contains(name))) {
				if (!seen.has(node)) {
					seen.add(node);
					cards.push(node);
				}
				break;
			}
			node = node.parentElement;
		}
	}
	// Configured class is often on an inner wrapper inside a listing <a>.
	if (typeof element.getElementsByClassName === "function") {
		for (const classGroup of classesForSearch) {
			for (const nested of element.getElementsByClassName(classGroup)) {
				if (!seen.has(nested)) {
					seen.add(nested);
					cards.push(nested);
				}
			}
		}
	}
	return cards;
}

function restyleConfiguredCard(card, statusLookup, matchingTextRules) {
	let matchedClassName = findStatusClassFromLinks(card, statusLookup);
	if (enableDeepSearch && !matchedClassName) {
		const text = card.textContent || "";
		const html = card.innerHTML || "";
		const statusesByPriority = Array.from(statusLookup.values())
			.sort((a, b) => a.priority - b.priority);
		for (const bookmark of statusesByPriority) {
			if (elementMatchesBookmarkFallback(card, text, html, bookmark)) {
				matchedClassName = bookmark.className;
				break;
			}
		}
	}
	if (matchedClassName) {
		applyStatusClass(card, matchedClassName);
		return;
	}
	if (managedClassNames.length) {
		card.classList.remove(...managedClassNames);
	}
	if (matchingTextRules && matchingTextRules.length) {
		textFilterCache.delete(card);
		applyTextRulesTo([card], matchingTextRules);
	}
}

function applyPageTopBorder(statusLookup) {
	if (!enableTopBorder || !document.body) return;
	const currentStatus = statusLookup.get(normalizeHrefForSearch(window.location.href));
	if (!currentStatus) return;
	if (originalBodyBorderTop === null) {
		originalBodyBorderTop = document.body.style.borderTop;
	}
	document.body.style.borderTop = currentStatus.border;
}

function syncPageTopBorder(statusLookup) {
	if (!enableTopBorder) return;
	if (statusLookup.get(normalizeHrefForSearch(window.location.href))) {
		applyPageTopBorder(statusLookup);
	} else {
		clearExtensionTopBorder();
	}
}

// Look toggle / context-menu add: restyle only the changed href's anchors and
// their cards. A full applyBookmarkStyling would re-walk every unstyled card.
function applyHrefStatusUpdates(statusUpdates) {
	if (!searchSite || !statusUpdates || typeof statusUpdates !== "object") return;

	const pageHref = normalizeHrefForSearch(window.location.href);
	let touchedPageUrl = false;
	const affectedCards = new Set();

	for (const [href, status] of Object.entries(statusUpdates)) {
		pendingStatusHrefs.delete(href);
		if (status && status !== "none") {
			rememberPositiveStatus(href, status);
		} else {
			softMissHrefs.add(href);
			processedHrefs.delete(href);
			linkStatusMap.delete(href);
		}
		if (href === pageHref) touchedPageUrl = true;

		const style = status && status !== "none" ? getStyleConfigById(status) : null;
		for (const link of linksForHref(href)) {
			if (style) applyStatusClass(link, style.className);
			else if (managedClassNames.length) {
				link.classList.remove(...managedClassNames);
			}
			for (const card of closestConfiguredCards(link)) {
				affectedCards.add(card);
			}
		}
	}

	const statusLookup = buildBookmarkStatusLookup(positiveStatusesFromLinkMap());
	const matchingTextRules = getMatchingTextRules();
	for (const card of affectedCards) {
		restyleConfiguredCard(card, statusLookup, matchingTextRules);
	}
	if (touchedPageUrl) syncPageTopBorder(statusLookup);

	// Look-shortcut save/unsave of this page restyles its href only.
	// Hide the toast if this URL is now saved; skip a full title rescan.
	const onlyCurrentPage = touchedPageUrl &&
		Object.keys(statusUpdates).every(href => href === pageHref);
	if (onlyCurrentPage) {
		if (pageHrefHasUrlMatch()) {
			lastDuplicatePageToastKey = "";
			hideDuplicateWarningToast();
		}
		return;
	}
	scheduleDuplicateWarningPass();
}

function applyBookmarkStyling(message) {
	if (!searchSite) return;

	injectBookmarkStyles();

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
		const elements = linksForHref(normalized);
		for (const element of elements) {
			applyStatusClass(element, status.className);
		}
	}

	applyPageTopBorder(statusLookup);
	applyCardStylesFromLinks(statusLookup);
	applyCardStylesFromConfiguredClasses(statusLookup);
	applyDeepSearchToUnstyledCards(statusLookup);
	applyTextFilters();
	scheduleDuplicateWarningPass();
}

function buildBookmarkStatusLookup(statuses) {
	const statusLookup = new Map();

	for (const [normalized, status] of Object.entries(statuses)) {
		const style = getStyleConfigById(status);
		if (!style) continue;

		let path = "";
		try {
			path = new URL(normalized).pathname;
		} catch {
			path = "";
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

function applyCardStylesFromLinks(statusLookup) {
	if (!classesForSearch.length || !statusLookup || statusLookup.size === 0) return;
	const cardBest = new Map();
	for (const status of statusLookup.values()) {
		for (const link of linksForHref(status.normalized)) {
			for (const card of closestConfiguredCards(link)) {
				const current = cardBest.get(card);
				if (!current || status.priority < current.priority) {
					cardBest.set(card, status);
				}
			}
		}
	}
	for (const [card, status] of cardBest) {
		applyStatusClass(card, status.className);
	}
}

function applyCardStylesFromConfiguredClasses(statusLookup) {
	if (!classesForSearch.length || !statusLookup || statusLookup.size === 0) return;
	for (const classGroup of classesForSearch) {
		for (const element of document.getElementsByClassName(classGroup)) {
			if (hasStatusClass(element)) continue;
			const matchedClassName = findStatusClassFromLinks(element, statusLookup);
			if (matchedClassName) applyStatusClass(element, matchedClassName);
		}
	}
}

function collectAnchorsForCard(element) {
	const anchors = [];
	const seen = new Set();
	const add = node => {
		if (!(node instanceof HTMLAnchorElement) || seen.has(node)) return;
		seen.add(node);
		anchors.push(node);
	};
	if (element instanceof HTMLAnchorElement) add(element);
	if (typeof element.querySelectorAll === "function") {
		for (const link of element.querySelectorAll("a[href]")) add(link);
	}
	let node = element.parentElement;
	while (node) {
		if (node instanceof HTMLAnchorElement) {
			add(node);
			break;
		}
		node = node.parentElement;
	}
	return anchors;
}

function getElementLinkHrefSet(element) {
	const normalizedHrefs = new Set();
	for (const link of collectAnchorsForCard(element)) {
		const href = link.getAttribute("href") || link.href || "";
		if (!href) continue;
		let normalized;
		try {
			normalized = normalizeHrefForSearch(href);
		} catch {
			continue;
		}
		if (/^https?:/.test(normalized)) normalizedHrefs.add(normalized);
	}
	return normalizedHrefs;
}

function findStatusClassFromLinks(element, statusLookup) {
	if (!element || !statusLookup || statusLookup.size === 0) return null;
	let matched = bestStatusClassForCard(element, statusLookup);
	if (matched) return matched;

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

function applyDeepSearchToUnstyledCards(statusLookup) {
	if (!enableDeepSearch || !classesForSearch.length) return;
	const statusesByPriority = Array.from(statusLookup.values())
		.sort((a, b) => a.priority - b.priority);
	if (statusesByPriority.length === 0) return;

	for (const classGroup of classesForSearch) {
		for (const element of document.getElementsByClassName(classGroup)) {
			if (hasStatusClass(element)) continue;
			const text = element.textContent || "";
			const html = element.innerHTML || "";
			for (const bookmark of statusesByPriority) {
				if (elementMatchesBookmarkFallback(element, text, html, bookmark)) {
					applyStatusClass(element, bookmark.className);
					break;
				}
			}
		}
	}
}

function bestStatusClassForCard(card, statusLookup) {
	if (!card || !statusLookup || statusLookup.size === 0) return null;
	let matched = null;
	for (const status of statusLookup.values()) {
		for (const link of linksForHref(status.normalized)) {
			if (link !== card && !card.contains(link)) continue;
			if (!matched || status.priority < matched.priority) matched = status;
		}
	}
	return matched?.className || null;
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
	const classList = element.classList;
	for (let i = 0; i < classList.length; i++) {
		if (managedClassNameSet.has(classList[i])) return true;
	}
	return false;
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
	const currentHost = normalizeSite(window.location.hostname);
	return preparedTextRules.filter(rule =>
		hostnameMatchesNormalized(currentHost, rule.site)
	);
}

function getTargetedClassElements() {
	const elements = [];
	for (const classGroup of classesForSearch) {
		for (const el of document.getElementsByClassName(classGroup)) {
			if (hasStatusClass(el)) continue;
			elements.push(el);
		}
	}
	return elements;
}

function applyTextFilters() {
	const matchingRules = getMatchingTextRules();
	if (matchingRules.length === 0 || !classesForSearch.length) return;
	applyTextRulesTo(getTargetedClassElements(), matchingRules);
}

function applyTextRulesTo(elements, matchingRules) {
	if (!elements || elements.length === 0) return;
	matchingRules = matchingRules || getMatchingTextRules();
	if (matchingRules.length === 0) return;

	for (const element of elements) {
		if (hasStatusClass(element)) continue;

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
function enqueueObservedAddedNode(node) {
	if (!(node instanceof Element)) return;
	pendingAddedNodes.push(node);
}

function compactPendingAddedNodes() {
	if (pendingAddedOffset === 0) return;
	if (pendingAddedOffset < 256) return;
	pendingAddedNodes = pendingAddedNodes.slice(pendingAddedOffset);
	pendingAddedOffset = 0;
}

function queueObservedTextElements(node) {
	if (!classesForSearch.length) return;
	for (const classGroup of classesForSearch) {
		const requiredClasses = classGroup.split(/\s+/).filter(Boolean);
		if (
			requiredClasses.length &&
			node.classList &&
			requiredClasses.every(className => node.classList.contains(className))
		) {
			pendingObservedTextElements.add(node);
		}
		if (typeof node.getElementsByClassName !== "function") continue;
		const found = node.getElementsByClassName(classGroup);
		for (const el of found) pendingObservedTextElements.add(el);
	}
}

function collectObservedNode(node, collectTextTargets) {
	if (node instanceof HTMLAnchorElement) {
		const norm = collectLink(node);
		if (norm) pendingObservedHrefs.add(norm);
	}
	if (typeof node.querySelectorAll === "function") {
		const links = node.querySelectorAll("a[href]");
		for (const link of links) {
			const norm = collectLink(link);
			if (norm) pendingObservedHrefs.add(norm);
		}
	}
	if (collectTextTargets) queueObservedTextElements(node);
}

function startMutationObserver() {
	if (observer) return;
	observer = new MutationObserver(mutations => {
		for (const record of mutations) {
			const nodes = record.addedNodes;
			for (let i = 0; i < nodes.length; i++) {
				enqueueObservedAddedNode(nodes[i]);
			}
		}
		scheduleObservedMutationFrame();
	});
	observer.observe(document.documentElement || document.body, {
		childList: true,
		subtree: true
	});
}

function scheduleObservedMutationFrame() {
	if (mutationFrameId) return;
	mutationFrameId = requestAnimationFrame(processObservedMutationFrame);
}

function processObservedMutationFrame() {
	mutationFrameId = 0;
	const collectTextTargets = classesForSearch.length > 0 &&
		getMatchingTextRules().length > 0;
	const started = performance.now();

	while (pendingAddedOffset < pendingAddedNodes.length) {
		if (performance.now() - started >= MUTATION_FRAME_BUDGET_MS) {
			scheduleObservedMutationFrame();
			break;
		}
		collectObservedNode(pendingAddedNodes[pendingAddedOffset], collectTextTargets);
		pendingAddedOffset += 1;
	}

	if (pendingAddedOffset >= pendingAddedNodes.length) {
		pendingAddedNodes = [];
		pendingAddedOffset = 0;
	} else {
		compactPendingAddedNodes();
	}

	if (pendingObservedHrefs.size > 0 || pendingObservedTextElements.size > 0) {
		scheduleObservedHrefProcessing();
	}
}

function scheduleObservedHrefProcessing() {
	if (mutationDebounceTimer) return;
	mutationDebounceTimer = setTimeout(processObservedHrefs, mutationDebounceDelay);
}

function processObservedHrefs() {
	const hrefs = Array.from(pendingObservedHrefs);
	pendingObservedHrefs = new Set();
	const textElements = Array.from(pendingObservedTextElements);
	pendingObservedTextElements = new Set();
	mutationDebounceTimer = null;

	if (textElements.length > 0) {
		applyTextRulesTo(
			textElements.filter(el => el.isConnected && !hasStatusClass(el)),
			getMatchingTextRules()
		);
	}

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
	scheduleDuplicateWarningPass();
}

function applyCachedLinkStatus(norm) {
	const status = linkStatusMap.get(norm);
	if (!status || status === "none") return;
	const style = getStyleConfigById(status);
	if (!style) return;

	const els = linksForHref(norm);
	for (const el of els) {
		if (!hasStatusClass(el)) applyStatusClass(el, style.className);
		for (const card of closestConfiguredCards(el)) {
			if (card !== el && !hasStatusClass(card)) {
				applyStatusClass(card, style.className);
			}
		}
	}
}

function scheduleVisibilityRescan() {
	if (!searchSite) return;
	if (lookupRetryHrefs.size === 0) return;
	if (visibilityRescanTimer) return;
	visibilityRescanTimer = setTimeout(() => {
		visibilityRescanTimer = null;
		performVisibilityRescan();
	}, 100);
}

function performVisibilityRescan() {
	if (!searchSite) return;
	if (document.visibilityState === "hidden") return;
	// Cmd-Tab / window focus is not a reason to re-ask every unmatched URL.
	// Lookups already wait for the host list; flush only failed requests
	// whose retry timer may have been throttled while hidden.
	flushLookupRetriesNow();
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
	pageWasHidden = false;
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
	initScanHref = location.href;
	sendUniqueHrefs({ showLoading: true });
	// Start observing for incremental additions
	startMutationObserver();
	scheduleWarmupRescan();

	// Background tabs can finish the first scan while still hidden; remember
	// that so a later focus can flush failed lookups (not every miss).
	if (document.visibilityState === "hidden") {
		pageWasHidden = true;
	}
}

} // end __beContentScriptInstalled install guard
