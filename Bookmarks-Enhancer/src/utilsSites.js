/**
 * Site storage helpers shared by background, options, and (on demand) the class picker.
 * Load after utils.js. Bookmark import/export and legacy migration live in utilsSitesExtra.js.
 */


function listPresentLegacyStorageKeys(result) {
	return Object.values(LEGACY_STORAGE_KEYS).filter(
		key => result && Object.prototype.hasOwnProperty.call(result, key)
	);
}


function settingsMetaStorageKeys() {
	return [
		STORAGE_KEYS.sites,
		STORAGE_KEYS.styleRules,
		STORAGE_KEYS.siteLinks,
		...Object.values(LEGACY_STORAGE_KEYS)
	];
}


function settingsStorageNeedsFullRead(result) {
	if (!result || typeof result !== "object") return true;
	if (!Array.isArray(result.sites)) return true;
	if (listPresentLegacyStorageKeys(result).length > 0) return true;
	const blob = result[STORAGE_KEYS.siteLinks];
	if (blob && typeof blob === "object" && !Array.isArray(blob)) return true;
	return sitesHaveEmbeddedLinks(result.sites);
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


const SITE_LINKS_DELTA_COMPACT_OPS = 20;

const SITE_LINKS_DELTA_COMPACT_MS = 2000;


function emptySiteLinksDelta() {
	return { seq: 0, ops: [] };
}


function normalizeSiteLinksDeltaOp(op) {
	if (!op || typeof op !== "object") return null;
	const type = op.op === "remove" ? "remove" : op.op === "upsert" ? "upsert" : "";
	if (!type) return null;
	const url = typeof op.url === "string" ? op.url.trim() : "";
	if (!url || !isValidHttpUrl(url)) return null;
	if (type === "remove") return { op: "remove", url };
	const saved = normalizeSavedLink({
		url,
		title: op.title,
		style: op.style
	});
	if (!saved) return null;
	return {
		op: "upsert",
		url: saved.url,
		title: saved.title,
		style: saved.style
	};
}


function normalizeSiteLinksDelta(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return emptySiteLinksDelta();
	}
	const seq = Number.isInteger(value.seq) && value.seq >= 0 ? value.seq : 0;
	const ops = [];
	for (const op of Array.isArray(value.ops) ? value.ops : []) {
		const normalized = normalizeSiteLinksDeltaOp(op);
		if (normalized) ops.push(normalized);
	}
	return { seq, ops };
}


function applySiteLinksDeltaOps(links, ops) {
	const next = Array.isArray(links) ? links.slice() : [];
	for (const op of ops || []) {
		const normalized = normalizeSiteLinksDeltaOp(op);
		if (!normalized) continue;
		const pageKey = hrefMatchKey(normalized.url);
		if (!pageKey) continue;
		const existingIndex = next.findIndex(link =>
			link?.url && hrefMatchKey(link.url) === pageKey
		);
		if (normalized.op === "remove") {
			if (existingIndex >= 0) next.splice(existingIndex, 1);
			continue;
		}
		const saved = {
			url: normalized.url,
			title: normalized.title,
			style: normalized.style
		};
		if (existingIndex >= 0) {
			if (!saved.title) saved.title = next[existingIndex].title;
			next[existingIndex] = saved;
		} else {
			next.push(saved);
		}
	}
	return next;
}


function compactStylePairsFromLinks(links) {
	const pairs = [];
	const seen = new Set();
	for (const link of links || []) {
		if (!link?.url) continue;
		const style = typeof link.style === "string" ? link.style.trim() : "";
		if (!style) continue;
		const key = hrefMatchKey(link.url);
		if (!key || seen.has(key)) continue;
		seen.add(key);
		pairs.push([link.url, style]);
	}
	return pairs;
}


