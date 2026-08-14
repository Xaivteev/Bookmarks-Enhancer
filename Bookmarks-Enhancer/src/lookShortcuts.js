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
	all: initial;
	display: block;
	position: fixed;
	top: 12px;
	right: 12px;
	z-index: 2147483000;
	font-family: system-ui, sans-serif;
	pointer-events: auto;
}

@media print {
	:host { display: none !important; }
}

.bar {
	display: flex;
	align-items: center;
	gap: 2px;
	padding: 4px 6px;
	background: rgba(255, 255, 255, 0.58);
	border: 1px solid rgba(255, 255, 255, 0.72);
	border-radius: 999px;
	box-shadow: 0 4px 18px rgba(15, 23, 42, 0.18);
	backdrop-filter: blur(10px);
}

button {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	width: 30px;
	height: 30px;
	margin: 0;
	padding: 0;
	border: 0;
	border-radius: 999px;
	background: transparent;
	cursor: pointer;
	color: inherit;
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
	width: 20px;
	height: 20px;
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

function removeOverlay() {
	document.getElementById(LOOK_SHORTCUTS_HOST_ID)?.remove();
	lastOverlayKey = "";
}

function stopOverlayEvent(event) {
	event.stopPropagation();
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
		return;
	}

	if (!host) {
		host = document.createElement("div");
		host.id = LOOK_SHORTCUTS_HOST_ID;
		host.setAttribute("data-bookmarks-enhancer", "look-shortcuts");
		const shadow = host.attachShadow({ mode: "open" });
		const style = document.createElement("style");
		style.textContent = LOOK_SHORTCUTS_STYLE;
		const bar = document.createElement("div");
		bar.className = "bar";
		bar.setAttribute("role", "toolbar");
		bar.setAttribute("aria-label", "Look shortcuts");
		shadow.append(style, bar);
		host.addEventListener("pointerdown", stopOverlayEvent, true);
		host.addEventListener("mousedown", stopOverlayEvent, true);
		host.addEventListener("click", stopOverlayEvent, true);
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
		button.addEventListener("click", event => {
			event.preventDefault();
			event.stopPropagation();
			toggleLookShortcut(rule.id);
		});
		bar.appendChild(button);
	}

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

loadLookShortcutSettings();
}
