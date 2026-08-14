const STORAGE_KEYS = {
	sites: "sites",
	// Per-host saved links, kept out of `sites` so content scripts never
	// deserialize tens of thousands of URLs on settings changes.
	siteLinks: "siteLinksByHost",
	styleRules: "styleRules",
	enableTopBorder: "enableTopBorder",
	enableDeepSearch: "enableDeepSearch",
	enableToastNotifications: "enableToastNotifications",
	// Options UI only — not part of config export/import or page refresh.
	hideGettingStarted: "hideGettingStarted"
};

// Session-only: focus the options page on a hash route such as #sites/example.com.
const OPTIONS_HASH_SESSION_KEY = "beOptionsHash";

// One-shot migration only — removed after first successful migrate/purge.
const LEGACY_STORAGE_KEYS = {
	searchPairs: "searchPairs",
	urlRules: "urlRules",
	textRules: "textRules",
	bookmarkRules: "bookmarkRules",
	textFilters: "textFilters",
	enableSeenStyling: "enableSeenStyling",
	blockedFolderId: "blockedFolderId",
	favoritedFolderId: "favoritedFolderId",
	onlyUseSites: "onlyUseSites"
};

const CONFIG_REFRESH_STORAGE_KEYS = [
	STORAGE_KEYS.sites,
	STORAGE_KEYS.styleRules,
	STORAGE_KEYS.enableTopBorder,
	STORAGE_KEYS.enableDeepSearch,
	STORAGE_KEYS.enableToastNotifications
];

const SHORTCUT_ICON_IDS = ["star", "x", "eye", "bookmark", "heart"];
const SHORTCUT_ICON_LABELS = {
	star: "Star",
	x: "X",
	eye: "Eye",
	bookmark: "Bookmark",
	heart: "Heart"
};
const DEFAULT_SHORTCUT_COLOR = "#64748b";
const DEFAULT_LOOK_SHORTCUTS = {
	blocked: { shortcutIcon: "x", shortcutColor: "#dc2626" },
	favorited: { shortcutIcon: "star", shortcutColor: "#eab308" },
	seen: { shortcutIcon: "eye", shortcutColor: "#64748b" }
};

const DEFAULT_STYLE_RULES = [
	{
		id: "blocked",
		name: "Blocked",
		kind: "predefined",
		predefined: "blocked",
		css: "",
		shortcutIcon: "x",
		shortcutColor: "#dc2626"
	},
	{
		id: "favorited",
		name: "Favorited",
		kind: "predefined",
		predefined: "favorited",
		css: "",
		shortcutIcon: "star",
		shortcutColor: "#eab308"
	},
	{
		id: "seen",
		name: "Seen",
		kind: "predefined",
		predefined: "seen",
		css: "",
		shortcutIcon: "eye",
		shortcutColor: "#64748b"
	}
];

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

