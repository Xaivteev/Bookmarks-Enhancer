/* Background link index, settings, and saved-link mutations.
 * Loaded by background.js before backgroundScript.js (message router / menus).
 */

let utilsSitesExtraLoadPromise = null;

function loadUtilsSitesExtra() {
	if (globalThis.__beUtilsSitesExtraLoaded) return Promise.resolve();
	if (utilsSitesExtraLoadPromise) return utilsSitesExtraLoadPromise;
	if (typeof importScripts === "function") {
		importScripts("utilsSitesExtra.js");
		globalThis.__beUtilsSitesExtraLoaded = true;
		return Promise.resolve();
	}
	if (typeof document === "undefined") {
		return Promise.reject(new Error("Cannot load site migration helpers"));
	}
	utilsSitesExtraLoadPromise = new Promise((resolve, reject) => {
		const script = document.createElement("script");
		script.src = browser.runtime.getURL("utilsSitesExtra.js");
		script.onload = () => {
			globalThis.__beUtilsSitesExtraLoaded = true;
			utilsSitesExtraLoadPromise = null;
			resolve();
		};
		script.onerror = () => {
			utilsSitesExtraLoadPromise = null;
			reject(new Error("Failed to load site migration helpers"));
		};
		(document.head || document.documentElement).appendChild(script);
	});
	return utilsSitesExtraLoadPromise;
}

let urlRules = [];
let sites = [];
let styleRules = DEFAULT_STYLE_RULES.map(rule => ({ ...rule }));
let styleRuleById = new Map();
let enableDuplicateWarning = false;
let linkLookupBySite = new Map();
let titleEntriesBySite = new Map();
let titleTokenIndexBySite = new Map();
let titleIndexReadyBySite = new Set();
let siteHostIndex = new Map();
const urlNormalizationCache = createUrlNormalizationCache();
setHrefNormalizationContext(urlRules, urlNormalizationCache);
let hostsLoaded = new Set();
const hostLoadPromises = new Map();

let settingsReady = null;
let settingsLoadGeneration = 0;
let pendingIgnoredSiteWrites = 0;
let compactSiteLinksTimer = null;
const compactSiteLinksHosts = new Set();
const siteLinksDeltasByHost = new Map();
const hostLinkPersistTail = new Map();

function lookupEntryStyle(entry) {
	if (!entry) return null;
	return typeof entry === "string" ? entry : (entry.style || null);
}

function rebuildStyleRuleIndex() {
	styleRuleById = new Map();
	for (const rule of styleRules || []) {
		if (rule?.id) styleRuleById.set(rule.id, rule);
	}
}

rebuildStyleRuleIndex();

function matchingSiteConfig(hostname) {
	return findSiteConfigInHostIndex(siteHostIndex, hostname);
}

function resolveSiteConfig(host) {
	if (!host) return null;
	return siteHostIndex.get(host) || matchingSiteConfig(host) || null;
}

function rebuildSiteHostIndex() {
	siteHostIndex = buildSiteHostIndex(sites);
}

function rebuildLinkLookupForHost(siteConfig) {
	if (!siteConfig?.site) return;
	const map = new Map();
	for (const link of siteConfig.links || []) {
		if (!link?.url) continue;
		const key = hrefMatchKey(link.url);
		if (!key || map.has(key)) continue;
		map.set(key, link);
	}
	linkLookupBySite.set(siteConfig.site, map);
	invalidateTitleIndexForHost(siteConfig.site);
}

function invalidateTitleIndexForHost(host) {
	if (!host) return;
	titleIndexReadyBySite.delete(host);
	titleEntriesBySite.delete(host);
	titleTokenIndexBySite.delete(host);
}

function clearTitleIndexes() {
	titleIndexReadyBySite = new Set();
	titleEntriesBySite = new Map();
	titleTokenIndexBySite = new Map();
}

function ensureTitleIndexForHost(siteConfig) {
	if (!enableDuplicateWarning || !siteConfig?.site) return;
	if (titleIndexReadyBySite.has(siteConfig.site)) return;
	if (!hostsLoaded.has(siteConfig.site)) return;
	rebuildTitleIndexForHost(siteConfig);
}