function normalizeStyleIndexPairs(value) {
	if (!Array.isArray(value)) return null;
	const pairs = [];
	const seen = new Set();
	for (const item of value) {
		let url = "";
		let style = "";
		if (Array.isArray(item) && item.length >= 2) {
			url = typeof item[0] === "string" ? item[0].trim() : "";
			style = typeof item[1] === "string" ? item[1].trim() : "";
		} else if (item && typeof item === "object") {
			url = typeof item.url === "string" ? item.url.trim()
				: (typeof item.u === "string" ? item.u.trim() : "");
			style = typeof item.style === "string" ? item.style.trim()
				: (typeof item.s === "string" ? item.s.trim() : "");
		}
		if (!url || !style || !isValidHttpUrl(url)) continue;
		const key = hrefMatchKey(url);
		if (!key || seen.has(key)) continue;
		seen.add(key);
		pairs.push([url, style]);
	}
	return pairs;
}


function applyStylePairsDeltaOps(pairs, ops) {
	const next = Array.isArray(pairs) ? pairs.slice() : [];
	for (const op of ops || []) {
		const normalized = normalizeSiteLinksDeltaOp(op);
		if (!normalized) continue;
		const pageKey = hrefMatchKey(normalized.url);
		if (!pageKey) continue;
		const existingIndex = next.findIndex(pair =>
			pair?.[0] && hrefMatchKey(pair[0]) === pageKey
		);
		if (normalized.op === "remove") {
			if (existingIndex >= 0) next.splice(existingIndex, 1);
			continue;
		}
		const style = typeof normalized.style === "string" ? normalized.style.trim() : "";
		if (!style) continue;
		const pair = [normalized.url, style];
		if (existingIndex >= 0) next[existingIndex] = pair;
		else next.push(pair);
	}
	return next;
}


function styleLookupMapFromPairs(pairs) {
	const map = new Map();
	for (const pair of pairs || []) {
		const url = pair?.[0];
		const style = pair?.[1];
		if (!url || !style) continue;
		const key = hrefMatchKey(url);
		if (!key || map.has(key)) continue;
		map.set(key, style);
	}
	return map;
}


function appendSiteLinksDeltaOp(delta, op) {
	const current = normalizeSiteLinksDelta(delta);
	const normalized = normalizeSiteLinksDeltaOp(op);
	if (!normalized) return current;
	const pageKey = hrefMatchKey(normalized.url);
	const ops = pageKey
		? current.ops.filter(existing => hrefMatchKey(existing.url) !== pageKey)
		: current.ops.slice();
	ops.push(normalized);
	return {
		seq: current.seq + 1,
		ops
	};
}


function siteLinksDeltasByHostFromStorageResult(result) {
	const byHost = {};
	if (!result || typeof result !== "object") return byHost;
	for (const [key, value] of Object.entries(result)) {
		const host = hostFromSiteLinksDeltaStorageKey(key);
		if (!host) continue;
		byHost[host] = normalizeSiteLinksDelta(value);
	}
	return byHost;
}


function siteLinkHostsFromStorageResult(result) {
	const hosts = new Set();
	if (!result || typeof result !== "object") return hosts;
	for (const key of Object.keys(result)) {
		const host = hostFromSiteLinksStorageKey(key) ||
			hostFromSiteLinksDeltaStorageKey(key) ||
			hostFromSiteStylesStorageKey(key);
		if (host) hosts.add(host);
	}
	const blob = result[STORAGE_KEYS.siteLinks];
	if (blob && typeof blob === "object" && !Array.isArray(blob)) {
		for (const host of Object.keys(blob)) {
			if (host) hosts.add(host);
		}
	}
	return hosts;
}