function isValidHttpUrl(href) {
	try {
		const url = new URL(href);
		return url.protocol === "http:" || url.protocol === "https:";
	} catch {
		return false;
	}
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

function findMatchingSiteConfig(sites, hostname) {
	let best = null;
	for (const siteConfig of sites || []) {
		if (!hostnameMatchesSite(hostname, siteConfig.site)) continue;
		if (!best || siteConfig.site.length > best.site.length) {
			best = siteConfig;
		}
	}
	return best;
}

function sitesToSearchPairs(sites) {
	return (sites || [])
		.filter(siteConfig => (siteConfig.classGroups || []).length > 0)
		.map(siteConfig => ({
			site: siteConfig.site,
			classes: siteConfig.classGroups.join(", ")
		}));
}

function sitesToUrlRules(sites) {
	return (sites || [])
		.filter(siteConfig => siteConfig.keepParams)
		.map(siteConfig => ({
			site: siteConfig.site,
			keepParams: siteConfig.keepParams
		}));
}

function sitesToTextRules(sites) {
	return (sites || []).flatMap(siteConfig =>
		(siteConfig.textRules || []).map(rule => ({
			site: siteConfig.site,
			text: rule.text,
			style: rule.style
		}))
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

function importBookmarkFolderIntoSites(sites, folderId, styleId) {
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

	return loadBookmarkSubtree(folderId).then(tree => {
		const linksBySite = new Map();
		collectBookmarkUrlsFromTree(tree, style, linksBySite);
		return mergeBookmarkLinksBySiteIntoSites(sites, linksBySite);
	});
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

function isValidTextRule(rule) {
	return !!rule &&
		typeof rule.site === "string" &&
		rule.site.trim() !== "" &&
		typeof rule.text === "string" &&
		rule.text.trim() !== "" &&
		(
			rule.style === undefined ||
			(typeof rule.style === "string" && rule.style.trim() !== "")
		);
}

function normalizeTextRules(rules) {
	if (!Array.isArray(rules)) return [];

	const seen = new Set();
	const normalized = [];
	for (const rule of rules) {
		if (!isValidTextRule(rule)) continue;
		const text = rule.text.trim();
		const site = normalizeSite(rule.site.trim()) || rule.site.trim();
		if (!site) continue;
		const style = typeof rule.style === "string" && rule.style.trim()
			? rule.style.trim()
			: "blocked";
		const key = [site.toLowerCase(), text.toLowerCase(), style].join("\u0000");
		if (seen.has(key)) continue;
		seen.add(key);
		normalized.push({ site, text, style });
	}
	return normalized;
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

const PREDEFINED_STYLE_CSS = {
	blocked: "display: none !important;",
	favorited: "text-decoration-line: underline !important; text-decoration-style: double !important;",
	seen: "text-decoration-line: underline !important; text-decoration-style: dashed !important;"
};

const PREDEFINED_STYLE_BORDERS = {
	blocked: "dashed red",
	favorited: "double white",
	seen: "dashed white"
};

// Toggled on <html> to temporarily show items styled with display:none.
const REVEAL_HIDDEN_CLASS = "be-reveal-hidden";

// Old class names to strip from pages after upgrades.
const STALE_MANAGED_CLASS_NAMES = [
	"be-bookmarks-enhancer-blocked",
	"be-bookmarks-enhancer-favorited",
	"be-bookmarks-enhancer-seen",
	"be-bookmarks-enhancer-text-filtered",
	"be-bookmarks-enhancer-text-blocked",
	"be-bookmarks-enhancer-text-favorited",
	"be-bookmarks-enhancer-text-seen"
];

function styleRuleClassName(ruleOrName) {
	const raw = ruleOrName && typeof ruleOrName === "object"
		? (ruleOrName.name || ruleOrName.id || "")
		: String(ruleOrName || "");
	let sanitized = raw
		.trim()
		.replace(/[^a-zA-Z0-9_-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	if (!sanitized) sanitized = "style";
	if (/^[0-9]/.test(sanitized)) sanitized = `n-${sanitized}`;
	return `rule-be-${sanitized}`;
}

function findStyleRuleClassNameCollisions(styleRules) {
	const byClassName = new Map();
	for (const rule of styleRules || []) {
		if (!rule || !rule.name) continue;
		const className = styleRuleClassName(rule);
		if (!byClassName.has(className)) {
			byClassName.set(className, []);
		}
		byClassName.get(className).push(rule);
	}

	const collisions = [];
	for (const [className, rules] of byClassName) {
		if (rules.length < 2) continue;
		collisions.push({
			className,
			names: rules.map(rule => rule.name)
		});
	}
	return collisions;
}

function sanitizeCustomCss(css) {
	if (typeof css !== "string") return "";
	return css.replace(/<\/style/gi, "");
}

function getStyleRuleDeclarations(rule) {
	if (!rule) return "";
	if (rule.kind === "custom") {
		return sanitizeCustomCss(rule.css);
	}
	return PREDEFINED_STYLE_CSS[rule.predefined] || "";
}

function styleRuleHidesElements(rule) {
	return /display\s*:\s*none\b/i.test(getStyleRuleDeclarations(rule) || "");
}

function getStyleRuleBorder(rule) {
	if (!rule || rule.kind === "custom") return "solid #9ca3af";
	return PREDEFINED_STYLE_BORDERS[rule.predefined] || "solid #9ca3af";
}

function buildStyleRulesCss(styleRules) {
	if (!Array.isArray(styleRules)) return "";

	return styleRules.map(rule => {
		const declarations = getStyleRuleDeclarations(rule).trim();
		if (!declarations) return "";
		const className = styleRuleClassName(rule);
		const selector = styleRuleHidesElements(rule)
			? `html:not(.${REVEAL_HIDDEN_CLASS}) .${className}`
			: `.${className}`;
		return `${selector} {\n\t\t\t${declarations}\n\t\t}`;
	}).filter(Boolean).join("\n\n\t\t");
}

function createStyleRuleId() {
	if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
		return crypto.randomUUID();
	}
	return `style_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeShortcutIcon(value) {
	if (typeof value !== "string") return "";
	const icon = value.trim().toLowerCase();
	return SHORTCUT_ICON_IDS.includes(icon) ? icon : "";
}

function normalizeShortcutColor(value) {
	if (typeof value !== "string") return "";
	const trimmed = value.trim();
	if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) return trimmed.toLowerCase();
	if (/^#[0-9a-fA-F]{3}$/.test(trimmed)) {
		return `#${trimmed[1]}${trimmed[1]}${trimmed[2]}${trimmed[2]}${trimmed[3]}${trimmed[3]}`.toLowerCase();
	}
	return "";
}

function escapeSvgAttr(value) {
	return String(value)
		.replace(/&/g, "&amp;")
		.replace(/"/g, "&quot;")
		.replace(/</g, "&lt;");
}

function shortcutIconSvgMarkup(iconId, { active = false, color = DEFAULT_SHORTCUT_COLOR } = {}) {
	const safeColor = escapeSvgAttr(normalizeShortcutColor(color) || DEFAULT_SHORTCUT_COLOR);
	const badge = active
		? `<circle cx="12" cy="12" r="10" fill="${safeColor}" stroke="none"/>`
		: `<circle cx="12" cy="12" r="10" fill="none" stroke="${safeColor}" stroke-width="1.5"/>`;
	const glyphStroke = active ? "#ffffff" : safeColor;
	const glyphFill = active ? safeColor : "none";
	const shape = `fill="${glyphFill}" stroke="${glyphStroke}" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"`;
	let glyph = "";

	switch (iconId) {
		case "star":
			glyph = `<path ${shape} d="M12 3.1l2.4 4.86 5.36.78-3.88 3.78.92 5.35L12 15.24 7.2 17.87l.92-5.35-3.88-3.78 5.36-.78L12 3.1z"/>`;
			break;
		case "x":
			glyph = `<path fill="none" stroke="${glyphStroke}" stroke-width="1.85" stroke-linecap="round" d="M8 8l8 8M16 8l-8 8"/>`;
			break;
		case "eye":
			glyph = `<path ${shape} d="M2.6 12s3.5-6.4 9.4-6.4S21.4 12 21.4 12s-3.5 6.4-9.4 6.4S2.6 12 2.6 12z"/>` +
				`<circle cx="12" cy="12" r="2.35" fill="${active ? "#ffffff" : "none"}" stroke="${glyphStroke}" stroke-width="1.85"/>`;
			break;
		case "bookmark":
			glyph = `<path ${shape} d="M7 4.4h10a1 1 0 0 1 1 1v14.4l-6-3.15-6 3.15V5.4a1 1 0 0 1 1-1z"/>`;
			break;
		case "heart":
			glyph = `<path ${shape} d="M12 19.15S5.45 14.8 3.3 11.2C1.75 8.6 2.95 5.55 5.7 4.75c1.55-.45 3.35.25 4.95 1.85 1.6-1.6 3.4-2.3 4.95-1.85 2.75.8 3.95 3.85 2.4 6.45C18.55 14.8 12 19.15 12 19.15z"/>`;
			break;
		default:
			return "";
	}

	return `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">${badge}<g transform="translate(12 12) scale(0.7) translate(-12 -12)">${glyph}</g></svg>`;
}

function resolveStyleRuleShortcut(rule) {
	const id = typeof rule?.id === "string" ? rule.id.trim() : "";
	const defaults = DEFAULT_LOOK_SHORTCUTS[id];
	const icon = rule?.shortcutIcon === undefined && defaults
		? defaults.shortcutIcon
		: normalizeShortcutIcon(rule?.shortcutIcon);
	let color = rule?.shortcutColor === undefined && defaults
		? defaults.shortcutColor
		: normalizeShortcutColor(rule?.shortcutColor);
	if (!color) color = defaults?.shortcutColor || DEFAULT_SHORTCUT_COLOR;
	return { shortcutIcon: icon, shortcutColor: color };
}

function isValidStyleRule(rule) {
	if (!rule || typeof rule !== "object") return false;
	if (typeof rule.id !== "string" || !rule.id.trim()) return false;
	if (typeof rule.name !== "string" || !rule.name.trim()) return false;
	if (rule.kind === "custom") {
		return rule.css === undefined || typeof rule.css === "string";
	}
	if (rule.kind === "predefined") {
		return rule.predefined === "blocked" ||
			rule.predefined === "favorited" ||
			rule.predefined === "seen";
	}
	return false;
}

function normalizeStyleRules(rules) {
	if (!Array.isArray(rules)) return [];

	const seenIds = new Set();
	const usedIcons = new Set();
	const normalized = [];
	for (const rule of rules) {
		if (!isValidStyleRule(rule)) continue;
		const id = rule.id.trim();
		if (seenIds.has(id)) continue;
		seenIds.add(id);

		const shortcut = resolveStyleRuleShortcut(rule);
		let shortcutIcon = shortcut.shortcutIcon;
		if (shortcutIcon && usedIcons.has(shortcutIcon)) shortcutIcon = "";
		if (shortcutIcon) usedIcons.add(shortcutIcon);

		const base = {
			id,
			name: rule.name.trim(),
			shortcutIcon,
			shortcutColor: shortcut.shortcutColor
		};

		if (rule.kind === "custom") {
			normalized.push({
				...base,
				kind: "custom",
				predefined: "",
				css: typeof rule.css === "string" ? rule.css : ""
			});
		} else {
			normalized.push({
				...base,
				kind: "predefined",
				predefined: rule.predefined,
				css: ""
			});
		}
	}

	return normalized;
}

function migrateStyleRulesFromStorage(result) {
	if (Array.isArray(result?.styleRules)) {
		return normalizeStyleRules(result.styleRules);
	}
	return DEFAULT_STYLE_RULES.map(rule => ({ ...rule }));
}

/**
 * Sole site normalizer for the extension.
 * Strips scheme/path noise, lowercases, drops a leading "*." / trailing ".",
 * and removes a leading "www.".
 * All site storage and matching must go through this (via hostnameMatchesSite
 * when comparing a hostname to a configured site).
 */
function normalizeSite(site) {
	if (typeof site !== "string") return "";

	const trimmedSite = site.trim().toLowerCase().replace(/^\*\./, "");
	if (!trimmedSite) return "";

	try {
		const url = new URL(
			trimmedSite.includes("://") ? trimmedSite : `http://${trimmedSite}`
		);
		return url.hostname.replace(/\.$/, "").replace(/^www\./, "");
	} catch {
		return trimmedSite.replace(/\.$/, "").replace(/^www\./, "");
	}
}

/** @deprecated Alias of normalizeSite for older call sites. */
function normalizeSiteForMatching(site) {
	return normalizeSite(site);
}

/**
 * Returns true when normalizeSite(site) looks like a usable hostname or IPv4.
 * Used by options UI validation; matching still goes through hostnameMatchesSite.
 */
function isPlausibleHostname(site) {
	const normalized = normalizeSite(site);
	if (!normalized || normalized.length > 253) return false;

	if (/^\d{1,3}(\.\d{1,3}){3}$/.test(normalized)) {
		return normalized.split(".").every(part => {
			const n = Number(part);
			return n >= 0 && n <= 255;
		});
	}

	return normalized.split(".").every(label =>
		label.length > 0 &&
		label.length <= 63 &&
		/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label)
	);
}

function hostnameMatchesSite(hostname, site) {
	const normalizedHostname = normalizeSite(hostname);
	const normalizedSite = normalizeSite(site);

	if (!normalizedHostname || !normalizedSite) return false;

	return normalizedHostname === normalizedSite ||
		normalizedHostname.endsWith(`.${normalizedSite}`);
}

function getPageRunStateForUrl(url, sites) {
	const idle = { siteMatch: false, runStyling: false, runShortcuts: false };
	if (typeof url !== "string" || !/^https?:/i.test(url)) return idle;

	let hostname = "";
	try {
		hostname = new URL(url).hostname;
	} catch {
		return idle;
	}

	const siteMatch = !!findMatchingSiteConfig(sites, hostname);
	return {
		siteMatch,
		runShortcuts: siteMatch,
		runStyling: siteMatch
	};
}

/**
 * Normalize URL for search/comparison
 * Applies URL rules to keep only specified parameters
 * Caches results with a shared LRU policy.
 *
 * Depends on: urlRules (array), urlNormalizationCache (Map from createUrlNormalizationCache)
 * These should be defined in the calling context
 */
const URL_NORMALIZATION_CACHE_LIMIT = 2000;

function createUrlNormalizationCache() {
	return new Map();
}

function readUrlNormalizationCache(href) {
	if (!urlNormalizationCache || !urlNormalizationCache.has(href)) return undefined;
	const value = urlNormalizationCache.get(href);
	// Refresh LRU insertion order.
	urlNormalizationCache.delete(href);
	urlNormalizationCache.set(href, value);
	return value;
}

function writeUrlNormalizationCache(href, normalized) {
	if (!urlNormalizationCache) return;
	if (urlNormalizationCache.has(href)) {
		urlNormalizationCache.delete(href);
	}
	urlNormalizationCache.set(href, normalized);
	while (urlNormalizationCache.size > URL_NORMALIZATION_CACHE_LIMIT) {
		urlNormalizationCache.delete(urlNormalizationCache.keys().next().value);
	}
}

function getActiveUrlRules(explicitRules) {
	if (Array.isArray(explicitRules)) return explicitRules;
	try {
		if (typeof urlRules !== "undefined" && Array.isArray(urlRules)) {
			return urlRules;
		}
	} catch {
		// options page and other contexts may not declare urlRules
	}
	return [];
}

function normalizeHrefForSearch(href, explicitRules) {
	try {
		const cached = readUrlNormalizationCache(href);
		if (cached !== undefined && explicitRules === undefined) {
			return cached;
		}

		const url = new URL(href, typeof window !== 'undefined' ? window.location.origin : undefined);
		if (url.protocol !== "http:" && url.protocol !== "https:") return href;

		const rule = getActiveUrlRules(explicitRules).find(entry =>
			hostnameMatchesSite(url.hostname, entry.site)
		);

		if (rule) {
			const keptParams = new URLSearchParams();

			const params = rule.keepParams
				.split(',')
				.map(p => p.trim())
				.filter(Boolean);

			for (const param of params) {
				const value = url.searchParams.get(param);

				if (value !== null) {
					keptParams.set(param, value);
				}
			}

			url.search = keptParams.toString()
				? `?${keptParams.toString()}`
				: "";
		}
		else {
			url.search = "";
		}
		url.hash = "";

		let normalized = url.href;
		if (url.pathname !== "/" && normalized.endsWith("/")) {
			normalized = normalized.slice(0, -1);
		}

		if (explicitRules === undefined) {
			writeUrlNormalizationCache(href, normalized);
		}
		return normalized;
	} catch {
		if (explicitRules === undefined) {
			writeUrlNormalizationCache(href, href);
		}
		return href;
	}
}

function hrefMatchKey(href, explicitRules) {
	const normalized = normalizeHrefForSearch(href, explicitRules);
	try {
		const url = new URL(normalized);
		const host = normalizeSite(url.hostname);
		if (!host) return normalized;
		let path = url.pathname || "/";
		if (path !== "/" && path.endsWith("/")) path = path.slice(0, -1);
		return `${host}${path}${url.search}`;
	} catch {
		return normalized;
	}
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
