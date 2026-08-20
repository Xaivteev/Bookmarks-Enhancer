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
	gap: 0;
	padding: 0 1px;
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
	width: 22px;
	height: 22px;
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

button[aria-pressed="true"]:hover {
	background: transparent;
	filter: brightness(0.92);
}

button:disabled {
	opacity: 0.55;
	cursor: wait;
}

svg {
	display: block;
	width: 22px;
	height: 22px;
}
`;

let shortcutSites = [];
let shortcutStyleRules = [];
let cachedPageStyleId = "";
let cachedPageUrl = "";
let lastOverlayKey = "";
let styleStateRequestSeq = 0;

function isHttpPage() {
	return location.protocol === "http:" || location.protocol === "https:";
}

function currentSiteConfig() {
	if (!isHttpPage()) return null;
	return findMatchingSiteConfig(shortcutSites, location.hostname);
}

function currentPageStyleId() {
	if (cachedPageUrl !== location.href) return "";
	return cachedPageStyleId;
}

function shortcutLooks() {
	return (shortcutStyleRules || []).filter(rule => rule.shortcutIcon);
}

function overlayStateKey(siteConfig) {
	if (!siteConfig) return "";
	const looks = shortcutLooks().map(rule =>
		`${rule.id}:${rule.shortcutIcon}:${rule.shortcutColor}`
	).join(",");
	return `${siteConfig.site}|${currentPageStyleId()}|${looks}|${location.href}`;
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
	if (globalThis.__beLookShortcutGuardsAttached) return;
	globalThis.__beLookShortcutGuardsAttached = true;
	const capture = { capture: true, passive: false };
	for (const type of LOOK_SHORTCUT_BLOCKED_EVENTS) {
		window.addEventListener(type, swallowLookShortcutEvent, capture);
	}
}

function detachLookShortcutEventGuards() {
	if (!globalThis.__beLookShortcutGuardsAttached) return;
	globalThis.__beLookShortcutGuardsAttached = false;
	const capture = { capture: true, passive: false };
	for (const type of LOOK_SHORTCUT_BLOCKED_EVENTS) {
		window.removeEventListener(type, swallowLookShortcutEvent, capture);
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
	if (host && key === lastOverlayKey) {
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
	const activeStyleId = currentPageStyleId();
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
		button.innerHTML = shortcutIconSvgMarkup(rule.shortcutIcon, {
			active,
			color: rule.shortcutColor
		});
		bar.appendChild(button);
	}

	pinLookShortcutHost(host);
	lastOverlayKey = key;
}

function applyLookShortcutState(state, href = location.href) {
	if (!state || (state.url && state.url !== href)) return;
	cachedPageUrl = href;
	cachedPageStyleId = typeof state.styleId === "string" ? state.styleId : "";
	renderLookShortcuts();
}

function applyLookShortcutStateFromStatusUpdates(statusUpdates) {
	if (!statusUpdates || typeof statusUpdates !== "object") return;
	let pageHref = "";
	try {
		pageHref = normalizeHrefForSearch(location.href);
	} catch {
		return;
	}
	if (!pageHref || !Object.prototype.hasOwnProperty.call(statusUpdates, pageHref)) {
		return;
	}
	const status = statusUpdates[pageHref];
	applyLookShortcutState({
		url: location.href,
		styleId: status && status !== "none" ? String(status) : ""
	});
}

function refreshLookShortcutState() {
	if (!isHttpPage() || !currentSiteConfig()) {
		cachedPageUrl = location.href;
		cachedPageStyleId = "";
		renderLookShortcuts();
		return;
	}

	const href = location.href;
	const requestSeq = ++styleStateRequestSeq;
	browser.runtime.sendMessage({
		getLookShortcutState: true,
		url: href
	}).then(state => {
		if (requestSeq !== styleStateRequestSeq) return;
		applyLookShortcutState(state, href);
	}).catch(() => {
		if (requestSeq !== styleStateRequestSeq) return;
		renderLookShortcuts();
	});
}

function toggleLookShortcut(styleId) {
	if (!styleId) return;
	const href = location.href;
	const previous = currentPageStyleId();
	cachedPageUrl = href;
	cachedPageStyleId = previous === styleId ? "" : styleId;
	renderLookShortcuts();

	browser.runtime.sendMessage({
		toggleLookShortcut: true,
		styleId,
		url: href,
		title: document.title || ""
	}).then(result => {
		if (location.href !== href) return;
		if (!result || result.ok === false) {
			cachedPageStyleId = previous;
			renderLookShortcuts();
			return;
		}
		if (typeof result.styleId === "string") {
			cachedPageStyleId = result.styleId;
			renderLookShortcuts();
		}
	}).catch(() => {
		if (location.href !== href) return;
		cachedPageStyleId = previous;
		renderLookShortcuts();
	});
}

function sitesMetaFromStorage(result) {
	const raw = Array.isArray(result?.[STORAGE_KEYS.sites]) ? result[STORAGE_KEYS.sites] : [];
	return raw.map(siteConfig => ({
		site: siteConfig?.site || "",
		classGroups: siteConfig?.classGroups || [],
		keepParams: siteConfig?.keepParams || "",
		textRules: siteConfig?.textRules || [],
		linkFolders: siteConfig?.linkFolders || []
	})).filter(siteConfig => siteConfig.site);
}

function loadLookShortcutSettings() {
	return browser.storage.local.get([
		STORAGE_KEYS.sites,
		STORAGE_KEYS.styleRules
	]).then(result => {
		shortcutSites = sitesMetaFromStorage(result);
		shortcutStyleRules = migrateStyleRulesFromStorage(result);
		renderLookShortcuts();
		refreshLookShortcutState();
	}).catch(() => {});
}

let lookShortcutsArmed = false;
let lookShortcutNavHooksInstalled = false;

function installLookShortcutNavHooks() {
	if (lookShortcutNavHooksInstalled) return;
	lookShortcutNavHooksInstalled = true;
	window.addEventListener("popstate", refreshLookShortcutState);
	window.addEventListener("hashchange", refreshLookShortcutState);

	try {
		const originalPushState = history.pushState;
		history.pushState = function patchedPushState(...args) {
			const result = originalPushState.apply(this, args);
			if (lookShortcutsArmed) refreshLookShortcutState();
			return result;
		};
		const originalReplaceState = history.replaceState;
		history.replaceState = function patchedReplaceState(...args) {
			const result = originalReplaceState.apply(this, args);
			if (lookShortcutsArmed) refreshLookShortcutState();
			return result;
		};
	} catch {
		// Some pages lock history; tabs.onUpdated still refreshes the overlay.
	}
}

function armLookShortcuts() {
	if (lookShortcutsArmed) {
		loadLookShortcutSettings();
		return;
	}
	lookShortcutsArmed = true;
	attachLookShortcutEventGuards();
	installLookShortcutNavHooks();
	loadLookShortcutSettings();
}

function disarmLookShortcuts() {
	lookShortcutsArmed = false;
	detachLookShortcutEventGuards();
	removeOverlay();
	shortcutSites = [];
	shortcutStyleRules = [];
	cachedPageStyleId = "";
	cachedPageUrl = "";
}

function syncLookShortcutsRunState(state) {
	if (state && state.runShortcuts) armLookShortcuts();
	else disarmLookShortcuts();
}

function requestLookShortcutRunState() {
	return browser.runtime.sendMessage({
		getPageRunState: true,
		url: location.href
	}).catch(() => ({ runShortcuts: false }));
}

browser.runtime.onMessage.addListener(message => {
	if (!message) return;
	if (message.lookShortcutState) {
		if (lookShortcutsArmed) applyLookShortcutState(message.lookShortcutState);
		return;
	}
	if (message.refresh && message.reloadConfig) {
		requestLookShortcutRunState().then(syncLookShortcutsRunState);
		return;
	}
	if (!lookShortcutsArmed) return;
	if (message.refresh) {
		refreshLookShortcutState();
		return;
	}
	if (message.statusUpdates) {
		applyLookShortcutStateFromStatusUpdates(message.statusUpdates);
	}
});

requestLookShortcutRunState().then(syncLookShortcutsRunState);
}
