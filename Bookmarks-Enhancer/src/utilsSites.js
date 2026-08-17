/**
 * Site storage, bookmark import/export, and legacy migration.
 * Load after utils.js. Not injected with content scripts.
 */

const BOOKMARK_EXPORT_ROOT_FOLDER = "Bookmarks Enhancer";

const PROTECTED_BOOKMARK_FOLDER_IDS = new Set([
	"root________",
	"menu________",
	"toolbar_____",
	"unfiled_____",
	"mobile______",
	"0",
	"1",
	"2",
	"3"
]);

function bookmarkNodeId(nodeOrId) {
	if (nodeOrId && typeof nodeOrId === "object") {
		return String(nodeOrId.id || "");
	}
	return String(nodeOrId || "");
}

function isBookmarkRootNode(nodeOrId) {
	const id = bookmarkNodeId(nodeOrId);
	return id === "root________" || id === "0";
}

function isProtectedBookmarkFolderId(id) {
	return PROTECTED_BOOKMARK_FOLDER_IDS.has(String(id || ""));
}

function isProtectedBookmarkFolder(node) {
	return !!node && isProtectedBookmarkFolderId(node.id);
}

const UNMATCHED_BOOKMARK_RULE_ID = "__unmatched__";

function isUnmatchedBookmarkRule(rule) {
	return !!rule && rule.folderId === UNMATCHED_BOOKMARK_RULE_ID;
}

function migrateUnmatchedBookmarkStyle(result) {
	const rules = Array.isArray(result?.bookmarkRules) ? result.bookmarkRules : null;
	if (rules) {
		const unmatched = rules.find(isUnmatchedBookmarkRule);
		if (unmatched) {
			return typeof unmatched.style === "string" ? unmatched.style.trim() : "";
		}
		// Existing folder rules without an unmatched row: migrate from the old checkbox.
		if (result[LEGACY_STORAGE_KEYS.enableSeenStyling] === false) return "";
		return "seen";
	}

	if (result?.[LEGACY_STORAGE_KEYS.enableSeenStyling] === false) return "";
	if (
		result?.[LEGACY_STORAGE_KEYS.enableSeenStyling] === true ||
		typeof result?.[LEGACY_STORAGE_KEYS.blockedFolderId] === "string" ||
		typeof result?.[LEGACY_STORAGE_KEYS.favoritedFolderId] === "string"
	) {
		return "seen";
	}

	// Fresh install: equivalent to the old checkbox being off.
	return "";
}

