/* Duplicate-title warnings and their toast. Loaded after contentScript.js.
 * Re-injection is guarded; functions read content-script globals at call time.
 */
if (!globalThis.__beContentDuplicatesInstalled) {
globalThis.__beContentDuplicatesInstalled = true;

let duplicateWarningTimer = null;
let duplicateWarningPassId = 0;
const DUPLICATE_SHOW_GRACE_MS = 1500;
let duplicateShowGraceUntil = 0;
let duplicateShowGraceTimer = null;
let duplicatePassDeferred = false;
let duplicateStyledHrefs = new Set();
let lastDuplicatePageToastKey = "";
let duplicateWarningToastHost = null;
let duplicateWarningToastHideTimer = null;

const DUPLICATE_LISTING_CANDIDATE_LIMIT = 400;
const DUPLICATE_WARNING_TOAST_DURATION_MS = 10000;
const DUPLICATE_WARNING_TOAST_HOST_ID = "bookmarks-enhancer-duplicate-warning";

function hrefHasUrlMatch(href) {
	const status = linkStatusMap.get(href);
	return !!(status && status !== "none");
}

function pageHrefHasUrlMatch() {
	try {
		return hrefHasUrlMatch(normalizeHrefForSearch(window.location.href));
	} catch {
		return false;
	}
}

function cardHasUrlMatchedLink(card) {
	if (!card) return false;
	for (const [href, status] of linkStatusMap) {
		if (!status || status === "none") continue;
		for (const link of linksForHref(href)) {
			if (link === card || card.contains(link)) return true;
		}
	}
	return false;
}

function listingLinkInUrlMatchedCard(link) {
	for (const card of closestConfiguredCards(link)) {
		if (cardHasUrlMatchedLink(card)) return true;
	}
	return false;
}

function clearDuplicateWarningPass() {
	duplicateWarningPassId += 1;
	if (duplicateWarningTimer) {
		clearTimeout(duplicateWarningTimer);
		duplicateWarningTimer = null;
	}
}

function clearDuplicateShowGrace() {
	duplicateShowGraceUntil = 0;
	duplicatePassDeferred = false;
	if (duplicateShowGraceTimer) {
		clearTimeout(duplicateShowGraceTimer);
		duplicateShowGraceTimer = null;
	}
}

function armDuplicateGraceFlush() {
	if (duplicateShowGraceTimer) return;
	const delay = Math.max(0, duplicateShowGraceUntil - Date.now());
	duplicateShowGraceTimer = setTimeout(() => {
		duplicateShowGraceTimer = null;
		duplicateShowGraceUntil = 0;
		if (duplicatePassDeferred) scheduleDuplicateWarningPass();
	}, delay);
}

function noteTabBecameVisible() {
	const hadPendingPass = !!duplicateWarningTimer;
	clearDuplicateWarningPass();
	if (duplicateShowGraceTimer) {
		clearTimeout(duplicateShowGraceTimer);
		duplicateShowGraceTimer = null;
	}
	duplicateShowGraceUntil = Date.now() + DUPLICATE_SHOW_GRACE_MS;
	if (hadPendingPass) duplicatePassDeferred = true;
	if (duplicatePassDeferred) armDuplicateGraceFlush();
}

function scheduleDuplicateWarningPass(options = {}) {
	if (!enableDuplicateWarning) {
		duplicatePassDeferred = false;
		clearDuplicateListingLooks();
		hideDuplicateWarningToast();
		return;
	}
	const force = !!options.force;
	const graceActive = Date.now() < duplicateShowGraceUntil;
	if (!force && (pendingStatusHrefs.size > 0 || graceActive)) {
		duplicatePassDeferred = true;
		if (graceActive) armDuplicateGraceFlush();
		return;
	}
	if (duplicateWarningTimer) return;
	duplicatePassDeferred = false;
	duplicateWarningTimer = setTimeout(() => {
		duplicateWarningTimer = null;
		runDuplicateWarningPass();
	}, 80);
}

function runDuplicateWarningPass() {
	if (!enableDuplicateWarning || !searchSite) {
		clearDuplicateListingLooks();
		hideDuplicateWarningToast();
		return;
	}
	const passId = ++duplicateWarningPassId;
	const urlGeneration = urlCacheGeneration;
	matchDuplicateListingTitles(passId, urlGeneration);
	matchDuplicatePageTitle(passId, urlGeneration);
}

function collectDuplicateListingCandidates() {
	const candidates = [];
	for (const href of linkMap.keys()) {
		if (hrefHasUrlMatch(href)) continue;
		for (const link of linksForHref(href)) {
			if (listingLinkInUrlMatchedCard(link)) continue;
			const title = (link.textContent || "").replace(/\s+/g, " ").trim();
			const normalized = normalizeDuplicateTitle(title);
			if (!normalized || isBoilerplateDuplicateLinkTitle(normalized)) continue;
			candidates.push({ href, title });
			if (candidates.length >= DUPLICATE_LISTING_CANDIDATE_LIMIT) return candidates;
		}
	}
	return candidates;
}

function clearDuplicateLookFromHref(href) {
	if (hrefHasUrlMatch(href)) return;
	for (const link of linksForHref(href)) {
		if (managedClassNames.length) link.classList.remove(...managedClassNames);
		for (const card of closestConfiguredCards(link)) {
			if (cardHasUrlMatchedLink(card)) continue;
			if (managedClassNames.length) card.classList.remove(...managedClassNames);
		}
	}
}

function clearDuplicateListingLooks() {
	for (const href of duplicateStyledHrefs) {
		clearDuplicateLookFromHref(href);
	}
	duplicateStyledHrefs = new Set();
}

function applyDuplicateListingMatches(matchedHrefs) {
	const style = getStyleConfigById(duplicateWarningStyleId);
	const next = new Set(Array.isArray(matchedHrefs) ? matchedHrefs : []);
	for (const href of duplicateStyledHrefs) {
		if (next.has(href)) continue;
		clearDuplicateLookFromHref(href);
	}
	if (!style) {
		duplicateStyledHrefs = new Set();
		return;
	}

	const applied = new Set();
	for (const href of next) {
		if (hrefHasUrlMatch(href)) continue;
		let styledAny = false;
		for (const link of linksForHref(href)) {
			if (listingLinkInUrlMatchedCard(link)) continue;
			const title = (link.textContent || "").replace(/\s+/g, " ").trim();
			const normalized = normalizeDuplicateTitle(title);
			if (!normalized || isBoilerplateDuplicateLinkTitle(normalized)) continue;
			applyStatusClass(link, style.className);
			styledAny = true;
			for (const card of closestConfiguredCards(link)) {
				if (cardHasUrlMatchedLink(card) || hasStatusClass(card)) continue;
				applyStatusClass(card, style.className);
			}
		}
		if (styledAny) applied.add(href);
	}
	duplicateStyledHrefs = applied;
}

function matchDuplicateListingTitles(passId, urlGeneration) {
	const candidates = collectDuplicateListingCandidates();
	if (candidates.length === 0) {
		clearDuplicateListingLooks();
		return;
	}
	browser.runtime.sendMessage({
		matchDuplicateListingTitles: true,
		candidates
	}).then(result => {
		if (passId !== duplicateWarningPassId) return;
		if (urlGeneration !== urlCacheGeneration) return;
		if (!enableDuplicateWarning) return;
		if (!result || result.ok === false) return;
		applyDuplicateListingMatches(result.hrefs);
	}).catch(() => {});
}

function matchDuplicatePageTitle(passId, urlGeneration) {
	if (pageHrefHasUrlMatch()) {
		lastDuplicatePageToastKey = "";
		hideDuplicateWarningToast();
		return;
	}
	const url = location.href;
	const title = document.title || "";
	if (isGenericDuplicatePageTitle(title)) {
		lastDuplicatePageToastKey = "";
		hideDuplicateWarningToast();
		return;
	}
	browser.runtime.sendMessage({
		matchDuplicatePageTitle: true,
		url,
		title
	}).then(result => {
		if (passId !== duplicateWarningPassId) return;
		if (urlGeneration !== urlCacheGeneration) return;
		if (!enableDuplicateWarning) return;
		if (location.href !== url) return;
		if (pageHrefHasUrlMatch()) {
			hideDuplicateWarningToast();
			return;
		}
		const matches = Array.isArray(result?.matches) ? result.matches : [];
		if (matches.length === 0) {
			lastDuplicatePageToastKey = "";
			hideDuplicateWarningToast();
			return;
		}
		const toastKey = `${url}\0${title}\0${matches.map(match => match.url).join("\0")}`;
		if (toastKey === lastDuplicatePageToastKey) return;
		lastDuplicatePageToastKey = toastKey;
		showDuplicateWarningToast(matches);
	}).catch(() => {});
}

function hideDuplicateWarningToast() {
	if (duplicateWarningToastHideTimer) {
		clearTimeout(duplicateWarningToastHideTimer);
		duplicateWarningToastHideTimer = null;
	}
	const host = duplicateWarningToastHost ||
		document.getElementById(DUPLICATE_WARNING_TOAST_HOST_ID);
	if (host) host.remove();
	duplicateWarningToastHost = null;
}

function showDuplicateWarningToast(matches) {
	hideDuplicateWarningToast();
	const items = (matches || []).slice(0, DUPLICATE_WARNING_MAX_MATCHES);
	if (!items.length) return;

	const host = document.createElement("div");
	host.id = DUPLICATE_WARNING_TOAST_HOST_ID;
	host.setAttribute("data-be-duplicate-warning", "host");
	host.setAttribute("role", "status");
	host.setAttribute("aria-live", "polite");
	host.style.cssText = pageToastHostStyle("left");

	const shadow = host.attachShadow({ mode: "open" });
	const style = document.createElement("style");
	style.textContent = buildPageToastCss({
		border: "#92400e",
		background: "#78350f",
		color: "#fffbeb",
		maxWidth: "360px",
		extra: `
		.toast-main { flex: 1; min-width: 0; }
		.heading { margin: 0 0 6px; font-weight: 650; }
		.matches { list-style: none; margin: 0; padding: 0; }
		.match { margin: 0 0 8px; }
		.match:last-child { margin-bottom: 0; }
		.match-title { font-weight: 600; }
		.match-meta, .match-url {
			display: block;
			margin-top: 2px;
			opacity: 0.9;
			word-break: break-all;
		}
		.match-url {
			color: inherit;
			text-decoration: underline;
		}
		`
	});

	const toast = document.createElement("div");
	toast.className = "toast";

	const main = document.createElement("div");
	main.className = "toast-main";

	const heading = document.createElement("p");
	heading.className = "heading";
	heading.textContent = items.length === 1
		? "A similar link is already saved"
		: "Similar links are already saved";

	const list = document.createElement("ul");
	list.className = "matches";
	for (const match of items) {
		const item = document.createElement("li");
		item.className = "match";
		const titleEl = document.createElement("span");
		titleEl.className = "match-title";
		titleEl.textContent = match.title || match.url || "Untitled link";
		item.appendChild(titleEl);
		if (match.look) {
			const meta = document.createElement("span");
			meta.className = "match-meta";
			meta.textContent = match.look;
			item.appendChild(meta);
		}
		if (match.url) {
			const urlEl = document.createElement("a");
			urlEl.className = "match-url";
			urlEl.href = match.url;
			urlEl.target = "_blank";
			urlEl.rel = "noopener noreferrer";
			urlEl.textContent = match.url;
			item.appendChild(urlEl);
		}
		list.appendChild(item);
	}

	main.append(heading, list);

	const dismissBtn = document.createElement("button");
	dismissBtn.type = "button";
	dismissBtn.className = "dismiss";
	dismissBtn.setAttribute("aria-label", "Dismiss potential duplicate warning");
	dismissBtn.title = "Dismiss";
	dismissBtn.textContent = "×";
	dismissBtn.addEventListener("click", event => {
		event.preventDefault();
		event.stopPropagation();
		hideDuplicateWarningToast();
	});

	toast.append(main, dismissBtn);
	shadow.append(style, toast);

	const root = document.documentElement || document.body;
	if (!root) return;
	root.appendChild(host);
	duplicateWarningToastHost = host;

	duplicateWarningToastHideTimer = setTimeout(() => {
		duplicateWarningToastHideTimer = null;
		hideDuplicateWarningToast();
	}, DUPLICATE_WARNING_TOAST_DURATION_MS);
}

}