function rebuildTitleIndexForHost(siteConfig) {
	if (!siteConfig?.site) return;
	const entries = [];
	const tokenIndex = new Map();
	for (const link of siteConfig.links || []) {
		if (!link?.url) continue;
		const matchKey = hrefMatchKey(link.url);
		if (!matchKey) continue;
		const normalized = normalizeDuplicateTitle(link.title);
		if (!normalized || isBoilerplateDuplicateLinkTitle(normalized)) continue;
		const entryIndex = entries.length;
		entries.push({
			url: link.url,
			title: typeof link.title === "string" ? link.title : "",
			style: typeof link.style === "string" ? link.style : "",
			matchKey,
			normalized
		});
		for (const token of duplicateTitleIndexTokens(normalized)) {
			const bucket = tokenIndex.get(token);
			if (bucket) bucket.push(entryIndex);
			else tokenIndex.set(token, [entryIndex]);
		}
	}
	titleEntriesBySite.set(siteConfig.site, entries);
	titleTokenIndexBySite.set(siteConfig.site, tokenIndex);
	titleIndexReadyBySite.add(siteConfig.site);
}

function collectDuplicateTitleCandidates(siteKey, queryNormalized) {
	const entries = titleEntriesBySite.get(siteKey) || [];
	if (entries.length === 0) return entries;
	const tokenIndex = titleTokenIndexBySite.get(siteKey);
	if (!tokenIndex || tokenIndex.size === 0) return entries;

	const variants = [queryNormalized];
	const queryStripped = stripDuplicateTitleSiteSuffix(queryNormalized);
	if (queryStripped && queryStripped !== queryNormalized) variants.push(queryStripped);

	let hasContentTokens = false;
	const candidateIndexes = new Set();
	for (const variant of variants) {
		const tokens = duplicateTitleTokens(variant);
		if (tokens.length === 0) continue;
		hasContentTokens = true;
		const need = duplicateTitleMinSharedTokens(tokens.length);
		const counts = new Map();
		for (const token of tokens) {
			const posting = tokenIndex.get(token);
			if (!posting) continue;
			for (const idx of posting) {
				counts.set(idx, (counts.get(idx) || 0) + 1);
			}
		}
		for (const [idx, shared] of counts) {
			if (shared >= need) candidateIndexes.add(idx);
		}
	}
	if (!hasContentTokens) return entries;

	const candidates = [];
	for (const idx of candidateIndexes) {
		const entry = entries[idx];
		if (entry) candidates.push(entry);
	}
	return candidates;
}

function rebuildLinkLookup() {
	urlRules = sitesToUrlRules(sites);
	urlNormalizationCache.clear();
	setHrefNormalizationContext(urlRules, urlNormalizationCache);
	rebuildSiteHostIndex();
	linkLookupBySite = new Map();
	clearTitleIndexes();

	for (const siteConfig of sites) {
		if (!siteConfig?.site || !hostsLoaded.has(siteConfig.site)) continue;
		rebuildLinkLookupForHost(siteConfig);
	}
}

function markHostsLoaded(siteList) {
	hostsLoaded = new Set();
	for (const siteConfig of siteList || []) {
		if (siteConfig?.site) hostsLoaded.add(siteConfig.site);
	}
}

function rememberSiteLinksDeltasFromStorage(result) {
	const byHost = siteLinksDeltasByHostFromStorageResult(result);
	for (const [host, delta] of Object.entries(byHost)) {
		if (host) siteLinksDeltasByHost.set(host, delta);
	}
}

function clearSiteLinksDeltaState(host) {
	if (!host) return;
	siteLinksDeltasByHost.set(host, emptySiteLinksDelta());
}

function enqueueHostLinkPersist(host, task) {
	const prev = hostLinkPersistTail.get(host) || Promise.resolve();
	const next = prev.then(task, task);
	hostLinkPersistTail.set(host, next.then(() => {}, () => {}));
	return next;
}

function applyLoadedHostLinks(siteKey, links) {
	const siteConfig = resolveSiteConfig(siteKey);
	if (siteConfig) {
		siteConfig.links = Array.isArray(links) ? links : [];
		rebuildLinkLookupForHost(siteConfig);
	}
	hostsLoaded.add(siteKey);
}

