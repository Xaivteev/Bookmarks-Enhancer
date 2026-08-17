/**
 * Content-script-safe helpers shared with background and options.
 * Site storage, bookmark import/export, and legacy migration live in utilsSites.js.
 */

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
	hideGettingStarted: "hideGettingStarted",
	linkedBookmarkFolderId: "linkedBookmarkFolderId"
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


function isValidHttpUrl(href) {
	try {
		const url = new URL(href);
		return url.protocol === "http:" || url.protocol === "https:";
	} catch {
		return false;
	}
}

function hostnameMatchesNormalized(normalizedHostname, normalizedSite) {
	return !!normalizedHostname && !!normalizedSite && (
		normalizedHostname === normalizedSite ||
		normalizedHostname.endsWith(`.${normalizedSite}`)
	);
}

function findMatchingSiteConfig(sites, hostname) {
	const host = normalizeSite(hostname);
	if (!host) return null;
	let best = null;
	for (const siteConfig of sites || []) {
		const site = siteConfig?.site;
		if (!hostnameMatchesNormalized(host, site)) continue;
		if (!best || site.length > best.site.length) {
			best = siteConfig;
		}
	}
	return best;
}

function buildSiteHostIndex(sites) {
	const index = new Map();
	for (const siteConfig of sites || []) {
		const host = siteConfig?.site;
		if (!host || index.has(host)) continue;
		index.set(host, siteConfig);
	}
	return index;
}

function findSiteConfigByNormalizedHost(index, normalizedHost) {
	if (!index || !normalizedHost) return null;
	let candidate = normalizedHost;
	while (candidate) {
		const match = index.get(candidate);
		if (match) return match;
		const dot = candidate.indexOf(".");
		if (dot < 0) break;
		candidate = candidate.slice(dot + 1);
	}
	return null;
}

function findSiteConfigInHostIndex(index, hostname) {
	return findSiteConfigByNormalizedHost(index, normalizeSite(hostname));
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
	return hostnameMatchesNormalized(normalizeSite(hostname), normalizeSite(site));
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
	let cache = null;
	try {
		if (typeof urlNormalizationCache !== "undefined") cache = urlNormalizationCache;
	} catch {
		cache = null;
	}
	if (!cache || !cache.has(href)) return undefined;
	const value = cache.get(href);
	// Refresh LRU insertion order.
	cache.delete(href);
	cache.set(href, value);
	return value;
}

function writeUrlNormalizationCache(href, normalized) {
	let cache = null;
	try {
		if (typeof urlNormalizationCache !== "undefined") cache = urlNormalizationCache;
	} catch {
		cache = null;
	}
	if (!cache) return;
	if (cache.has(href)) {
		cache.delete(href);
	}
	cache.set(href, normalized);
	while (cache.size > URL_NORMALIZATION_CACHE_LIMIT) {
		cache.delete(cache.keys().next().value);
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

		const hostname = normalizeSite(url.hostname);
		const rule = getActiveUrlRules(explicitRules).find(entry =>
			hostnameMatchesNormalized(hostname, entry.site)
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

function hrefMatchKeyFromNormalized(normalized) {
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

function hrefMatchKey(href, explicitRules) {
	return hrefMatchKeyFromNormalized(normalizeHrefForSearch(href, explicitRules));
}
