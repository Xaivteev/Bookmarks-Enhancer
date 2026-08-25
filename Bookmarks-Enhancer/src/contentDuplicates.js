/* Duplicate-title warnings and their toast. Loaded after contentScript.js.
 * Re-injection is guarded; functions read content-script globals at call time.
 */
if (!globalThis.__beContentDuplicatesInstalled) {
globalThis.__beContentDuplicatesInstalled = true;

let duplicateWarningTimer = null;
let lastDuplicatePageToastKey = "";
let lastPageTitleScanUrl = "";
let lastPageTitleScanTitle = "";
let pageTitleScanPendingUrl = "";
let pageTitleScanPendingTitle = "";
let duplicateWarningToastHost = null;
let duplicateWarningToastHideTimer = null;

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

function clearDuplicateWarningPass() {
	if (duplicateWarningTimer) {
		clearTimeout(duplicateWarningTimer);
		duplicateWarningTimer = null;
	}
}

function scheduleDuplicateWarningPass() {
	if (!enableDuplicateWarning) {
		hideDuplicateWarningToast();
		return;
	}
	if (duplicateWarningTimer) return;
	duplicateWarningTimer = setTimeout(() => {
		duplicateWarningTimer = null;
		runDuplicateWarningPass();
	}, 80);
}

function rememberPageTitleScan(url, title) {
	lastPageTitleScanUrl = url;
	lastPageTitleScanTitle = title;
	if (pageTitleScanPendingUrl === url && pageTitleScanPendingTitle === title) {
		pageTitleScanPendingUrl = "";
		pageTitleScanPendingTitle = "";
	}
}

function clearPageTitleScanPending(url, title) {
	if (pageTitleScanPendingUrl === url && pageTitleScanPendingTitle === title) {
		pageTitleScanPendingUrl = "";
		pageTitleScanPendingTitle = "";
	}
}

function pageTitleScanAlreadyDone(url, title) {
	return url === lastPageTitleScanUrl && title === lastPageTitleScanTitle;
}

function pageTitleScanInFlight(url, title) {
	return url === pageTitleScanPendingUrl && title === pageTitleScanPendingTitle;
}

function runDuplicateWarningPass() {
	if (!enableDuplicateWarning || !searchSite) {
		hideDuplicateWarningToast();
		return;
	}
	matchDuplicatePageTitle(urlCacheGeneration);
}

function matchDuplicatePageTitle(urlGeneration) {
	const url = location.href;
	const title = document.title || "";

	if (pageHrefHasUrlMatch()) {
		lastDuplicatePageToastKey = "";
		rememberPageTitleScan(url, title);
		hideDuplicateWarningToast();
		return;
	}
	if (isGenericDuplicatePageTitle(title)) {
		lastDuplicatePageToastKey = "";
		rememberPageTitleScan(url, title);
		hideDuplicateWarningToast();
		return;
	}
	// Same URL+title already scanned (or in flight): skip the fuzzy pass.
	// New tabs, reloads, and SPA URL/title changes are not skipped.
	if (pageTitleScanAlreadyDone(url, title) || pageTitleScanInFlight(url, title)) {
		return;
	}

	pageTitleScanPendingUrl = url;
	pageTitleScanPendingTitle = title;
	browser.runtime.sendMessage({
		matchDuplicatePageTitle: true,
		url,
		title
	}).then(result => {
		if (urlGeneration !== urlCacheGeneration) {
			clearPageTitleScanPending(url, title);
			return;
		}
		rememberPageTitleScan(url, title);
		if (!enableDuplicateWarning) return;
		if (location.href !== url) return;
		if ((document.title || "") !== title) return;
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
	}).catch(() => {
		clearPageTitleScanPending(url, title);
	});
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