function loadHostLinksBatch(siteKeys) {
	const unique = Array.from(new Set((siteKeys || []).filter(Boolean)));
	const waits = [];
	const needed = [];
	for (const siteKey of unique) {
		if (hostsLoaded.has(siteKey)) continue;
		const pending = hostLoadPromises.get(siteKey);
		if (pending) waits.push(pending);
		else needed.push(siteKey);
	}
	if (needed.length === 0) {
		return waits.length ? Promise.all(waits) : Promise.resolve();
	}

	const keys = [];
	for (const siteKey of needed) {
		const blobKey = siteLinksStorageKey(siteKey);
		const deltaKey = siteLinksDeltaStorageKey(siteKey);
		if (blobKey) keys.push(blobKey);
		if (deltaKey) keys.push(deltaKey);
	}
	const batchPromise = browser.storage.local.get(keys)
		.then(result => {
			rememberSiteLinksDeltasFromStorage(result);
			for (const siteKey of needed) {
				if (!siteLinksDeltasByHost.has(siteKey)) {
					siteLinksDeltasByHost.set(siteKey, emptySiteLinksDelta());
				}
				const delta = siteLinksDeltasByHost.get(siteKey);
				applyLoadedHostLinks(
					siteKey,
					applySiteLinksDeltaOps(
						result[siteLinksStorageKey(siteKey)],
						delta.ops
					)
				);
				hostLoadPromises.delete(siteKey);
			}
		})
		.catch(error => {
			for (const siteKey of needed) hostLoadPromises.delete(siteKey);
			throw error;
		});

	for (const siteKey of needed) {
		hostLoadPromises.set(siteKey, batchPromise);
	}
	return Promise.all([...waits, batchPromise]);
}

function ensureHostLinksReady(host) {
	const siteConfig = resolveSiteConfig(host);
	if (!siteConfig) return Promise.resolve();
	if (hostsLoaded.has(siteConfig.site)) return Promise.resolve();
	return loadHostLinksBatch([siteConfig.site]);
}

function ensureHostLinksReadyForUrl(url) {
	try {
		return ensureHostLinksReady(new URL(url).hostname);
	} catch {
		return Promise.resolve();
	}
}

function prefetchHostLinksForUrl(url) {
	if (!url) return Promise.resolve();
	return ensureSettingsReady()
		.then(() => {
			if (!getPageRunState(url).siteMatch) return;
			return ensureHostLinksReadyForUrl(url);
		})
		.catch(() => {});
}

function prefetchHostLinksForTab(tabId) {
	if (tabId == null) return Promise.resolve();
	return browser.tabs.get(tabId)
		.then(tab => prefetchHostLinksForUrl(tab && tab.url))
		.catch(() => {});
}

function ensureHostLinksReadyForHrefs(hrefs) {
	const siteKeys = new Set();
	for (const href of hrefs || []) {
		if (!href) continue;
		try {
			const siteConfig = matchingSiteConfig(new URL(href).hostname);
			if (siteConfig?.site) siteKeys.add(siteConfig.site);
		} catch {
			// Skip invalid hrefs; searchhrefs will ignore them too.
		}
	}
	return loadHostLinksBatch(Array.from(siteKeys));
}

function ensureAllHostLinksReady() {
	return loadHostLinksBatch(
		(sites || []).map(siteConfig => siteConfig?.site).filter(Boolean)
	);
}

function applyDuplicateWarningSetting(value) {
	enableDuplicateWarning = value === true;
	if (!enableDuplicateWarning) clearTitleIndexes();
}

function applyLoadedSites(nextSites, nextStyleRules, { rebuild = true } = {}) {
	sites = Array.isArray(nextSites) ? nextSites : [];
	styleRules = Array.isArray(nextStyleRules)
		? nextStyleRules
		: DEFAULT_STYLE_RULES.map(rule => ({ ...rule }));
	rebuildStyleRuleIndex();
	if (rebuild) rebuildLinkLookup();
	else rebuildSiteHostIndex();
}

function maybeSplitStoredSiteLinks(result, loadedSites) {
	const hasBlob = result &&
		result[STORAGE_KEYS.siteLinks] &&
		typeof result[STORAGE_KEYS.siteLinks] === "object" &&
		!Array.isArray(result[STORAGE_KEYS.siteLinks]);
	const embedded = sitesHaveEmbeddedLinks(result.sites);
	if (!hasBlob && !embedded) {
		return Promise.resolve(loadedSites);
	}

	pendingIgnoredSiteWrites += 1;
	const previousHosts = [...siteLinkHostsFromStorageResult(result)];
	const plan = buildSitesStoragePlan(loadedSites, { previousHosts });
	if (plan.removeKeys.some(Boolean)) pendingIgnoredSiteWrites += 1;
	return persistSitesStoragePlan(plan)
		.catch(error => {
			pendingIgnoredSiteWrites = Math.max(0, pendingIgnoredSiteWrites - 1);
			throw error;
		})
		.then(() => {
			for (const siteConfig of loadedSites || []) {
				if (siteConfig?.site) clearSiteLinksDeltaState(siteConfig.site);
			}
			scheduleConfigTabsRefresh();
			return loadedSites;
		});
}