function normalizeStoredFolderId(value) {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isValidBookmarkRule(rule) {
	if (!rule || typeof rule.folderId !== "string" || !rule.folderId.trim()) {
		return false;
	}
	if (isUnmatchedBookmarkRule(rule)) {
		return rule.style === undefined || typeof rule.style === "string";
	}
	return typeof rule.style === "string" && rule.style.trim() !== "";
}

function normalizeBookmarkRules(rules) {
	if (!Array.isArray(rules)) return [];

	const seenFolders = new Set();
	const normalized = [];
	let unmatchedStyle = null;

	for (const rule of rules) {
		if (isUnmatchedBookmarkRule(rule)) {
			unmatchedStyle = typeof rule.style === "string" ? rule.style.trim() : "";
			continue;
		}
		if (!isValidBookmarkRule(rule)) continue;
		const folderId = rule.folderId.trim();
		if (seenFolders.has(folderId)) continue;
		seenFolders.add(folderId);
		normalized.push({
			folderId,
			style: typeof rule.style === "string" && rule.style.trim()
				? rule.style.trim()
				: "blocked"
		});
	}

	if (unmatchedStyle !== null) {
		normalized.push({
			folderId: UNMATCHED_BOOKMARK_RULE_ID,
			style: unmatchedStyle
		});
	}

	return normalized;
}

function migrateBookmarkRulesFromStorage(result) {
	let rules;
	const storedRules = result?.bookmarkRules || result?.[LEGACY_STORAGE_KEYS.bookmarkRules];
	if (Array.isArray(storedRules)) {
		rules = storedRules.slice();
	} else {
		rules = [];
		const blockedFolderId = normalizeStoredFolderId(
			result?.[LEGACY_STORAGE_KEYS.blockedFolderId]
		);
		const favoritedFolderId = normalizeStoredFolderId(
			result?.[LEGACY_STORAGE_KEYS.favoritedFolderId]
		);
		if (blockedFolderId) {
			rules.push({ folderId: blockedFolderId, style: "blocked" });
		}
		if (favoritedFolderId) {
			rules.push({ folderId: favoritedFolderId, style: "favorited" });
		}
	}

	if (!rules.some(isUnmatchedBookmarkRule)) {
		rules.push({
			folderId: UNMATCHED_BOOKMARK_RULE_ID,
			style: migrateUnmatchedBookmarkStyle(result)
		});
	}

	return normalizeBookmarkRules(rules);
}

function listPresentLegacyStorageKeys(result) {
	return Object.values(LEGACY_STORAGE_KEYS).filter(
		key => result && Object.prototype.hasOwnProperty.call(result, key)
	);
}

/**
 * Persist migrated current-format keys and delete legacy keys when present.
 * Safe to call on every startup; no-ops when already migrated.
 * Bookmark-folder URLs are imported only when `sites` is missing.
 */
function purgeLegacyStorage(result) {
	const legacyKeys = listPresentLegacyStorageKeys(result);
	const needsSites = !Array.isArray(result?.sites);
	const needsStyles = !Array.isArray(result?.styleRules);
	const sites = needsSites
		? migrateSitesFromStorage(result)
		: loadSitesFromStorageResult(result, { preserveLinks: true });
	const defaultStyles = () => DEFAULT_STYLE_RULES.map(rule => ({ ...rule }));

	const persistConfig = merged => {
		const writes = {};
		if (needsSites) Object.assign(writes, buildSitesStorageWrites(merged));
		if (needsStyles) writes[STORAGE_KEYS.styleRules] = defaultStyles();
		if (Object.keys(writes).length === 0) return Promise.resolve(merged);
		return browser.storage.local.set(writes).then(() => merged);
	};

	const persistSites = needsSites
		? importBookmarkFolderLinksIntoSites(result, sites).then(persistConfig)
		: persistConfig(sites);

	return persistSites
		.then(merged => (
			legacyKeys.length > 0
				? browser.storage.local.remove(legacyKeys).then(() => merged)
				: merged
		));
}

function parseCommaSeparatedValues(value) {
	return typeof value === "string"
		? value.split(',').map(item => item.trim()).filter(Boolean)
		: [];
}

function parseClassGroups(value) {
	return parseCommaSeparatedValues(value)
		.map(classGroup => classGroup.split(/\s+/).filter(Boolean).join(' '))
		.filter(Boolean);
}

function getClassGroupKey(classGroup) {
	return String(classGroup || "").split(/\s+/).filter(Boolean).sort().join('\u0000');
}

function mergeRowsBySite(rows, valueKey, parseValues, getValueKey = value => value) {
	const rowsBySite = new Map();

	for (const row of rows || []) {
		const site = normalizeSite(row.site);
		if (!site) continue;

		if (!rowsBySite.has(site)) {
			rowsBySite.set(site, new Map());
		}

		const values = rowsBySite.get(site);
		for (const value of parseValues(row[valueKey])) {
			const key = getValueKey(value);
			if (!values.has(key)) {
				values.set(key, value);
			}
		}
	}

	return Array.from(rowsBySite, ([site, values]) => ({
		site,
		[valueKey]: Array.from(values.values()).join(', ')
	})).filter(row => row[valueKey]);
}

function normalizeSearchPairs(pairs) {
	const rows = (pairs || []).map(pair => ({
		site: pair?.site,
		classes: typeof pair?.classes === "string"
			? pair.classes
			: pair?.tag
	}));
	return mergeRowsBySite(rows, "classes", parseClassGroups, getClassGroupKey);
}

function mergeClassGroupIntoSearchPairs(existingPairs, site, classGroup) {
	return normalizeSearchPairs([
		...(existingPairs || []),
		{ site, classes: classGroup }
	]);
}

function createEmptySiteConfig(site) {
	return {
		site: normalizeSite(site),
		classGroups: [],
		keepParams: "",
		textRules: [],
		links: [],
		linkFolders: []
	};
}

function normalizeClassGroupList(classGroups) {
	const seen = new Set();
	const normalized = [];
	const values = Array.isArray(classGroups)
		? classGroups
		: parseClassGroups(classGroups);
	for (const group of values) {
		const parsed = parseClassGroups(
			typeof group === "string" ? group : ""
		)[0];
		if (!parsed) continue;
		const key = getClassGroupKey(parsed);
		if (seen.has(key)) continue;
		seen.add(key);
		normalized.push(parsed);
	}
	return normalized;
}

function normalizeSiteTextRule(rule, fallbackStyle = "blocked") {
	if (!rule || typeof rule.text !== "string") return null;
	const text = rule.text.trim();
	if (!text) return null;
	return {
		text,
		style: typeof rule.style === "string" && rule.style.trim()
			? rule.style.trim()
			: fallbackStyle
	};
}

function normalizeSavedLinkTitle(value) {
	if (typeof value !== "string") return "";
	const title = value.replace(/\s+/g, " ").trim();
	if (!title || isValidHttpUrl(title)) return "";
	return title.length > 200 ? `${title.slice(0, 197).trimEnd()}…` : title;
}

function titleFromPageContext(linkText, pageTitle) {
	return normalizeSavedLinkTitle(linkText) || normalizeSavedLinkTitle(pageTitle);
}

function normalizeSavedLink(link, fallbackStyle = "blocked") {
	if (!link || typeof link.url !== "string") return null;
	const url = link.url.trim();
	if (!url || !isValidHttpUrl(url)) return null;
	return {
		url,
		title: normalizeSavedLinkTitle(link.title),
		style: typeof link.style === "string" && link.style.trim()
			? link.style.trim()
			: fallbackStyle
	};
}

function normalizeLinkFolderIds(folderIds, links) {
	const seen = new Set();
	const ids = [];
	for (const id of folderIds || []) {
		const styleId = typeof id === "string" ? id.trim() : "";
		if (!styleId || seen.has(styleId)) continue;
		seen.add(styleId);
		ids.push(styleId);
	}
	for (const link of links || []) {
		const styleId = typeof link?.style === "string" ? link.style.trim() : "";
		if (!styleId || seen.has(styleId)) continue;
		seen.add(styleId);
		ids.push(styleId);
	}
	return ids;
}

function addLinkFolderId(folderIds, styleId) {
	const next = Array.isArray(folderIds) ? folderIds.slice() : [];
	const id = typeof styleId === "string" ? styleId.trim() : "";
	if (!id || next.includes(id)) return next;
	next.push(id);
	return next;
}

function normalizeKeepParams(value) {
	return parseCommaSeparatedValues(value).join(", ");
}

function siteConfigToStorageMeta(siteConfig) {
	if (!siteConfig || typeof siteConfig !== "object") return null;
	const site = normalizeSite(siteConfig.site) || siteConfig.site;
	if (!site) return null;
	return {
		site,
		classGroups: Array.isArray(siteConfig.classGroups) ? siteConfig.classGroups : [],
		keepParams: typeof siteConfig.keepParams === "string" ? siteConfig.keepParams : "",
		textRules: Array.isArray(siteConfig.textRules) ? siteConfig.textRules : [],
		linkFolders: Array.isArray(siteConfig.linkFolders) ? siteConfig.linkFolders : []
	};
}

function siteLinksByHostFromSites(sites) {
	const byHost = {};
	for (const siteConfig of sites || []) {
		if (!siteConfig?.site) continue;
		byHost[siteConfig.site] = Array.isArray(siteConfig.links) ? siteConfig.links : [];
	}
	return byHost;
}

function savedLinkKey(link) {
	return typeof link?.url === "string" ? link.url.trim() : "";
}

function cloneSavedLink(link) {
	return {
		url: typeof link?.url === "string" ? link.url : "",
		title: typeof link?.title === "string" ? link.title : "",
		style: typeof link?.style === "string" ? link.style : ""
	};
}

function savedLinksEqual(a, b) {
	if (a === b) return true;
	if (!a || !b) return false;
	return savedLinkKey(a) === savedLinkKey(b) &&
		(a.title || "") === (b.title || "") &&
		(a.style || "") === (b.style || "");
}

function linksByKey(links) {
	const map = new Map();
	for (const link of links || []) {
		const key = savedLinkKey(link);
		if (!key || map.has(key)) continue;
		map.set(key, link);
	}
	return map;
}

function mergeSavedLinkConflict(baseLink, ourLink, theirLink) {
	const baseTitle = baseLink?.title || "";
	const baseStyle = baseLink?.style || "";
	return {
		url: theirLink.url || ourLink.url,
		title: (ourLink.title || "") !== baseTitle
			? (ourLink.title || "")
			: (theirLink.title || ""),
		style: (theirLink.style || "") !== baseStyle
			? (theirLink.style || "")
			: (ourLink.style || "")
	};
}

/**
 * Three-way merge of saved links so options-page edits and live page
 * adds/toggles (look shortcuts, context menus) can both survive a save.
 */
function mergeSavedLinksThreeWay(baseLinks = [], ourLinks = [], theirLinks = []) {
	const base = linksByKey(baseLinks);
	const theirs = linksByKey(theirLinks);
	const seen = new Set();
	const merged = [];

	for (const link of ourLinks || []) {
		const key = savedLinkKey(link);
		if (!key || seen.has(key)) continue;
		seen.add(key);
		const baseLink = base.get(key);
		const theirLink = theirs.get(key);

		if (!theirLink) {
			if (!baseLink || !savedLinksEqual(link, baseLink)) {
				merged.push(cloneSavedLink(link));
			}
			continue;
		}

		if (!baseLink || savedLinksEqual(link, baseLink)) {
			merged.push(cloneSavedLink(theirLink));
		} else if (savedLinksEqual(theirLink, baseLink)) {
			merged.push(cloneSavedLink(link));
		} else {
			merged.push(mergeSavedLinkConflict(baseLink, link, theirLink));
		}
	}

	for (const link of theirLinks || []) {
		const key = savedLinkKey(link);
		if (!key || seen.has(key)) continue;
		seen.add(key);
		if (!base.has(key)) {
			merged.push(cloneSavedLink(link));
		}
	}

	return merged;
}

function mergeSitesLinksFromStorage(draftSites, baseLinksByHost, storageSites) {
	const theirByHost = new Map();
	for (const siteConfig of storageSites || []) {
		if (!siteConfig?.site) continue;
		theirByHost.set(siteConfig.site, siteConfig);
	}

	const merged = [];
	for (const ourSite of draftSites || []) {
		const host = ourSite?.site;
		if (!host) continue;
		const theirSite = theirByHost.get(host);
		theirByHost.delete(host);
		const mergedLinks = mergeSavedLinksThreeWay(
			baseLinksByHost?.[host] || [],
			ourSite.links || [],
			theirSite?.links || []
		);
		merged.push({
			...ourSite,
			links: mergedLinks,
			linkFolders: normalizeLinkFolderIds(ourSite.linkFolders, mergedLinks)
		});
	}

	for (const theirSite of theirByHost.values()) {
		const host = theirSite.site;
		if (baseLinksByHost && Object.prototype.hasOwnProperty.call(baseLinksByHost, host)) {
			continue;
		}
		const links = Array.isArray(theirSite.links)
			? theirSite.links.map(cloneSavedLink)
			: [];
		merged.push({
			...theirSite,
			links,
			linkFolders: normalizeLinkFolderIds(theirSite.linkFolders, links)
		});
	}

	return merged;
}

function mergeSiteLinksIntoSites(sites, siteLinksByHost) {
	const hasSplit = siteLinksByHost &&
		typeof siteLinksByHost === "object" &&
		!Array.isArray(siteLinksByHost);
	return (Array.isArray(sites) ? sites : []).map(siteConfig => {
		if (!siteConfig || typeof siteConfig !== "object") return siteConfig;
		if (!hasSplit) return siteConfig;
		const host = siteConfig.site;
		return {
			...siteConfig,
			links: host && Array.isArray(siteLinksByHost[host])
				? siteLinksByHost[host]
				: []
		};
	});
}

function sitesHaveEmbeddedLinks(sites) {
	return (Array.isArray(sites) ? sites : []).some(
		siteConfig => Array.isArray(siteConfig?.links) && siteConfig.links.length > 0
	);
}

function buildSitesStorageWrites(sites) {
	return {
		[STORAGE_KEYS.sites]: (sites || []).map(siteConfigToStorageMeta).filter(Boolean),
		[STORAGE_KEYS.siteLinks]: siteLinksByHostFromSites(sites)
	};
}

function loadSitesFromStorageResult(result, options = {}) {
	const merged = mergeSiteLinksIntoSites(
		result?.sites,
		result?.[STORAGE_KEYS.siteLinks]
	);
	return normalizeSites(merged, options);
}

function normalizeSiteConfig(siteConfig, options = {}) {
	if (!siteConfig || typeof siteConfig !== "object") return null;
	const site = normalizeSite(siteConfig.site);
	if (!site) return null;
	const preserveLinks = options.preserveLinks === true;

	const textSeen = new Set();
	const textRules = [];
	for (const rule of siteConfig.textRules || []) {
		const normalized = normalizeSiteTextRule(rule);
		if (!normalized) continue;
		const key = normalized.text.toLowerCase();
		if (textSeen.has(key)) continue;
		textSeen.add(key);
		textRules.push(normalized);
	}

	let links;
	if (preserveLinks) {
		links = Array.isArray(siteConfig.links) ? siteConfig.links : [];
	} else {
		const linkSeen = new Set();
		links = [];
		for (const link of siteConfig.links || []) {
			const normalized = normalizeSavedLink(link);
			if (!normalized) continue;
			if (linkSeen.has(normalized.url)) continue;
			linkSeen.add(normalized.url);
			links.push(normalized);
		}
	}

	const folderLinks = preserveLinks && (siteConfig.linkFolders || []).length
		? []
		: links;

	return {
		site,
		classGroups: normalizeClassGroupList(siteConfig.classGroups),
		keepParams: normalizeKeepParams(siteConfig.keepParams),
		textRules,
		links,
		linkFolders: normalizeLinkFolderIds(siteConfig.linkFolders, folderLinks)
	};
}

function normalizeSites(sites, options = {}) {
	if (!Array.isArray(sites)) return [];

	const bySite = new Map();
	for (const raw of sites) {
		const siteConfig = normalizeSiteConfig(raw, options);
		if (!siteConfig) continue;

		const existing = bySite.get(siteConfig.site);
		if (!existing) {
			bySite.set(siteConfig.site, siteConfig);
			continue;
		}

		existing.classGroups = normalizeClassGroupList([
			...existing.classGroups,
			...siteConfig.classGroups
		]);
		if (!existing.keepParams && siteConfig.keepParams) {
			existing.keepParams = siteConfig.keepParams;
		}

		const textSeen = new Set(
			existing.textRules.map(rule => rule.text.toLowerCase())
		);
		for (const rule of siteConfig.textRules) {
			const key = rule.text.toLowerCase();
			if (textSeen.has(key)) continue;
			textSeen.add(key);
			existing.textRules.push(rule);
		}

		const linkSeen = new Set(existing.links.map(link => link.url));
		for (const link of siteConfig.links) {
			if (linkSeen.has(link.url)) continue;
			linkSeen.add(link.url);
			existing.links.push(link);
		}
		existing.linkFolders = normalizeLinkFolderIds(
			[...existing.linkFolders, ...siteConfig.linkFolders],
			existing.links
		);
	}

	return Array.from(bySite.values()).sort((a, b) =>
		a.site.localeCompare(b.site)
	);
}

function ensureSiteConfig(sites, site) {
	const hostname = normalizeSite(site);
	const next = Array.isArray(sites) ? sites.slice() : [];
	if (!hostname) return { sites: next, siteConfig: null };

	let siteConfig = next.find(entry => entry.site === hostname);
	if (!siteConfig) {
		siteConfig = createEmptySiteConfig(hostname);
		next.push(siteConfig);
		next.sort((a, b) => a.site.localeCompare(b.site));
	}
	return { sites: next, siteConfig };
}

function mergeClassGroupIntoSites(sites, site, classGroup) {
	const { sites: next, siteConfig } = ensureSiteConfig(sites, site);
	if (!siteConfig) return next;
	siteConfig.classGroups = normalizeClassGroupList([
		...siteConfig.classGroups,
		classGroup
	]);
	return next;
}

function upsertSiteLink(sites, url, title, styleId) {
	if (!isValidHttpUrl(url)) return sites;
	let hostname = "";
	try {
		hostname = normalizeSite(new URL(url).hostname);
	} catch {
		return sites;
	}

	const { sites: next, siteConfig } = ensureSiteConfig(sites, hostname);
	if (!siteConfig) return next;
	if (!Array.isArray(siteConfig.links)) siteConfig.links = [];

	const pageKey = hrefMatchKey(url);
	const existingIndex = siteConfig.links.findIndex(link =>
		link?.url && hrefMatchKey(link.url) === pageKey
	);
	const saved = {
		url: normalizeHrefForSearch(url),
		title: normalizeSavedLinkTitle(title),
		style: typeof styleId === "string" && styleId.trim()
			? styleId.trim()
			: "blocked"
	};
	if (existingIndex >= 0) {
		if (!saved.title) saved.title = siteConfig.links[existingIndex].title;
		siteConfig.links[existingIndex] = saved;
	} else {
		siteConfig.links.push(saved);
	}
	siteConfig.linkFolders = addLinkFolderId(siteConfig.linkFolders, saved.style);
	return next;
}

function toggleSiteLookShortcut(sites, url, title, styleId) {
	if (!isValidHttpUrl(url) || typeof styleId !== "string" || !styleId.trim()) {
		return sites;
	}

	let hostname = "";
	try {
		hostname = new URL(url).hostname;
	} catch {
		return sites;
	}

	const next = Array.isArray(sites) ? sites : [];
	const siteConfig = findMatchingSiteConfig(next, hostname);
	if (!siteConfig) return next;
	if (!Array.isArray(siteConfig.links)) siteConfig.links = [];

	const lookId = styleId.trim();
	const pageKey = hrefMatchKey(url);
	const existingIndex = siteConfig.links.findIndex(link =>
		link?.url && hrefMatchKey(link.url) === pageKey
	);
	const existing = existingIndex >= 0 ? siteConfig.links[existingIndex] : null;
	if (existing && existing.style === lookId) {
		siteConfig.links.splice(existingIndex, 1);
		return next;
	}

	const saved = {
		url: normalizeHrefForSearch(url),
		title: normalizeSavedLinkTitle(title),
		style: lookId
	};
	if (existingIndex >= 0) {
		if (!saved.title) saved.title = siteConfig.links[existingIndex].title;
		siteConfig.links[existingIndex] = saved;
	} else {
		siteConfig.links.push(saved);
	}
	siteConfig.linkFolders = addLinkFolderId(siteConfig.linkFolders, saved.style);
	return next;
}

function addTextRuleToSites(sites, site, text, styleId) {
	const { sites: next, siteConfig } = ensureSiteConfig(sites, site);
	if (!siteConfig) return next;
	const rule = normalizeSiteTextRule({ text, style: styleId });
	if (!rule) return next;
	const key = rule.text.toLowerCase();
	const existingIndex = siteConfig.textRules.findIndex(
		entry => entry.text.toLowerCase() === key
	);
	if (existingIndex >= 0) {
		siteConfig.textRules[existingIndex] = rule;
	} else {
		siteConfig.textRules.push(rule);
	}
	return next;
}

function migrateSitesFromStorage(result) {
	if (Array.isArray(result?.sites)) {
		return loadSitesFromStorageResult(result);
	}

	const bySite = new Map();
	function ensure(site) {
		const hostname = normalizeSite(site);
		if (!hostname) return null;
		if (!bySite.has(hostname)) {
			bySite.set(hostname, createEmptySiteConfig(hostname));
		}
		return bySite.get(hostname);
	}

	for (const pair of normalizeSearchPairs(
		result?.[LEGACY_STORAGE_KEYS.searchPairs] || result?.searchPairs
	)) {
		const siteConfig = ensure(pair.site);
		if (!siteConfig) continue;
		siteConfig.classGroups = normalizeClassGroupList(pair.classes);
	}

	const urlRules = result?.[LEGACY_STORAGE_KEYS.urlRules] || result?.urlRules;
	if (Array.isArray(urlRules)) {
		for (const rule of urlRules) {
			const siteConfig = ensure(rule?.site);
			if (!siteConfig) continue;
			siteConfig.keepParams = normalizeKeepParams(rule.keepParams);
		}
	}

	for (const rule of migrateTextRulesFromStorage(result)) {
		const siteConfig = ensure(rule.site);
		if (!siteConfig) continue;
		const textRule = normalizeSiteTextRule(rule);
		if (!textRule) continue;
		siteConfig.textRules.push(textRule);
	}

	return normalizeSites(Array.from(bySite.values()));
}

function mergeBookmarkLinksBySiteIntoSites(sites, linksBySite) {
	let next = Array.isArray(sites) ? sites.slice() : [];
	const existingHosts = new Set(next.map(siteConfig => siteConfig.site));
	let sitesCreated = 0;
	let linksAdded = 0;
	let linksSkipped = 0;

	for (const [hostname, links] of linksBySite || []) {
		const existed = existingHosts.has(hostname);
		const { sites: merged, siteConfig } = ensureSiteConfig(next, hostname);
		next = merged;
		if (!siteConfig) continue;
		if (!existed) {
			sitesCreated += 1;
			existingHosts.add(hostname);
		}
		if (!Array.isArray(siteConfig.links)) siteConfig.links = [];

		const seen = new Set(siteConfig.links.map(link => link.url));
		for (const link of links || []) {
			const saved = normalizeSavedLink(link);
			if (!saved) continue;
			siteConfig.linkFolders = addLinkFolderId(siteConfig.linkFolders, saved.style);
			if (seen.has(saved.url)) {
				linksSkipped += 1;
				continue;
			}
			seen.add(saved.url);
			siteConfig.links.push(saved);
			linksAdded += 1;
		}
	}

	return {
		sites: next,
		sitesCreated,
		sitesTouched: (linksBySite && linksBySite.size) || 0,
		linksAdded,
		linksSkipped
	};
}

function importBookmarkFolderIntoSites(sites, folderId, styleId, hostFilter) {
	const style = typeof styleId === "string" ? styleId.trim() : "";
	if (!folderId || !style) {
		return Promise.resolve({
			sites: normalizeSites(sites),
			sitesCreated: 0,
			sitesTouched: 0,
			linksAdded: 0,
			linksSkipped: 0
		});
	}
	if (!browser.bookmarks) {
		return Promise.reject(new Error("Bookmark folders are not available"));
	}

	const host = hostFilter ? normalizeSite(hostFilter) : "";

	return loadBookmarkSubtree(folderId).then(tree => {
		const linksBySite = new Map();
		collectBookmarkUrlsFromTree(tree, style, linksBySite);
		if (host) {
			const links = linksBySite.get(host) || [];
			linksBySite.clear();
			if (links.length > 0) {
				linksBySite.set(host, links);
			}
		}
		return mergeBookmarkLinksBySiteIntoSites(sites, linksBySite);
	});
}

function escapeBookmarkHtml(value) {
	return String(value ?? "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function lookNameForBookmarkExport(styleId, styleRules) {
	const id = typeof styleId === "string" && styleId.trim() ? styleId.trim() : "blocked";
	const rule = (styleRules || []).find(entry => entry.id === id);
	return (rule?.name || "").trim() || id;
}

function groupSiteLinksByLook(siteConfig) {
	const groups = new Map();
	for (const id of siteConfig?.linkFolders || []) {
		const styleId = typeof id === "string" ? id.trim() : "";
		if (!styleId || groups.has(styleId)) continue;
		groups.set(styleId, []);
	}
	for (const link of siteConfig?.links || []) {
		const saved = normalizeSavedLink(link);
		if (!saved) continue;
		if (!groups.has(saved.style)) groups.set(saved.style, []);
		groups.get(saved.style).push(saved);
	}
	return groups;
}

function bookmarkExportLookGroups(siteConfig) {
	const groups = new Map();
	for (const [styleId, links] of groupSiteLinksByLook(siteConfig)) {
		if (!links.length) continue;
		groups.set(styleId, links);
	}
	return groups;
}

function siteHasBookmarkExportLinks(siteConfig) {
	return bookmarkExportLookGroups(siteConfig).size > 0;
}

function renderBookmarkFolderHtml(name, inner, indent, addDate) {
	const pad = "    ".repeat(indent);
	const heading = `<DT><H3 ADD_DATE="${addDate}">${escapeBookmarkHtml(name)}</H3>`;
	return `${pad}${heading}\n${pad}<DL><p>\n${inner || ""}${pad}</DL><p>\n`;
}

function renderBookmarkLinkHtml(link, indent, addDate) {
	const pad = "    ".repeat(indent);
	const title = link.title || link.url;
	return `${pad}<DT><A HREF="${escapeBookmarkHtml(link.url)}" ADD_DATE="${addDate}">${escapeBookmarkHtml(title)}</A>\n`;
}

function renderSiteBookmarkFolderHtml(siteConfig, styleRules, indent, addDate) {
	const host = siteConfig?.site || "";
	if (!host) return "";
	const groups = bookmarkExportLookGroups(siteConfig);
	if (groups.size === 0) return "";
	let inner = "";
	for (const [styleId, links] of groups) {
		const lookInner = links
			.map(link => renderBookmarkLinkHtml(link, indent + 2, addDate))
			.join("");
		inner += renderBookmarkFolderHtml(
			lookNameForBookmarkExport(styleId, styleRules),
			lookInner,
			indent + 1,
			addDate
		);
	}
	return renderBookmarkFolderHtml(host, inner, indent, addDate);
}

function countBookmarkExportLinks(sites) {
	let count = 0;
	for (const siteConfig of sites || []) {
		for (const link of siteConfig?.links || []) {
			if (normalizeSavedLink(link)) count += 1;
		}
	}
	return count;
}

function buildNetscapeBookmarkHtml(sites, styleRules, options = {}) {
	const addDate = String(Math.floor(Date.now() / 1000));
	const list = (Array.isArray(sites) ? sites : [])
		.filter(siteHasBookmarkExportLinks)
		.sort((a, b) => (a.site || "").localeCompare(b.site || ""));
	const indent = options.rootFolderName ? 1 : 0;
	let inner = list
		.map(siteConfig => renderSiteBookmarkFolderHtml(siteConfig, styleRules, indent, addDate))
		.join("");
	if (options.rootFolderName) {
		inner = renderBookmarkFolderHtml(options.rootFolderName, inner, 0, addDate);
	}
	return [
		"<!DOCTYPE NETSCAPE-Bookmark-file-1>",
		"<!-- This is an automatically generated file.",
		"     It will be processed by the browser as such. -->",
		'<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
		"<TITLE>Bookmarks</TITLE>",
		"<H1>Bookmarks</H1>",
		"<DL><p>",
		inner.replace(/\n$/, ""),
		"</DL><p>",
		""
	].join("\n");
}

function asBookmarkNodeArray(tree) {
	if (Array.isArray(tree)) return tree.filter(Boolean);
	if (tree && typeof tree === "object") return [tree];
	return [];
}

function findBookmarkNodeById(nodes, id) {
	const wanted = String(id || "");
	if (!wanted) return null;
	for (const node of asBookmarkNodeArray(nodes)) {
		if (node && String(node.id) === wanted) return node;
		if (node && node.children) {
			const found = findBookmarkNodeById(node.children, wanted);
			if (found) return found;
		}
	}
	return null;
}

function hydrateBookmarkNode(node) {
	if (!node || node.url || node.type === "bookmark" || node.type === "separator") {
		return Promise.resolve(node);
	}
	if (Array.isArray(node.children)) {
		return Promise.all(node.children.map(hydrateBookmarkNode)).then(children => {
			node.children = children;
			return node;
		});
	}
	if (!browser.bookmarks || typeof browser.bookmarks.getChildren !== "function") {
		return Promise.resolve(node);
	}
	return browser.bookmarks.getChildren(node.id)
		.then(children => Promise.all((children || []).map(hydrateBookmarkNode)))
		.then(children => {
			node.children = children;
			return node;
		})
		.catch(() => node);
}

function loadBookmarkSubtree(folderId) {
	const id = typeof folderId === "string" || typeof folderId === "number"
		? String(folderId)
		: "";
	if (!id || !browser.bookmarks) {
		return Promise.reject(new Error("Bookmark folders are not available"));
	}

	const fromSubTree = () => {
		if (typeof browser.bookmarks.getSubTree !== "function") {
			return Promise.reject(new Error("getSubTree unavailable"));
		}
		try {
			return Promise.resolve(browser.bookmarks.getSubTree(id)).then(tree => {
				const nodes = asBookmarkNodeArray(tree);
				if (nodes.length === 0) {
					throw new Error("Empty bookmark subtree");
				}
				return nodes;
			});
		} catch (error) {
			return Promise.reject(error);
		}
	};

	const fromTreeScan = () => {
		if (typeof browser.bookmarks.getTree !== "function") {
			return Promise.reject(new Error("Bookmark folders are not available"));
		}
		return browser.bookmarks.getTree().then(tree => {
			const folder = findBookmarkNodeById(tree, id);
			if (!folder) {
				throw new Error("That bookmark folder is no longer available");
			}
			return [folder];
		});
	};

	const fromGet = () => {
		if (typeof browser.bookmarks.get !== "function") {
			return Promise.reject(new Error("Bookmark folders are not available"));
		}
		return browser.bookmarks.get(id).then(nodes => {
			const folder = asBookmarkNodeArray(nodes)[0];
			if (!folder) {
				throw new Error("That bookmark folder is no longer available");
			}
			return [folder];
		});
	};

	return fromSubTree()
		.catch(() => fromTreeScan())
		.catch(() => fromGet())
		.then(nodes => Promise.all(nodes.map(hydrateBookmarkNode)));
}

function collectBookmarkUrlsFromTree(nodes, style, linksBySite) {
	for (const node of asBookmarkNodeArray(nodes)) {
		if (node && node.url && isValidHttpUrl(node.url)) {
			let hostname = "";
			try {
				hostname = normalizeSite(new URL(node.url).hostname);
			} catch {
				hostname = "";
			}
			if (hostname) {
				if (!linksBySite.has(hostname)) {
					linksBySite.set(hostname, []);
				}
				linksBySite.get(hostname).push({
					url: node.url,
					title: normalizeSavedLinkTitle(node.title),
					style
				});
			}
		}
		if (node && Array.isArray(node.children)) {
			collectBookmarkUrlsFromTree(node.children, style, linksBySite);
		}
	}
}

function importBookmarkFolderLinksIntoSites(result, sites) {
	const folderRules = migrateBookmarkRulesFromStorage(result)
		.filter(rule => !isUnmatchedBookmarkRule(rule));
	if (folderRules.length === 0) return Promise.resolve(normalizeSites(sites));
	if (!browser.bookmarks) {
		return Promise.resolve(normalizeSites(sites));
	}

	return Promise.all(folderRules.map(rule =>
		loadBookmarkSubtree(rule.folderId)
			.then(tree => ({ tree, style: rule.style }))
			.catch(() => null)
	)).then(results => {
		const linksBySite = new Map();
		for (const entry of results) {
			if (!entry) continue;
			collectBookmarkUrlsFromTree(entry.tree, entry.style, linksBySite);
		}
		return mergeBookmarkLinksBySiteIntoSites(sites, linksBySite).sites;
	}).catch(() => normalizeSites(sites));
}

function lookNameKey(name) {
	return typeof name === "string" ? name.trim().toLowerCase() : "";
}

function bookmarkNodeTitle(node) {
	return String(node?.title || "").trim();
}

function isBookmarkSeparatorNode(node) {
	return !!node && node.type === "separator";
}

function isBookmarkLinkNode(node) {
	if (!node || isBookmarkSeparatorNode(node)) return false;
	if (node.type === "bookmark") return true;
	return typeof node.url === "string" && node.url.length > 0;
}

function isBookmarkFolderNode(node) {
	if (!node || isBookmarkSeparatorNode(node) || isBookmarkLinkNode(node)) return false;
	return node.type === "folder" || !node.url;
}

function findLookNameCollisions(styleRules) {
	const byKey = new Map();
	for (const rule of styleRules || []) {
		const key = lookNameKey(rule?.name);
		if (!key) continue;
		if (!byKey.has(key)) byKey.set(key, []);
		byKey.get(key).push(rule);
	}
	const collisions = [];
	for (const rules of byKey.values()) {
		if (rules.length < 2) continue;
		collisions.push({
			names: rules.map(rule => rule.name),
			ids: rules.map(rule => rule.id)
		});
	}
	return collisions;
}

function formatLookNameCollisionMessage(collision) {
	const quoted = (collision?.names || []).map(name => `"${name}"`).join(" and ");
	return `${quoted} share the same name (ignoring case). Rename them on the Looks tab so each name is unique.`;
}

function cloneSitesForStructuredImport(sites) {
	return (Array.isArray(sites) ? sites : []).map(siteConfig => ({
		...siteConfig,
		classGroups: Array.isArray(siteConfig.classGroups) ? siteConfig.classGroups.slice() : [],
		textRules: Array.isArray(siteConfig.textRules) ? siteConfig.textRules.slice() : [],
		links: Array.isArray(siteConfig.links) ? siteConfig.links.slice() : [],
		linkFolders: Array.isArray(siteConfig.linkFolders) ? siteConfig.linkFolders.slice() : []
	}));
}

function structuredImportError(message, path) {
	return path ? { path, message } : { message };
}

function parseStructuredBookmarkTree(nodes, styleRules) {
	const errors = [];
	const rules = normalizeStyleRules(styleRules);
	const collisions = findLookNameCollisions(rules);
	for (const collision of collisions) {
		errors.push(structuredImportError(formatLookNameCollisionMessage(collision)));
	}

	const roots = asBookmarkNodeArray(nodes);
	const root = roots[0];
	if (!root) {
		errors.push(structuredImportError("That bookmark folder is empty or no longer available."));
		return { errors, sites: new Map(), createdLooks: [] };
	}
	if (isBookmarkLinkNode(root) || isBookmarkSeparatorNode(root)) {
		errors.push(structuredImportError(
			"The linked item must be a bookmark folder whose children are site folders."
		));
		return { errors, sites: new Map(), createdLooks: [] };
	}

	const lookIdByKey = new Map();
	for (const rule of rules) {
		const key = lookNameKey(rule.name);
		if (key && !lookIdByKey.has(key)) lookIdByKey.set(key, rule.id);
	}

	const createdLooks = [];
	const createdByKey = new Map();
	const canResolveLooks = collisions.length === 0;

	function resolveLook(folderName, { createIfMissing }) {
		const key = lookNameKey(folderName);
		if (!key || !canResolveLooks) return null;
		if (lookIdByKey.has(key)) {
			return { id: lookIdByKey.get(key), key, name: folderName.trim() };
		}
		if (!createIfMissing) return { id: "", key, name: folderName.trim() };
		if (createdByKey.has(key)) return createdByKey.get(key);
		const created = {
			id: createStyleRuleId(),
			key,
			name: folderName.trim(),
			kind: "custom",
			predefined: "",
			css: "",
			shortcutIcon: "",
			shortcutColor: DEFAULT_SHORTCUT_COLOR
		};
		createdByKey.set(key, created);
		lookIdByKey.set(key, created.id);
		createdLooks.push(created);
		return created;
	}

	const sites = new Map();
	let sawNonHostnameFolder = false;

	function ensureParsedSite(host) {
		if (!sites.has(host)) {
			sites.set(host, {
				host,
				lookKeys: new Set(),
				lookIds: new Set(),
				linksByLook: new Map()
			});
		}
		return sites.get(host);
	}

	for (const child of root.children || []) {
		if (isBookmarkSeparatorNode(child)) continue;
		if (isBookmarkLinkNode(child)) {
			const label = bookmarkNodeTitle(child) || child.url || "Untitled bookmark";
			errors.push(structuredImportError(
				`Unexpected bookmark "${label}" at the top of the linked folder. Only site folders are allowed here.`,
				label
			));
			continue;
		}
		if (!isBookmarkFolderNode(child)) {
			errors.push(structuredImportError(
				"The linked folder contains an item that is not a site folder.",
				bookmarkNodeTitle(child) || "Untitled"
			));
			continue;
		}

		const siteTitle = bookmarkNodeTitle(child) || "Untitled folder";
		if (!isPlausibleHostname(siteTitle)) {
			sawNonHostnameFolder = true;
			errors.push(structuredImportError(
				`Folder "${siteTitle}" is not a website hostname. Rename it to a hostname such as example.com.`,
				siteTitle
			));
			continue;
		}

		const host = normalizeSite(siteTitle);
		const parsedSite = ensureParsedSite(host);

		for (const lookChild of child.children || []) {
			if (isBookmarkSeparatorNode(lookChild)) continue;
			if (isBookmarkLinkNode(lookChild)) {
				const label = bookmarkNodeTitle(lookChild) || lookChild.url || "Untitled bookmark";
				errors.push(structuredImportError(
					`Site folder "${siteTitle}" contains a bookmark that is not inside a look folder. Put "${label}" in a look folder such as Blocked.`,
					host
				));
				continue;
			}
			if (!isBookmarkFolderNode(lookChild)) {
				errors.push(structuredImportError(
					`Site folder "${siteTitle}" contains an item that is not a look folder.`,
					host
				));
				continue;
			}

			const lookTitle = bookmarkNodeTitle(lookChild);
			if (!lookTitle) {
				errors.push(structuredImportError(
					`Site folder "${siteTitle}" contains a look folder with no name.`,
					host
				));
				continue;
			}

			const lookKey = lookNameKey(lookTitle);
			parsedSite.lookKeys.add(lookKey);
			const existingLook = resolveLook(lookTitle, { createIfMissing: false });
			if (existingLook?.id) parsedSite.lookIds.add(existingLook.id);

			for (const linkChild of lookChild.children || []) {
				if (isBookmarkSeparatorNode(linkChild)) continue;
				if (isBookmarkFolderNode(linkChild)) {
					const extra = bookmarkNodeTitle(linkChild) || "Untitled folder";
					errors.push(structuredImportError(
						`Look folders cannot contain other folders. Move or remove "${extra}" from "${lookTitle}".`,
						`${host} / ${lookTitle} / ${extra}`
					));
					continue;
				}
				if (!isBookmarkLinkNode(linkChild)) {
					errors.push(structuredImportError(
						`Look folder "${lookTitle}" contains an item that is not a bookmark.`,
						`${host} / ${lookTitle}`
					));
					continue;
				}
				if (!parsedSite.linksByLook.has(lookKey)) {
					parsedSite.linksByLook.set(lookKey, {
						folderName: lookTitle,
						nodes: []
					});
				}
				parsedSite.linksByLook.get(lookKey).nodes.push(linkChild);
			}
		}
	}

	if (sawNonHostnameFolder) {
		errors.push(structuredImportError(
			"The linked folder's children must be site hostnames (example.com). If you imported a bookmarks HTML file, select the inner folder whose children are site names, not the outer Imported folder."
		));
	}

	if (errors.length > 0) {
		return { errors, sites: new Map(), createdLooks: [] };
	}

	for (const parsedSite of sites.values()) {
		for (const [lookKey, group] of parsedSite.linksByLook) {
			let importedAny = false;
			for (const node of group.nodes) {
				if (!isValidHttpUrl(node.url)) continue;
				let linkHost = "";
				try {
					linkHost = normalizeSite(new URL(node.url).hostname);
				} catch {
					linkHost = "";
				}
				if (linkHost !== parsedSite.host) continue;
				if (!normalizeSavedLink({
					url: node.url,
					title: node.title,
					style: "blocked"
				})) continue;
				importedAny = true;
				break;
			}
			if (!importedAny) continue;
			const resolved = resolveLook(group.folderName, { createIfMissing: true });
			if (resolved?.id) parsedSite.lookIds.add(resolved.id);
			else parsedSite.linksByLook.delete(lookKey);
		}
	}

	return { errors, sites, createdLooks, lookIdByKey };
}

function applyStructuredBookmarkParse(sites, styleRules, parsed, options = {}) {
	const createdLooks = parsed.createdLooks || [];
	let nextStyleRules = normalizeStyleRules([
		...(styleRules || []),
		...createdLooks.map(look => ({
			id: look.id,
			name: look.name,
			kind: "custom",
			predefined: "",
			css: "",
			shortcutIcon: "",
			shortcutColor: look.shortcutColor || DEFAULT_SHORTCUT_COLOR
		}))
	]);

	let next = cloneSitesForStructuredImport(sites);
	const treeHosts = new Set(parsed.sites.keys());
	const skipped = [];
	let linksAdded = 0;
	let linksReassigned = 0;
	let linksTitleUpdated = 0;
	let sitesCreated = 0;
	let sitesTouched = 0;

	function skipLink(reason, details) {
		skipped.push({ reason, ...details });
	}

	for (const parsedSite of parsed.sites.values()) {
		let siteConfig = null;
		let importedHere = 0;

		for (const group of parsedSite.linksByLook.values()) {
			const lookKey = lookNameKey(group.folderName);
			const styleId = parsed.lookIdByKey?.get(lookKey) || "";

			for (const node of group.nodes) {
				const rawUrl = typeof node.url === "string" ? node.url : "";
				if (!isValidHttpUrl(rawUrl)) {
					skipLink("not-http", {
						url: rawUrl || bookmarkNodeTitle(node) || "(untitled)",
						site: parsedSite.host
					});
					continue;
				}
				let linkHost = "";
				try {
					linkHost = normalizeSite(new URL(rawUrl).hostname);
				} catch {
					linkHost = "";
				}
				if (linkHost !== parsedSite.host) {
					skipLink("host-mismatch", {
						url: rawUrl,
						site: parsedSite.host,
						actualHost: linkHost || "(unknown)"
					});
					continue;
				}
				const saved = normalizeSavedLink({
					url: rawUrl,
					title: node.title,
					style: styleId
				});
				if (!saved) {
					skipLink("not-http", { url: rawUrl, site: parsedSite.host });
					continue;
				}
				if (!styleId) continue;

				if (!siteConfig) {
					const existed = next.some(entry => entry.site === parsedSite.host);
					const ensured = ensureSiteConfig(next, parsedSite.host);
					next = ensured.sites;
					siteConfig = ensured.siteConfig;
					if (!siteConfig) break;
					if (!existed) sitesCreated += 1;
					if (!Array.isArray(siteConfig.links)) siteConfig.links = [];
				}

				siteConfig.linkFolders = addLinkFolderId(siteConfig.linkFolders, styleId);
				const pageKey = hrefMatchKey(saved.url);
				const existingIndex = siteConfig.links.findIndex(link =>
					link?.url && hrefMatchKey(link.url) === pageKey
				);
				if (existingIndex >= 0) {
					const existing = siteConfig.links[existingIndex];
					const nextTitle = saved.title || existing.title;
					const lookChanged = existing.style !== saved.style;
					const titleChanged = nextTitle !== (existing.title || "");
					if (lookChanged || titleChanged) {
						siteConfig.links[existingIndex] = {
							url: saved.url,
							title: nextTitle,
							style: saved.style
						};
						if (lookChanged) linksReassigned += 1;
						else linksTitleUpdated += 1;
					}
				} else {
					siteConfig.links.push(saved);
					linksAdded += 1;
				}
				importedHere += 1;
			}
		}

		if (importedHere > 0) {
			sitesTouched += 1;
			if (siteConfig) {
				siteConfig.linksRevision = (siteConfig.linksRevision || 0) + 1;
			}
		}
	}

	let sitesRemoved = 0;
	let looksRemoved = 0;
	let linksRemoved = 0;

	if (options.removeMissingSites) {
		const kept = [];
		for (const siteConfig of next) {
			if (treeHosts.has(siteConfig.site)) {
				kept.push(siteConfig);
			} else {
				sitesRemoved += 1;
			}
		}
		next = kept;
	}

	if (options.removeMissingLooks) {
		for (const siteConfig of next) {
			if (!treeHosts.has(siteConfig.site)) continue;
			const parsedSite = parsed.sites.get(siteConfig.site);
			const presentIds = new Set(parsedSite?.lookIds || []);
			const removedIds = new Set(
				(siteConfig.linkFolders || []).filter(id => !presentIds.has(id))
			);
			if (removedIds.size === 0) continue;
			siteConfig.linkFolders = (siteConfig.linkFolders || []).filter(id => presentIds.has(id));
			const beforeLinks = (siteConfig.links || []).length;
			siteConfig.links = (siteConfig.links || []).filter(link => !removedIds.has(link.style));
			looksRemoved += removedIds.size;
			linksRemoved += beforeLinks - siteConfig.links.length;
			siteConfig.linksRevision = (siteConfig.linksRevision || 0) + 1;
		}
	}

	if (options.removeMissingLinks) {
		for (const siteConfig of next) {
			if (!treeHosts.has(siteConfig.site)) continue;
			const parsedSite = parsed.sites.get(siteConfig.site);
			const treeKeys = new Set();
			for (const group of parsedSite?.linksByLook?.values() || []) {
				const lookKey = lookNameKey(group.folderName);
				const styleId = parsed.lookIdByKey?.get(lookKey) || "";
				for (const node of group.nodes) {
					if (!isValidHttpUrl(node.url)) continue;
					let linkHost = "";
					try {
						linkHost = normalizeSite(new URL(node.url).hostname);
					} catch {
						continue;
					}
					if (linkHost !== siteConfig.site) continue;
					const saved = normalizeSavedLink({
						url: node.url,
						title: node.title,
						style: styleId || "blocked"
					});
					if (!saved) continue;
					treeKeys.add(hrefMatchKey(saved.url));
				}
			}
			const beforeLinks = (siteConfig.links || []).length;
			siteConfig.links = (siteConfig.links || []).filter(link =>
				link?.url && treeKeys.has(hrefMatchKey(link.url))
			);
			const removedHere = beforeLinks - siteConfig.links.length;
			if (removedHere > 0) {
				linksRemoved += removedHere;
				siteConfig.linksRevision = (siteConfig.linksRevision || 0) + 1;
			}
		}
	}

	return {
		ok: true,
		sites: next,
		styleRules: nextStyleRules,
		createdLooks: createdLooks.map(look => look.name),
		linksAdded,
		linksReassigned,
		linksTitleUpdated,
		sitesCreated,
		sitesTouched,
		sitesRemoved,
		looksRemoved,
		linksRemoved,
		skipped
	};
}

function importStructuredBookmarkFolderIntoSites(sites, styleRules, folderId, options = {}) {
	const id = typeof folderId === "string" || typeof folderId === "number"
		? String(folderId)
		: "";
	if (!id) {
		return Promise.resolve({
			ok: false,
			errors: [structuredImportError("Choose a bookmark folder to import.")]
		});
	}
	if (!browser.bookmarks) {
		return Promise.reject(new Error("Bookmark folders are not available"));
	}

	return loadBookmarkSubtree(id).then(tree => {
		const parsed = parseStructuredBookmarkTree(tree, styleRules);
		if (parsed.errors.length > 0) {
			return { ok: false, errors: parsed.errors };
		}
		return applyStructuredBookmarkParse(sites, styleRules, parsed, options);
	});
}

function buildStructuredBookmarkExportPlan(sites, styleRules) {
	const rules = normalizeStyleRules(styleRules);
	const collisions = findLookNameCollisions(rules);
	if (collisions.length > 0) {
		return {
			ok: false,
			errors: collisions.map(collision => structuredImportError(
				formatLookNameCollisionMessage(collision)
			)),
			siteFolders: [],
			siteCount: 0,
			lookCount: 0,
			linkCount: 0
		};
	}

	const list = (Array.isArray(sites) ? sites : [])
		.filter(siteHasBookmarkExportLinks)
		.sort((a, b) => (a.site || "").localeCompare(b.site || ""));
	const siteFolders = [];
	let lookCount = 0;
	let linkCount = 0;

	for (const siteConfig of list) {
		const looks = [];
		for (const [styleId, links] of bookmarkExportLookGroups(siteConfig)) {
			looks.push({
				title: lookNameForBookmarkExport(styleId, rules),
				links
			});
			lookCount += 1;
			linkCount += links.length;
		}
		if (looks.length === 0) continue;
		siteFolders.push({
			title: siteConfig.site,
			looks
		});
	}

	return {
		ok: true,
		errors: [],
		siteFolders,
		siteCount: siteFolders.length,
		lookCount,
		linkCount
	};
}

function indexStructuredExportPlan(plan) {
	const sites = new Map();
	for (const site of plan?.siteFolders || []) {
		const host = normalizeSite(site.title);
		if (!host) continue;
		const looks = new Map();
		for (const look of site.looks || []) {
			const lookKey = lookNameKey(look.title);
			if (!lookKey) continue;
			const links = new Map();
			for (const link of look.links || []) {
				const hrefKey = hrefMatchKey(link.url);
				if (!hrefKey) continue;
				links.set(hrefKey, link);
			}
			looks.set(lookKey, { title: look.title, links });
		}
		sites.set(host, { title: site.title, looks });
	}
	return sites;
}

function desiredExportLinksByHref(desired) {
	const map = new Map();
	for (const [host, site] of desired) {
		for (const [lookKey, look] of site.looks) {
			for (const [hrefKey, link] of look.links) {
				map.set(hrefKey, {
					host,
					lookKey,
					lookTitle: look.title,
					link
				});
			}
		}
	}
	return map;
}

function structuredExportLookMapKey(host, lookKey) {
	return `${host}\u0000${lookKey}`;
}

function bookmarkFolderTitle(node) {
	return bookmarkNodeTitle(node) || String(node?.title || "").trim();
}

function promiseEach(items, fn) {
	return (items || []).reduce(
		(chain, item, index) => chain.then(() => fn(item, index)),
		Promise.resolve()
	);
}

function removeBookmarkNode(node) {
	if (!node?.id || !browser.bookmarks) {
		return Promise.resolve();
	}
	const isLink = isBookmarkLinkNode(node) || isBookmarkSeparatorNode(node);
	if (isLink && typeof browser.bookmarks.remove === "function") {
		return browser.bookmarks.remove(node.id);
	}
	if (typeof browser.bookmarks.removeTree === "function") {
		return browser.bookmarks.removeTree(node.id);
	}
	if (typeof browser.bookmarks.remove === "function") {
		return browser.bookmarks.remove(node.id);
	}
	return Promise.reject(new Error("Cannot remove bookmark items"));
}

function createBookmarkFolder(parentId, title) {
	return browser.bookmarks.create({ parentId, title }).then(node => {
		if (node && !Array.isArray(node.children)) node.children = [];
		return node;
	});
}

function maybeUpdateBookmarkTitle(node, title, stats) {
	const nextTitle = title || "";
	if (!node?.id || (node.title || "") === nextTitle) {
		return Promise.resolve(node);
	}
	if (!browser.bookmarks || typeof browser.bookmarks.update !== "function") {
		return Promise.resolve(node);
	}
	return browser.bookmarks.update(node.id, { title: nextTitle }).then(updated => {
		stats.updated += 1;
		node.title = nextTitle;
		return updated || node;
	});
}

function maybeMoveBookmarkNode(node, parentId, stats) {
	if (!node?.id || !parentId || node.parentId === parentId) {
		return Promise.resolve(node);
	}
	if (!browser.bookmarks || typeof browser.bookmarks.move !== "function") {
		return Promise.reject(new Error("Cannot move bookmark items"));
	}
	return browser.bookmarks.move(node.id, { parentId }).then(moved => {
		stats.moved += 1;
		node.parentId = parentId;
		return moved || node;
	});
}

function siteFoldersForExportHost(root, host) {
	return (root?.children || []).filter(child =>
		isBookmarkFolderNode(child) &&
		isPlausibleHostname(bookmarkFolderTitle(child)) &&
		normalizeSite(child.title) === host
	);
}

function lookFoldersForExportKey(siteFolders, lookKey) {
	const found = [];
	for (const siteNode of siteFolders || []) {
		for (const child of siteNode.children || []) {
			if (!isBookmarkFolderNode(child)) continue;
			const title = bookmarkFolderTitle(child);
			if (!title || lookNameKey(title) !== lookKey) continue;
			found.push(child);
		}
	}
	return found;
}

function collectBookmarkLinkNodes(root) {
	const links = [];
	function walk(node) {
		for (const child of node?.children || []) {
			if (isBookmarkLinkNode(child)) links.push(child);
			if (isBookmarkFolderNode(child)) walk(child);
		}
	}
	walk(root);
	return links;
}

function claimExistingExportLinks(root, desiredLinks, lookNodes) {
	const claimed = new Map();
	const usedIds = new Set();
	const links = collectBookmarkLinkNodes(root);

	function tryClaim(node, requireCorrectLook) {
		if (!node?.id || usedIds.has(node.id) || !isValidHttpUrl(node.url)) return;
		const hrefKey = hrefMatchKey(node.url);
		const want = desiredLinks.get(hrefKey);
		if (!want || claimed.has(hrefKey)) return;
		let linkHost = "";
		try {
			linkHost = normalizeSite(new URL(node.url).hostname);
		} catch {
			return;
		}
		if (linkHost !== want.host) return;
		if (requireCorrectLook) {
			const lookNode = lookNodes.get(structuredExportLookMapKey(want.host, want.lookKey));
			if (!lookNode || node.parentId !== lookNode.id) return;
		}
		claimed.set(hrefKey, node);
		usedIds.add(node.id);
	}

	for (const node of links) tryClaim(node, true);
	for (const node of links) tryClaim(node, false);
	return { claimed, usedIds };
}

function collectExportPruneNodes(root, keepIds) {
	const prune = [];
	function walk(node) {
		for (const child of node?.children || []) {
			if (keepIds.has(child.id)) {
				walk(child);
				continue;
			}
			prune.push(child);
		}
	}
	walk(root);
	return prune;
}

function ensureStructuredExportFolders(root, desired, stats) {
	const siteNodes = new Map();
	const lookNodes = new Map();

	return promiseEach([...desired.keys()], host => {
		const wantedSite = desired.get(host);
		const existingSites = siteFoldersForExportHost(root, host);
		const existingLooksByHost = existingSites.slice();
		const getSite = existingSites.length > 0
			? Promise.resolve(existingSites[0])
			: createBookmarkFolder(root.id, wantedSite.title).then(node => {
				stats.created += 1;
				if (!Array.isArray(root.children)) root.children = [];
				root.children.push(node);
				node.parentId = root.id;
				return node;
			});

		return getSite.then(siteNode => {
			siteNodes.set(host, siteNode);
			return maybeUpdateBookmarkTitle(siteNode, wantedSite.title, stats).then(() =>
				promiseEach([...wantedSite.looks.keys()], lookKey => {
					const wantedLook = wantedSite.looks.get(lookKey);
					const existingLooks = lookFoldersForExportKey(existingLooksByHost, lookKey);
					const getLook = existingLooks.length > 0
						? maybeMoveBookmarkNode(existingLooks[0], siteNode.id, stats)
						: createBookmarkFolder(siteNode.id, wantedLook.title).then(node => {
							stats.created += 1;
							if (!Array.isArray(siteNode.children)) siteNode.children = [];
							siteNode.children.push(node);
							node.parentId = siteNode.id;
							return node;
						});
					return getLook.then(lookNode => {
						lookNodes.set(structuredExportLookMapKey(host, lookKey), lookNode);
						return maybeUpdateBookmarkTitle(lookNode, wantedLook.title, stats);
					});
				})
			);
		});
	}).then(() => ({ siteNodes, lookNodes }));
}

function syncStructuredExportLinks(root, desired, lookNodes, stats) {
	const desiredLinks = desiredExportLinksByHref(desired);
	const { claimed } = claimExistingExportLinks(root, desiredLinks, lookNodes);

	return promiseEach([...desiredLinks.entries()], ([hrefKey, want]) => {
		const lookNode = lookNodes.get(structuredExportLookMapKey(want.host, want.lookKey));
		if (!lookNode?.id) return Promise.resolve();
		const title = want.link.title || want.link.url;
		const node = claimed.get(hrefKey);
		if (!node) {
			return browser.bookmarks.create({
				parentId: lookNode.id,
				title,
				url: want.link.url
			}).then(created => {
				stats.created += 1;
				if (created) {
					if (!Array.isArray(lookNode.children)) lookNode.children = [];
					lookNode.children.push(created);
				}
			});
		}
		return maybeMoveBookmarkNode(node, lookNode.id, stats)
			.then(() => maybeUpdateBookmarkTitle(node, title, stats));
	}).then(() => claimed);
}

function syncStructuredBookmarksToFolder(folderId, plan) {
	const id = String(folderId || "");
	if (!id) {
		return Promise.reject(new Error("Choose a bookmark folder to export to."));
	}
	if (!browser.bookmarks) {
		return Promise.reject(new Error("Bookmark folders are not available"));
	}

	const desired = indexStructuredExportPlan(plan);
	const stats = { created: 0, updated: 0, moved: 0, deleted: 0 };

	return loadBookmarkSubtree(id).then(nodes => {
		const root = asBookmarkNodeArray(nodes)[0];
		if (!root || isBookmarkLinkNode(root) || isBookmarkSeparatorNode(root)) {
			throw new Error("That bookmark folder is no longer available");
		}
		return ensureStructuredExportFolders(root, desired, stats)
			.then(({ siteNodes, lookNodes }) =>
				syncStructuredExportLinks(root, desired, lookNodes, stats)
					.then(claimed => {
						const keepIds = new Set([root.id]);
						for (const node of siteNodes.values()) {
							if (node?.id) keepIds.add(node.id);
						}
						for (const node of lookNodes.values()) {
							if (node?.id) keepIds.add(node.id);
						}
						for (const node of claimed.values()) {
							if (node?.id) keepIds.add(node.id);
						}
						const prune = collectExportPruneNodes(root, keepIds);
						return promiseEach(prune, node =>
							removeBookmarkNode(node).then(() => {
								stats.deleted += 1;
							})
						);
					})
			)
			.then(() => stats);
	});
}

function migrateTextRulesFromStorage(result) {
	const storedRules = result?.textRules || result?.[LEGACY_STORAGE_KEYS.textRules];
	if (Array.isArray(storedRules)) {
		return normalizeTextRules(storedRules);
	}

	if (!Array.isArray(result?.[LEGACY_STORAGE_KEYS.textFilters])) return [];

	const migrated = [];
	for (const filter of result[LEGACY_STORAGE_KEYS.textFilters]) {
		if (!filter || typeof filter.filterText !== "string") continue;
		const site = typeof filter.site === "string" ? filter.site : "";
		const texts = filter.filterText.split(',').map(text => text.trim()).filter(Boolean);
		for (const text of texts) {
			migrated.push({
				site,
				text,
				style: "blocked"
			});
		}
	}
	return normalizeTextRules(migrated);
}

function getLinkStyleForHref(sites, href) {
	if (!href || !isValidHttpUrl(href)) return "";
	let hostname = "";
	try {
		hostname = new URL(href).hostname;
	} catch {
		return "";
	}
	const siteConfig = findMatchingSiteConfig(sites, hostname);
	if (!siteConfig) return "";
	const pageKey = hrefMatchKey(href);
	if (!pageKey) return "";
	for (const link of siteConfig.links || []) {
		if (!link?.url) continue;
		if (hrefMatchKey(link.url) === pageKey) {
			return typeof link.style === "string" ? link.style : "";
		}
	}
	return "";
}