function siteLinksByHostFromStorageResult(result) {
	if (!result || typeof result !== "object") return null;
	const byHost = {};
	let found = false;

	for (const [key, value] of Object.entries(result)) {
		const host = hostFromSiteLinksStorageKey(key);
		if (!host) continue;
		found = true;
		byHost[host] = Array.isArray(value) ? value : [];
	}

	const blob = result[STORAGE_KEYS.siteLinks];
	if (blob && typeof blob === "object" && !Array.isArray(blob)) {
		found = true;
		for (const [host, links] of Object.entries(blob)) {
			if (!host || Object.prototype.hasOwnProperty.call(byHost, host)) continue;
			byHost[host] = Array.isArray(links) ? links : [];
		}
	}

	const deltas = siteLinksDeltasByHostFromStorageResult(result);
	for (const [host, delta] of Object.entries(deltas)) {
		if (!host) continue;
		found = true;
		byHost[host] = applySiteLinksDeltaOps(byHost[host], delta.ops);
	}

	return found ? byHost : null;
}


function storageResultFromSitesAndLinks(sitesMeta, linksByHost) {
	const result = { sites: sitesMeta };
	for (const [host, links] of Object.entries(linksByHost || {})) {
		if (!host) continue;
		const key = siteLinksStorageKey(host);
		if (key) result[key] = Array.isArray(links) ? links : [];
	}
	return result;
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


function buildSitesStoragePlan(sites, { previousHosts = [] } = {}) {
	const writes = {
		[STORAGE_KEYS.sites]: (sites || []).map(siteConfigToStorageMeta).filter(Boolean)
	};
	const keepHosts = new Set();
	const removeKeys = [STORAGE_KEYS.siteLinks];
	for (const siteConfig of sites || []) {
		const host = siteConfig?.site;
		if (!host) continue;
		keepHosts.add(host);
		writes[siteLinksStorageKey(host)] = Array.isArray(siteConfig.links)
			? siteConfig.links
			: [];
		const stylesKey = siteStylesStorageKey(host);
		if (stylesKey) {
			writes[stylesKey] = compactStylePairsFromLinks(siteConfig.links);
		}
		const deltaKey = siteLinksDeltaStorageKey(host);
		if (deltaKey) removeKeys.push(deltaKey);
	}

	for (const host of previousHosts || []) {
		if (!host || keepHosts.has(host)) continue;
		removeKeys.push(siteLinksStorageKey(host));
		removeKeys.push(siteLinksDeltaStorageKey(host));
		removeKeys.push(siteStylesStorageKey(host));
	}

	return { writes, removeKeys };
}


function buildSitesStorageWrites(sites, { previousHosts = [] } = {}) {
	return buildSitesStoragePlan(sites, { previousHosts }).writes;
}


function buildHostLinksStorageWrite(host, links) {
	const key = siteLinksStorageKey(host);
	if (!key) return {};
	return { [key]: Array.isArray(links) ? links : [] };
}


function buildHostStylesStorageWrite(host, links) {
	const key = siteStylesStorageKey(host);
	if (!key) return {};
	return { [key]: compactStylePairsFromLinks(links) };
}


function buildHostLinkIndexStorageWrite(host, links) {
	return {
		...buildHostLinksStorageWrite(host, links),
		...buildHostStylesStorageWrite(host, links)
	};
}


function siteLinkStorageKeysForSites(sites) {
	return (sites || [])
		.map(siteConfig => siteConfig?.site && siteLinksStorageKey(siteConfig.site))
		.filter(Boolean);
}


function siteLinkDeltaStorageKeysForSites(sites) {
	return (sites || [])
		.map(siteConfig => siteConfig?.site && siteLinksDeltaStorageKey(siteConfig.site))
		.filter(Boolean);
}


function persistSitesStoragePlan(plan) {
	const writes = plan?.writes || {};
	const removeKeys = Array.from(new Set(plan?.removeKeys || [])).filter(Boolean);
	const setPromise = Object.keys(writes).length > 0
		? browser.storage.local.set(writes)
		: Promise.resolve();
	if (removeKeys.length === 0) return setPromise;
	return setPromise.then(() => browser.storage.local.remove(removeKeys));
}


function loadSitesFromStorageResult(result, options = {}) {
	const merged = mergeSiteLinksIntoSites(
		result?.sites,
		siteLinksByHostFromStorageResult(result)
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