function loadSettingsFromFullStorage() {
	return loadUtilsSitesExtra().then(() => browser.storage.local.get(null).then(result => {
		styleRules = migrateStyleRulesFromStorage(result);
		applyDuplicateWarningSetting(result[STORAGE_KEYS.enableDuplicateWarning]);
		return purgeLegacyStorage(result).then(migratedSites => {
			markHostsLoaded(migratedSites);
			rememberSiteLinksDeltasFromStorage(result);
			applyLoadedSites(migratedSites, styleRules);
			return maybeSplitStoredSiteLinks(result, migratedSites).then(sitesAfter => {
				if (sitesAfter && sitesAfter !== migratedSites) {
					markHostsLoaded(sitesAfter);
					applyLoadedSites(sitesAfter, styleRules);
				}
				return sitesAfter;
			});
		});
	}));
}

function loadSettings() {
	return browser.storage.local.get(settingsMetaStorageKeys()).then(meta => {
		if (settingsStorageNeedsFullRead(meta)) {
			return loadSettingsFromFullStorage();
		}
		styleRules = migrateStyleRulesFromStorage(meta);
		hostsLoaded = new Set();
		siteLinksDeltasByHost.clear();
		return browser.storage.local.get(STORAGE_KEYS.enableDuplicateWarning)
			.then(extra => {
				applyDuplicateWarningSetting(extra[STORAGE_KEYS.enableDuplicateWarning]);
				const loadedSites = loadSitesFromStorageResult(meta, { preserveLinks: true });
				applyLoadedSites(loadedSites, styleRules);
				return loadedSites;
			});
	});
}

function ensureSettingsReady() {
	if (!settingsReady) {
		const loadGeneration = ++settingsLoadGeneration;
		settingsReady = loadSettings()
			.catch(error => {
				onError(error);
				if (loadGeneration === settingsLoadGeneration) {
					settingsReady = null;
				}
				throw error;
			});
	}
	return settingsReady;
}

ensureSettingsReady().catch(onError);

function persistSites(nextSites, { includeLinks = true, rebuild = includeLinks } = {}) {
	const previousHosts = [...siteHostIndex.keys()];
	sites = Array.isArray(nextSites) ? nextSites : sites;
	if (rebuild) rebuildLinkLookup();
	else {
		urlRules = sitesToUrlRules(sites);
		setHrefNormalizationContext(urlRules, urlNormalizationCache);
		rebuildSiteHostIndex();
	}

	pendingIgnoredSiteWrites += 1;
	const persist = includeLinks
		? persistLoadedHostLinks(previousHosts)
		: browser.storage.local.set({
			[STORAGE_KEYS.sites]: sites.map(siteConfigToStorageMeta).filter(Boolean)
		});
	return persist.then(() => sites).catch(error => {
		pendingIgnoredSiteWrites = Math.max(0, pendingIgnoredSiteWrites - 1);
		throw error;
	});
}

function persistLoadedHostLinks(previousHosts) {
	const writes = {
		[STORAGE_KEYS.sites]: sites.map(siteConfigToStorageMeta).filter(Boolean)
	};
	const keepHosts = new Set();
	const removeKeys = [STORAGE_KEYS.siteLinks];
	for (const siteConfig of sites || []) {
		const host = siteConfig?.site;
		if (!host) continue;
		keepHosts.add(host);
		if (!hostsLoaded.has(host)) continue;
		Object.assign(writes, buildHostLinksStorageWrite(host, siteConfig.links));
		removeKeys.push(siteLinksDeltaStorageKey(host));
		removeKeys.push(siteStylesStorageKey(host));
		clearSiteLinksDeltaState(host);
	}

	for (const host of previousHosts || []) {
		if (!host || keepHosts.has(host)) continue;
		removeKeys.push(siteLinksStorageKey(host));
		removeKeys.push(siteLinksDeltaStorageKey(host));
		removeKeys.push(siteStylesStorageKey(host));
		hostsLoaded.delete(host);
		linkLookupBySite.delete(host);
		invalidateTitleIndexForHost(host);
		siteLinksDeltasByHost.delete(host);
	}

	if (removeKeys.some(Boolean)) pendingIgnoredSiteWrites += 1;
	return persistSitesStoragePlan({ writes, removeKeys });
}

