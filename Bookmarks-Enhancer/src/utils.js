const STORAGE_KEYS = {
	sites: "sites",
	styleRules: "styleRules",
	enableTopBorder: "enableTopBorder",
	enableDeepSearch: "enableDeepSearch",
	onlyUseSites: "onlyUseSites",
	enableToastNotifications: "enableToastNotifications",
	// Options UI only — not part of config export/import or page refresh.
	hideGettingStarted: "hideGettingStarted"
};

// One-shot migration only — removed after first successful migrate/purge.
const LEGACY_STORAGE_KEYS = {
	searchPairs: "searchPairs",
	urlRules: "urlRules",
	textRules: "textRules",
	bookmarkRules: "bookmarkRules",
	textFilters: "textFilters",
	enableSeenStyling: "enableSeenStyling",
	blockedFolderId: "blockedFolderId",
	favoritedFolderId: "favoritedFolderId"
};

const CONFIG_REFRESH_STORAGE_KEYS = [
	STORAGE_KEYS.sites,
	STORAGE_KEYS.styleRules,
	STORAGE_KEYS.enableTopBorder,
	STORAGE_KEYS.enableDeepSearch,
	STORAGE_KEYS.onlyUseSites
];

const DEFAULT_STYLE_RULES = [
	{ id: "blocked", name: "Blocked", kind: "predefined", predefined: "blocked", css: "" },
	{ id: "favorited", name: "Favorited", kind: "predefined", predefined: "favorited", css: "" },
	{ id: "seen", name: "Seen", kind: "predefined", predefined: "seen", css: "" }
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
	const sites = migrateSitesFromStorage(result);
	const defaultStyles = () => DEFAULT_STYLE_RULES.map(rule => ({ ...rule }));

	const persistConfig = merged => {
		const writes = {};
		if (needsSites) writes[STORAGE_KEYS.sites] = merged;
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

function normalizeSavedLink(link, fallbackStyle = "blocked") {
	if (!link || typeof link.url !== "string") return null;
	const url = link.url.trim();
	if (!url || !isValidHttpUrl(url)) return null;
	return {
		url,
		title: typeof link.title === "string" ? link.title : "",
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

function normalizeSiteConfig(siteConfig) {
	if (!siteConfig || typeof siteConfig !== "object") return null;
	const site = normalizeSite(siteConfig.site);
	if (!site) return null;

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

	const linkSeen = new Set();
	const links = [];
	for (const link of siteConfig.links || []) {
		const normalized = normalizeSavedLink(link);
		if (!normalized) continue;
		if (linkSeen.has(normalized.url)) continue;
		linkSeen.add(normalized.url);
		links.push(normalized);
	}

	return {
		site,
		classGroups: normalizeClassGroupList(siteConfig.classGroups),
		keepParams: normalizeKeepParams(siteConfig.keepParams),
		textRules,
		links,
		linkFolders: normalizeLinkFolderIds(siteConfig.linkFolders, links)
	};
}

function normalizeSites(sites) {
	if (!Array.isArray(sites)) return [];

	const bySite = new Map();
	for (const raw of sites) {
		const siteConfig = normalizeSiteConfig(raw);
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
	const next = normalizeSites(sites);
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

	const normalizedUrl = normalizeHrefForSearch(url, sitesToUrlRules(next));
	const existingIndex = siteConfig.links.findIndex(link =>
		link.url === normalizedUrl || link.url === url
	);
	const saved = {
		url: normalizedUrl,
		title: typeof title === "string" ? title : "",
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
		return normalizeSites(result.sites);
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
	let next = normalizeSites(sites);
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
		sites: normalizeSites(next),
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
	if (!browser.bookmarks || typeof browser.bookmarks.getSubTree !== "function") {
		return Promise.reject(new Error("Bookmark folders are not available"));
	}

	return browser.bookmarks.getSubTree(folderId).then(tree => {
		const linksBySite = new Map();
		collectBookmarkUrlsFromTree(tree, style, linksBySite);
		return mergeBookmarkLinksBySiteIntoSites(sites, linksBySite);
	});
}

function collectBookmarkUrlsFromTree(nodes, style, linksBySite) {
	for (const node of nodes || []) {
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
					title: typeof node.title === "string" ? node.title : "",
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
	if (!browser.bookmarks || typeof browser.bookmarks.getSubTree !== "function") {
		return Promise.resolve(normalizeSites(sites));
	}

	return Promise.all(folderRules.map(rule =>
		browser.bookmarks.getSubTree(rule.folderId)
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
	const normalized = [];
	for (const rule of rules) {
		if (!isValidStyleRule(rule)) continue;
		const id = rule.id.trim();
		if (seenIds.has(id)) continue;
		seenIds.add(id);

		if (rule.kind === "custom") {
			normalized.push({
				id,
				name: rule.name.trim(),
				kind: "custom",
				predefined: "",
				css: typeof rule.css === "string" ? rule.css : ""
			});
		} else {
			normalized.push({
				id,
				name: rule.name.trim(),
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
