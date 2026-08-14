function isTopWindow() {
	try {
		return window.top === window;
	} catch {
		return false;
	}
}

if (isTopWindow() && !globalThis.__beLookShortcutsInstalled) {
globalThis.__beLookShortcutsInstalled = true;

const LOOK_SHORTCUTS_HOST_ID = "be-look-shortcuts-host";
const LOOK_SHORTCUTS_STYLE = `
:host {
	display: block !important;
	position: fixed !important;
	inset: auto !important;
	top: 12px !important;
	right: 12px !important;
	left: auto !important;
	bottom: auto !important;
	z-index: 2147483000 !important;
	margin: 0 !important;
	transform: none !important;
	filter: none !important;
	font-family: system-ui, sans-serif;
	pointer-events: auto;
}

@media print {
	:host { display: none !important; }
}

.bar {
	display: flex;
	align-items: center;
	gap: 1px;
	padding: 1px 3px;
	background: rgba(255, 255, 255, 0.58);
	border: 1px solid rgba(255, 255, 255, 0.72);
	border-radius: 999px;
	box-shadow: 0 2px 10px rgba(15, 23, 42, 0.16);
	backdrop-filter: blur(10px);
	pointer-events: auto;
	user-select: none;
	touch-action: manipulation;
}

button {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	width: 20px;
	height: 20px;
	margin: 0;
	padding: 0;
	border: 0;
	border-radius: 999px;
	background: transparent;
	cursor: pointer;
	color: inherit;
	pointer-events: auto;
}

button:hover {
	background: rgba(15, 23, 42, 0.08);
}

button:focus-visible {
	outline: 2px solid #2563eb;
	outline-offset: 1px;
}

button[aria-pressed="true"] {
	background: rgba(15, 23, 42, 0.1);
}

button:disabled {
	opacity: 0.55;
	cursor: wait;
}

svg {
	display: block;
	width: 16px;
	height: 16px;
}
`;

let shortcutSites = [];
let shortcutStyleRules = [];
let pendingShortcutToggles = new Set();
let lastOverlayKey = "";

function isHttpPage() {
	return location.protocol === "http:" || location.protocol === "https:";
}

function currentSiteConfig() {
	if (!isHttpPage()) return null;
	return findMatchingSiteConfig(shortcutSites, location.hostname);
}

function currentPageStyleId(siteConfig) {
	if (!siteConfig) return "";
	const normalized = normalizeHrefForSearch(
		location.href,
		sitesToUrlRules(shortcutSites)
	);
	const match = (siteConfig.links || []).find(link =>
		link.url === normalized || link.url === location.href
	);
	return match?.style || "";
}

function shortcutLooks() {
	return (shortcutStyleRules || []).filter(rule => rule.shortcutIcon);
}

function overlayStateKey(siteConfig) {
	if (!siteConfig) return "";
	const looks = shortcutLooks().map(rule =>
		`${rule.id}:${rule.shortcutIcon}:${rule.shortcutColor}`
	).join(",");
	return `${siteConfig.site}|${currentPageStyleId(siteConfig)}|${looks}|${location.href}`;
}

function isFirefoxBrowser() {
	return typeof CSS !== "undefined" && CSS.supports("(-moz-appearance: none)");
}

function applyLookShortcutHostStyles(host) {
	if (!host) return;
	const hostStyles = [
		["display", "block"],
		["position", "fixed"],
		["z-index", "2147483000"],
		["inset", "auto"],
		["top", "12px"],
		["right", "12px"],
		["left", "auto"],
		["bottom", "auto"],
		["width", "auto"],
		["height", "auto"],
		["margin", "0"],
		["padding", "0"],
		["border", "none"],
		["background", "transparent"],
		["overflow", "visible"],
		["visibility", "visible"],
		["opacity", "1"],
		["pointer-events", "auto"],
		["transform", "none"],
		["filter", "none"],
		["clip", "auto"],
		["clip-path", "none"],
		["contain", "none"]
	];
	for (const [property, value] of hostStyles) {
		host.style.setProperty(property, value, "important");
	}
}

function pinLookShortcutHost(host) {
	if (!host) return;
	if (!host.isConnected) {
		document.documentElement.appendChild(host);
	}
	applyLookShortcutHostStyles(host);

	// Top layer escapes page transforms/filters that make position:fixed
	// scroll with the document in Chrome. Firefox is reliable with fixed on <html>.
	if (isFirefoxBrowser() || typeof host.showPopover !== "function") return;

	try {
		if (host.getAttribute("popover") !== "manual") {
			host.setAttribute("popover", "manual");
		}
		if (!host.matches(":popover-open")) {
			host.showPopover();
		}
		applyLookShortcutHostStyles(host);
	} catch {
		try {
			host.hidePopover?.();
		} catch {
			// Host may already be disconnected or not a popover.
		}
		host.removeAttribute("popover");
		applyLookShortcutHostStyles(host);
	}
}

function removeOverlay() {
	const host = document.getElementById(LOOK_SHORTCUTS_HOST_ID);
	if (host) {
		try {
			host.hidePopover?.();
		} catch {
			// Ignore if the host was not a popover.
		}
		host.remove();
	}
	lastOverlayKey = "";
}

const LOOK_SHORTCUT_BLOCKED_EVENTS = [
	"pointerdown",
	"pointerup",
	"pointercancel",
	"mousedown",
	"mouseup",
	"click",
	"auxclick",
	"dblclick",
	"contextmenu",
	"touchstart",
	"touchend",
	"touchmove"
];

function lookShortcutHostFromEvent(event) {
	const host = document.getElementById(LOOK_SHORTCUTS_HOST_ID);
	if (!host) return null;
	const path = typeof event.composedPath === "function" ? event.composedPath() : [];
	return path.includes(host) ? host : null;
}

function lookShortcutButtonFromEvent(event) {
	const path = typeof event.composedPath === "function" ? event.composedPath() : [];
	return path.find(node =>
		node && node.tagName === "BUTTON" && node.dataset && node.dataset.styleId
	) || null;
}

function swallowLookShortcutEvent(event) {
	if (!lookShortcutHostFromEvent(event)) return;

	event.stopPropagation();
	event.stopImmediatePropagation();
	// Canceling pointerdown/touchstart can suppress the later click we use to toggle.
	if (
		event.cancelable &&
		event.type !== "pointerdown" &&
		event.type !== "touchstart"
	) {
		event.preventDefault();
	}

	if (event.type === "click") {
		const button = lookShortcutButtonFromEvent(event);
		if (button && !button.disabled) {
			toggleLookShortcut(button.dataset.styleId);
		}
	}
}

function attachLookShortcutEventGuards() {
	const capture = { capture: true, passive: false };
	for (const type of LOOK_SHORTCUT_BLOCKED_EVENTS) {
		window.addEventListener(type, swallowLookShortcutEvent, capture);
	}
}

function renderLookShortcuts() {
	const siteConfig = currentSiteConfig();
	const looks = shortcutLooks();
	if (!siteConfig || looks.length === 0) {
		removeOverlay();
		return;
	}

	const key = overlayStateKey(siteConfig);
	let host = document.getElementById(LOOK_SHORTCUTS_HOST_ID);
	if (host && key === lastOverlayKey && pendingShortcutToggles.size === 0) {
		pinLookShortcutHost(host);
		return;
	}

	if (!host) {
		host = document.createElement("div");
		host.id = LOOK_SHORTCUTS_HOST_ID;
		host.setAttribute("data-bookmarks-enhancer", "look-shortcuts");
		applyLookShortcutHostStyles(host);
		const shadow = host.attachShadow({ mode: "open" });
		const style = document.createElement("style");
		style.textContent = LOOK_SHORTCUTS_STYLE;
		const bar = document.createElement("div");
		bar.className = "bar";
		bar.setAttribute("role", "toolbar");
		bar.setAttribute("aria-label", "Look shortcuts");
		shadow.append(style, bar);
		document.documentElement.appendChild(host);
	}

	const bar = host.shadowRoot.querySelector(".bar");
	const activeStyleId = currentPageStyleId(siteConfig);
	bar.replaceChildren();

	for (const rule of looks) {
		const active = rule.id === activeStyleId;
		const button = document.createElement("button");
		button.type = "button";
		button.dataset.styleId = rule.id;
		button.setAttribute("aria-pressed", active ? "true" : "false");
		button.setAttribute(
			"aria-label",
			active ? `Remove page from ${rule.name}` : `Add page to ${rule.name}`
		);
		button.title = rule.name;
		button.disabled = pendingShortcutToggles.has(rule.id);
		button.innerHTML = shortcutIconSvgMarkup(rule.shortcutIcon, {
			active,
			color: rule.shortcutColor
		});
		bar.appendChild(button);
	}

	pinLookShortcutHost(host);
	lastOverlayKey = key;
}

function toggleLookShortcut(styleId) {
	if (!styleId || pendingShortcutToggles.has(styleId)) return;
	pendingShortcutToggles.add(styleId);
	renderLookShortcuts();

	browser.runtime.sendMessage({
		toggleLookShortcut: true,
		styleId,
		url: location.href,
		title: document.title || location.href
	}).catch(() => {}).finally(() => {
		pendingShortcutToggles.delete(styleId);
		renderLookShortcuts();
	});
}

function loadLookShortcutSettings() {
	return browser.storage.local.get([
		STORAGE_KEYS.sites,
		STORAGE_KEYS.styleRules
	]).then(result => {
		shortcutSites = migrateSitesFromStorage(result);
		shortcutStyleRules = migrateStyleRulesFromStorage(result);
		renderLookShortcuts();
	}).catch(() => {});
}

browser.storage.onChanged.addListener((changes, areaName) => {
	if (areaName !== "local") return;
	let changed = false;
	if (changes[STORAGE_KEYS.sites]) {
		shortcutSites = migrateSitesFromStorage({
			sites: changes[STORAGE_KEYS.sites].newValue
		});
		changed = true;
	}
	if (changes[STORAGE_KEYS.styleRules]) {
		shortcutStyleRules = migrateStyleRulesFromStorage({
			styleRules: changes[STORAGE_KEYS.styleRules].newValue
		});
		changed = true;
	}
	if (changed) renderLookShortcuts();
});

browser.runtime.onMessage.addListener(message => {
	if (message && message.refresh) renderLookShortcuts();
});

window.addEventListener("popstate", renderLookShortcuts);
window.addEventListener("hashchange", renderLookShortcuts);

try {
	const originalPushState = history.pushState;
	history.pushState = function patchedPushState(...args) {
		const result = originalPushState.apply(this, args);
		renderLookShortcuts();
		return result;
	};
	const originalReplaceState = history.replaceState;
	history.replaceState = function patchedReplaceState(...args) {
		const result = originalReplaceState.apply(this, args);
		renderLookShortcuts();
		return result;
	};
} catch {
	// Some pages lock history; tabs.onUpdated still refreshes the overlay.
}

attachLookShortcutEventGuards();
loadLookShortcutSettings();
}