function scheduleCompactSiteLinks(host) {
	if (host) compactSiteLinksHosts.add(host);
	if (compactSiteLinksTimer) clearTimeout(compactSiteLinksTimer);
	compactSiteLinksTimer = setTimeout(() => {
		compactSiteLinksTimer = null;
		const hosts = Array.from(compactSiteLinksHosts);
		compactSiteLinksHosts.clear();
		for (const nextHost of hosts) {
			enqueueHostLinkPersist(nextHost, () => compactSiteLinksForHost(nextHost))
				.catch(onError);
		}
	}, SITE_LINKS_DELTA_COMPACT_MS);
}

function compactSiteLinksForHost(host, { force = false } = {}) {
	if (!host || !hostsLoaded.has(host)) return Promise.resolve();
	const delta = siteLinksDeltasByHost.get(host);
	if (!force && (!delta || !delta.ops.length)) return Promise.resolve();

	const blobKey = siteLinksStorageKey(host);
	const deltaKey = siteLinksDeltaStorageKey(host);
	if (!blobKey) return Promise.resolve();
	const links = sites.find(site => site.site === host)?.links || [];

	pendingIgnoredSiteWrites += 1;
	return browser.storage.local.set({ [blobKey]: links }).then(() => {
		clearSiteLinksDeltaState(host);
		const leftover = [deltaKey, siteStylesStorageKey(host)].filter(Boolean);
		if (leftover.length === 0) return;
		pendingIgnoredSiteWrites += 1;
		return browser.storage.local.remove(leftover);
	}).catch(error => {
		pendingIgnoredSiteWrites = Math.max(0, pendingIgnoredSiteWrites - 1);
		throw error;
	});
}

function writeSiteLinkDelta(host, op, extraWrites = {}) {
	if (!host) return Promise.resolve();
	const deltaKey = siteLinksDeltaStorageKey(host);
	if (!deltaKey) return Promise.resolve();
	const current = siteLinksDeltasByHost.get(host) || emptySiteLinksDelta();
	const nextDelta = appendSiteLinksDeltaOp(current, op);
	siteLinksDeltasByHost.set(host, nextDelta);

	pendingIgnoredSiteWrites += 1;
	return browser.storage.local.set({
		[deltaKey]: nextDelta,
		...extraWrites
	}).then(() => {
		if (nextDelta.ops.length >= SITE_LINKS_DELTA_COMPACT_OPS) {
			return compactSiteLinksForHost(host);
		}
		scheduleCompactSiteLinks(host);
	}).catch(error => {
		pendingIgnoredSiteWrites = Math.max(0, pendingIgnoredSiteWrites - 1);
		siteLinksDeltasByHost.set(host, current);
		return compactSiteLinksForHost(host, { force: true }).then(() => {
			throw error;
		});
	});
}

function persistSiteLinkMutation(host, op, extraWrites = {}) {
	if (!host || !op) return Promise.resolve();
	return enqueueHostLinkPersist(host, () => writeSiteLinkDelta(host, op, extraWrites));
}

function addSelectionAsTextRule(selection, site, styleId) {
	const next = addTextRuleToSites(sites, site, selection, styleId);
	return persistSites(next, { includeLinks: false }).then(saved => {
		scheduleConfigTabsRefresh();
		return saved;
	});
}

function addUrlToSiteList(url, title, styleId) {
	return ensureHostLinksReadyForUrl(url).then(() => {
		const result = applySavedLinkToMemory(url, title, styleId, { toggleOff: false });
		if (!result.ok) return sites;
		notifyTabsHrefStatus(url, result.styleId);
		let host = "";
		try {
			host = matchingSiteConfig(new URL(url).hostname)?.site || "";
		} catch {
			host = "";
		}
		if (!host) return persistSites(sites, { rebuild: false });
		return persistSiteLinkMutation(host, result.op, {
			[STORAGE_KEYS.sites]: sites.map(siteConfigToStorageMeta).filter(Boolean)
		}).then(() => sites);
	});
}

