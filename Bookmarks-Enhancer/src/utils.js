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
		if (result.enableSeenStyling === false) return "";
		return "seen";
	}

	if (result?.enableSeenStyling === false) return "";
	if (
		result?.enableSeenStyling === true ||
		typeof result?.blockedFolderId === "string" ||
		typeof result?.favoritedFolderId === "string"
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
	if (Array.isArray(result?.bookmarkRules)) {
		rules = result.bookmarkRules.slice();
	} else {
		rules = [];
		const blockedFolderId = normalizeStoredFolderId(result?.blockedFolderId);
		const favoritedFolderId = normalizeStoredFolderId(result?.favoritedFolderId);
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

const LEGACY_MANAGED_CLASS_NAMES = [
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

function getStyleRuleBorder(rule) {
	if (!rule || rule.kind === "custom") return "solid #9ca3af";
	return PREDEFINED_STYLE_BORDERS[rule.predefined] || "solid #9ca3af";
}

function buildStyleRulesCss(styleRules) {
	if (!Array.isArray(styleRules)) return "";

	return styleRules.map(rule => {
		const declarations = getStyleRuleDeclarations(rule).trim();
		if (!declarations) return "";
		return `.${styleRuleClassName(rule)} {\n\t\t\t${declarations}\n\t\t}`;
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
	if (!Array.isArray(rules) || rules.length === 0) {
		return DEFAULT_STYLE_RULES.map(rule => ({ ...rule }));
	}

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

	return normalized.length > 0
		? normalized
		: DEFAULT_STYLE_RULES.map(rule => ({ ...rule }));
}

function migrateStyleRulesFromStorage(result) {
	if (Array.isArray(result?.styleRules)) {
		return normalizeStyleRules(result.styleRules);
	}
	return DEFAULT_STYLE_RULES.map(rule => ({ ...rule }));
}

function getStyleRulePriorityMap(styleRules) {
	const priorityById = new Map();
	(styleRules || []).forEach((rule, index) => {
		priorityById.set(rule.id, index);
	});
	return priorityById;
}

/**
 * Match a configured site against a hostname without allowing partial
 * hostname matches (for example, "example.com" must not match
 * "notexample.com"). A configured domain also matches its subdomains.
 */
function normalizeSiteForMatching(site) {
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

function hostnameMatchesSite(hostname, site) {
	const normalizedHostname = normalizeSiteForMatching(hostname);
	const normalizedSite = normalizeSiteForMatching(site);

	if (!normalizedHostname || !normalizedSite) return false;

	return normalizedHostname === normalizedSite ||
		normalizedHostname.endsWith(`.${normalizedSite}`);
}

/**
 * Normalize URL for search/comparison
 * Applies URL rules to keep only specified parameters
 * Caches results to avoid repeated calculations
 *
 * Depends on: urlRules (array), urlNormalizationCache (Map)
 * These should be defined in the calling context
 */
const URL_NORMALIZATION_CACHE_LIMIT = 2000;

function readUrlNormalizationCache(href) {
	if (!urlNormalizationCache.has(href)) return undefined;
	const value = urlNormalizationCache.get(href);
	// Refresh LRU insertion order.
	urlNormalizationCache.delete(href);
	urlNormalizationCache.set(href, value);
	return value;
}

function writeUrlNormalizationCache(href, normalized) {
	if (urlNormalizationCache.has(href)) {
		urlNormalizationCache.delete(href);
	}
	urlNormalizationCache.set(href, normalized);
	while (urlNormalizationCache.size > URL_NORMALIZATION_CACHE_LIMIT) {
		urlNormalizationCache.delete(urlNormalizationCache.keys().next().value);
	}
}

function normalizeHrefForSearch(href) {
	try {
		const cached = readUrlNormalizationCache(href);
		if (cached !== undefined) {
			return cached;
		}

		const url = new URL(href, typeof window !== 'undefined' ? window.location.origin : undefined);
		if (url.protocol !== "http:" && url.protocol !== "https:") return href;

		const rule = urlRules.find(rule =>
			hostnameMatchesSite(url.hostname, rule.site)
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

		writeUrlNormalizationCache(href, normalized);
		return normalized;
	} catch {
		writeUrlNormalizationCache(href, href);
		return href;
	}
}