function getPageRunState(url) {
	return getPageRunStateForUrl(url, matchingSiteConfig);
}

function emptyActionPopupPageState() {
	return {
		pageReady: false,
		styled: null,
		hidden: null,
		revealHidden: false
	};
}

function collectActionPopupSiteState(url) {
	if (!isValidHttpUrl(url)) {
		return {
			restricted: true,
			host: "",
			siteMatch: false,
			classGroupCount: 0,
			savedLinkCount: 0,
			lookCount: 0
		};
	}

	let host = "";
	try {
		host = normalizeSite(new URL(url).hostname) || "";
	} catch {
		return {
			restricted: true,
			host: "",
			siteMatch: false,
			classGroupCount: 0,
			savedLinkCount: 0,
			lookCount: 0
		};
	}

	const siteConfig = host ? matchingSiteConfig(host) : null;
	return {
		restricted: false,
		host: siteConfig ? siteConfig.site : host,
		siteMatch: !!siteConfig,
		classGroupCount: siteConfig ? (siteConfig.classGroups || []).length : 0,
		savedLinkCount: siteConfig ? (siteConfig.links || []).length : 0,
		lookCount: siteConfig ? (siteConfig.linkFolders || []).length : 0
	};
}

function getActionPopupState() {
	return browser.tabs.query({ currentWindow: true, active: true }).then(tabs => {
		const tab = tabs[0];
		if (!tab) return { ok: false };

		return ensureSettingsReady()
			.then(() => ensureHostLinksReadyForUrl(tab.url || ""))
			.then(() => {
				const siteState = collectActionPopupSiteState(tab.url || "");
				const base = {
					ok: true,
					tabId: tab.id,
					url: tab.url || "",
					...siteState,
					...emptyActionPopupPageState()
				};
				if (tab.id == null || siteState.restricted) {
					return base;
				}

				return sendTabMessage(tab.id, { getActionPopupPageState: true })
					.then(pageState => ({
						...base,
						pageReady: !!(pageState && pageState.pageReady),
						styled: typeof pageState?.styled === "number" ? pageState.styled : null,
						hidden: typeof pageState?.hidden === "number" ? pageState.hidden : null,
						revealHidden: !!(pageState && pageState.revealHidden)
					}))
					.catch(() => base);
			});
	});
}

const ACTION_POPUP_SEARCH_LIMIT = 40;

function getStyleRuleName(styleId) {
	const id = typeof styleId === "string" ? styleId.trim() : "";
	const rule = styleRuleById.get(id);
	if (rule && rule.name) return rule.name;
	return id;
}

function searchActionPopupLinks(options = {}) {
	const query = String(options.query || "").trim().toLowerCase();
	const searchTitles = options.searchTitles !== false;
	const searchUrls = options.searchUrls !== false;
	const allSites = !!options.allSites;
	const host = normalizeSite(options.host) || String(options.host || "").trim();

	if (!query) {
		return { ok: true, query: "", matches: [], total: 0, truncated: false };
	}
	if (!searchTitles && !searchUrls) {
		return { ok: true, query, matches: [], total: 0, truncated: false };
	}

	let siteList = [];
	if (allSites) {
		siteList = Array.isArray(sites) ? sites : [];
	} else if (host) {
		const match = matchingSiteConfig(host);
		siteList = match ? [match] : [];
	}

	const matches = [];
	let total = 0;
	for (const siteConfig of siteList) {
		const site = siteConfig?.site || "";
		for (const link of siteConfig.links || []) {
			const title = typeof link?.title === "string" ? link.title : "";
			const url = typeof link?.url === "string" ? link.url : "";
			if (!title && !url) continue;
			const titleHit = searchTitles && title.toLowerCase().includes(query);
			const urlHit = searchUrls && url.toLowerCase().includes(query);
			if (!titleHit && !urlHit) continue;
			total += 1;
			if (matches.length >= ACTION_POPUP_SEARCH_LIMIT) continue;
			matches.push({
				title,
				url,
				site,
				look: getStyleRuleName(link.style),
				styleId: typeof link.style === "string" ? link.style : ""
			});
		}
	}

	return {
		ok: true,
		query,
		matches,
		total,
		truncated: total > matches.length
	};
}

function getLookShortcutState(url) {
	if (!isValidHttpUrl(url)) {
		return { ok: false, url, styleId: "", site: "" };
	}
	let hostname = "";
	try {
		hostname = new URL(url).hostname;
	} catch {
		return { ok: false, url, styleId: "", site: "" };
	}
	const siteConfig = matchingSiteConfig(hostname);
	return {
		ok: !!siteConfig,
		url,
		styleId: siteConfig
			? (lookupLinkStyleForSite(normalizeHrefForSearch(url), siteConfig) || "")
			: "",
		site: siteConfig ? siteConfig.site : ""
	};
}

function applySavedLinkToMemory(url, title, styleId, { toggleOff = false } = {}) {
	if (!isValidHttpUrl(url) || !styleId) {
		return { ok: false, styleId: "" };
	}

	let hostname = "";
	try {
		hostname = new URL(url).hostname;
	} catch {
		return { ok: false, styleId: "" };
	}

	let siteConfig = matchingSiteConfig(hostname);
	if (!siteConfig) {
		if (toggleOff) return { ok: false, styleId: "" };
		const ensured = ensureSiteConfig(sites, hostname);
		sites = ensured.sites;
		siteConfig = ensured.siteConfig;
		if (!siteConfig) return { ok: false, styleId: "" };
		siteHostIndex.set(siteConfig.site, siteConfig);
		hostsLoaded.add(siteConfig.site);
		linkLookupBySite.set(siteConfig.site, new Map());
		siteLinksDeltasByHost.set(siteConfig.site, emptySiteLinksDelta());
	}
	if (!Array.isArray(siteConfig.links)) siteConfig.links = [];

	const pageKey = hrefMatchKey(url);
	if (!pageKey) return { ok: false, styleId: "" };

	let map = linkLookupBySite.get(siteConfig.site);
	if (!map) {
		map = new Map();
		linkLookupBySite.set(siteConfig.site, map);
	}

	const existing = map.get(pageKey);
	if (toggleOff && existing && lookupEntryStyle(existing) === styleId) {
		const idx = siteConfig.links.indexOf(existing);
		if (idx >= 0) siteConfig.links.splice(idx, 1);
		map.delete(pageKey);
		invalidateTitleIndexForHost(siteConfig.site);
		return {
			ok: true,
			styleId: "",
			op: { op: "remove", url: existing.url || normalizeHrefForSearch(url) }
		};
	}

	const savedTitle = normalizeSavedLinkTitle(title);
	if (existing && typeof existing === "object") {
		existing.style = styleId;
		if (savedTitle) existing.title = savedTitle;
		siteConfig.linkFolders = addLinkFolderId(siteConfig.linkFolders, styleId);
		map.set(pageKey, existing);
		invalidateTitleIndexForHost(siteConfig.site);
		return {
			ok: true,
			styleId,
			op: {
				op: "upsert",
				url: existing.url || normalizeHrefForSearch(url),
				title: existing.title,
				style: styleId
			}
		};
	}

	const saved = {
		url: normalizeHrefForSearch(url),
		title: savedTitle,
		style: styleId
	};
	siteConfig.links.push(saved);
	siteConfig.linkFolders = addLinkFolderId(siteConfig.linkFolders, styleId);
	map.set(pageKey, saved);
	invalidateTitleIndexForHost(siteConfig.site);
	return {
		ok: true,
		styleId,
		op: {
			op: "upsert",
			url: saved.url,
			title: saved.title,
			style: saved.style
		}
	};
}

function toggleLookShortcut(url, title, styleId, senderTabId) {
	if (!isValidHttpUrl(url) || !styleId) {
		return { ok: false };
	}
	const shortcutRule = styleRuleById.get(styleId);
	if (!shortcutRule || !shortcutRule.shortcutIcon) {
		return { ok: false };
	}

	let hostname = "";
	try {
		hostname = new URL(url).hostname;
	} catch {
		return { ok: false };
	}

	const siteConfig = matchingSiteConfig(hostname);
	if (!siteConfig) {
		return { ok: false };
	}

	const result = applySavedLinkToMemory(url, title, styleId, { toggleOff: true });
	if (result.ok) {
		notifyTabsHrefStatus(url, result.styleId, senderTabId);
		persistSiteLinkMutation(siteConfig.site, result.op).catch(onError);
	}
	return result;
}

function notifyTabsHrefStatus(url, styleId, senderTabId) {
	let hostname = "";
	try {
		hostname = new URL(url).hostname;
	} catch {
		return;
	}
	const normalizedTargetHost = normalizeSite(hostname);
	if (!normalizedTargetHost) return;
	const normalized = normalizeHrefForSearch(url);
	const status = styleId || "none";
	browser.tabs.query({}).then(tabs => {
		for (const tab of tabs) {
			if (!tab?.id || !tab.url) continue;
			let tabHost = "";
			try {
				tabHost = normalizeSite(new URL(tab.url).hostname);
			} catch {
				continue;
			}
			if (!hostnameMatchesNormalized(tabHost, normalizedTargetHost) &&
				!hostnameMatchesNormalized(normalizedTargetHost, tabHost)) {
				continue;
			}
			const payload = {
				statusUpdates: { [normalized]: status }
			};
			if (senderTabId && tab.id === senderTabId) {
				payload.lookShortcutState = { url, styleId: styleId || "" };
			}
			browser.tabs.sendMessage(tab.id, payload).catch(() => {});
		}
	}).catch(() => {});
}

function invalidateLinkCaches() {
	urlNormalizationCache.clear();
	rebuildLinkLookup();
}

function lookupLinkStyleForSite(normalizedHref, siteConfig) {
	if (!siteConfig) return null;
	return lookupEntryStyle(
		linkLookupBySite.get(siteConfig.site)?.get(hrefMatchKeyFromNormalized(normalizedHref))
	);
}

function lookupLinkStyle(href) {
	if (!href) return null;
	const normalized = normalizeHrefForSearch(href);
	let hostname = "";
	try {
		hostname = new URL(normalized).hostname;
	} catch {
		try {
			hostname = new URL(href).hostname;
		} catch {
			return null;
		}
	}
	return lookupLinkStyleForSite(normalized, matchingSiteConfig(hostname));
}

function searchhrefs(hrefs) {
	const statuses = {};
	let lastHost = "";
	let lastSite = null;
	let haveLastHost = false;

	for (const href of hrefs || []) {
		if (!href) continue;
		let parsed;
		try {
			parsed = new URL(href);
		} catch {
			continue;
		}
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;

		const normalized = normalizeHrefForSearch(href);
		const host = normalizeSite(parsed.hostname);
		if (!haveLastHost || host !== lastHost) {
			lastHost = host;
			lastSite = findSiteConfigByNormalizedHost(siteHostIndex, host);
			haveLastHost = true;
		}
		statuses[href] = lookupLinkStyleForSite(normalized, lastSite) || "none";
	}
	return Promise.resolve({ statuses });
}

function matchDuplicatePageTitle(url, title) {
	if (!enableDuplicateWarning) return { ok: true, matches: [] };
	if (!isValidHttpUrl(url) || lookupLinkStyle(url)) return { ok: true, matches: [] };
	if (isGenericDuplicatePageTitle(title)) return { ok: true, matches: [] };

	let hostname = "";
	try {
		hostname = new URL(url).hostname;
	} catch {
		return { ok: true, matches: [] };
	}
	const siteConfig = matchingSiteConfig(hostname);
	if (!siteConfig) return { ok: true, matches: [] };
	ensureTitleIndexForHost(siteConfig);

	const query = normalizeDuplicateTitle(title);
	if (!query) return { ok: true, matches: [] };
	const pageKey = hrefMatchKey(url);
	const entries = collectDuplicateTitleCandidates(siteConfig.site, query);
	const scored = [];
	for (const entry of entries) {
		if (entry.matchKey === pageKey) continue;
		const score = scoreDuplicateTitleFuzzy(query, entry.normalized);
		if (score < DUPLICATE_TITLE_FUZZY_MIN_SCORE) continue;
		scored.push({ score, entry });
	}
	scored.sort((a, b) =>
		b.score - a.score ||
		(a.entry.title || "").localeCompare(b.entry.title || "")
	);

	const matches = [];
	const seenKeys = new Set();
	for (const { entry } of scored) {
		const key = entry.matchKey || entry.url;
		if (!key || seenKeys.has(key)) continue;
		seenKeys.add(key);
		matches.push({
			title: entry.title || entry.url,
			url: entry.url,
			look: getStyleRuleName(entry.style)
		});
		if (matches.length >= DUPLICATE_WARNING_MAX_MATCHES) break;
	}
	return { ok: true, matches };
}
