const hostEl = document.querySelector("#host");
const statusEl = document.querySelector("#status");
const countsEl = document.querySelector("#counts");
const revealRow = document.querySelector("#revealRow");
const revealHidden = document.querySelector("#revealHidden");
const refreshBtn = document.querySelector("#refreshBtn");
const pickClassesBtn = document.querySelector("#pickClassesBtn");
const settingsBtn = document.querySelector("#settingsBtn");
const errorEl = document.querySelector("#error");
const linkSearch = document.querySelector("#linkSearch");
const searchTitles = document.querySelector("#searchTitles");
const searchUrls = document.querySelector("#searchUrls");
const searchThisSite = document.querySelector("#searchThisSite");
const searchAllSites = document.querySelector("#searchAllSites");
const searchStatus = document.querySelector("#searchStatus");
const searchResults = document.querySelector("#searchResults");

const POPUP_SEARCH_PREFS_KEY = "bePopupSearchPrefs";
const SEARCH_DEBOUNCE_MS = 150;

let popupState = null;
let busy = false;
let searchTimer = null;
let searchGeneration = 0;
let preferredAllSites = false;

function formatCount(value) {
	return Number(value).toLocaleString();
}

function pluralize(value, singular, plural) {
	return value === 1 ? singular : plural;
}

function setError(message) {
	if (!errorEl) return;
	if (!message) {
		errorEl.hidden = true;
		errorEl.textContent = "";
		return;
	}
	errorEl.hidden = false;
	errorEl.textContent = message;
}

function setButtonLoading(button, loading, idleLabel, busyLabel) {
	if (!button) return;
	button.disabled = loading || button.dataset.keepDisabled === "true";
	button.classList.toggle("is-loading", loading);
	button.setAttribute("aria-busy", loading ? "true" : "false");
	if (loading) {
		if (!button.dataset.idleLabel) button.dataset.idleLabel = idleLabel || button.textContent;
		button.textContent = busyLabel || "Working…";
		return;
	}
	button.textContent = button.dataset.idleLabel || idleLabel || button.textContent;
}

function sendPopupMessage(payload) {
	return browser.runtime.sendMessage(payload);
}

function currentSearchPrefs() {
	return {
		searchTitles: !searchTitles || searchTitles.checked,
		searchUrls: !searchUrls || searchUrls.checked,
		allSites: hasSearchableHost()
			? !!(searchAllSites && searchAllSites.checked)
			: preferredAllSites
	};
}

function applySearchPrefs(prefs) {
	preferredAllSites = !!prefs.allSites;
	if (searchTitles) searchTitles.checked = prefs.searchTitles !== false;
	if (searchUrls) searchUrls.checked = prefs.searchUrls !== false;
	if (!searchTitles?.checked && !searchUrls?.checked && searchTitles) {
		searchTitles.checked = true;
	}
	syncSearchScope();
}

function loadSearchPrefs() {
	return browser.storage.local.get(POPUP_SEARCH_PREFS_KEY).then(result => {
		const prefs = result && result[POPUP_SEARCH_PREFS_KEY];
		if (prefs && typeof prefs === "object") applySearchPrefs(prefs);
		else syncSearchScope();
	}).catch(() => {
		syncSearchScope();
	});
}

function saveSearchPrefs() {
	return browser.storage.local.set({
		[POPUP_SEARCH_PREFS_KEY]: currentSearchPrefs()
	}).catch(() => {});
}

function hasSearchableHost() {
	return !!(popupState && popupState.host);
}

function syncSearchScope() {
	const canUseThisSite = hasSearchableHost();
	if (searchThisSite) searchThisSite.disabled = !canUseThisSite;
	if (!canUseThisSite) {
		if (searchAllSites) searchAllSites.checked = true;
		if (searchThisSite) searchThisSite.checked = false;
		return;
	}
	if (searchThisSite) searchThisSite.checked = !preferredAllSites;
	if (searchAllSites) searchAllSites.checked = preferredAllSites;
}

function setSearchStatus(message) {
	if (!searchStatus) return;
	if (!message) {
		searchStatus.hidden = true;
		searchStatus.textContent = "";
		return;
	}
	searchStatus.hidden = false;
	searchStatus.textContent = message;
}

function clearSearchResults() {
	if (searchResults) {
		searchResults.replaceChildren();
		searchResults.hidden = true;
	}
}

function openSearchMatch(url) {
	if (!url) return;
	browser.tabs.create({ url }).then(() => {
		closePopup();
	}).catch(error => {
		setError(String(error && error.message ? error.message : error));
	});
}

function renderSearchMatches(result, allSites) {
	if (!searchResults) return;
	searchResults.replaceChildren();
	const matches = Array.isArray(result?.matches) ? result.matches : [];
	if (matches.length === 0) {
		searchResults.hidden = true;
		return;
	}

	for (const match of matches) {
		const item = document.createElement("li");
		const button = document.createElement("button");
		button.type = "button";
		button.className = "searchResult";
		button.dataset.url = match.url || "";

		const title = document.createElement("div");
		title.className = "searchResultTitle";
		title.textContent = match.title || match.url || "Untitled link";

		const metaParts = [];
		if (allSites && match.site) metaParts.push(match.site);
		if (match.look) metaParts.push(match.look);
		if (metaParts.length > 0) {
			const meta = document.createElement("div");
			meta.className = "searchResultMeta";
			meta.textContent = metaParts.join(" · ");
			button.append(title, meta);
		} else {
			button.appendChild(title);
		}

		if (match.url && match.url !== (match.title || "")) {
			const urlEl = document.createElement("div");
			urlEl.className = "searchResultUrl";
			urlEl.textContent = match.url;
			button.appendChild(urlEl);
		}

		item.appendChild(button);
		searchResults.appendChild(item);
	}
	searchResults.hidden = false;
}

function runSearch() {
	const query = (linkSearch?.value || "").trim();
	searchGeneration += 1;
	const generation = searchGeneration;

	if (!query) {
		setSearchStatus("");
		clearSearchResults();
		return Promise.resolve();
	}

	const prefs = currentSearchPrefs();
	const allSites = prefs.allSites || !hasSearchableHost();
	if (!prefs.searchTitles && !prefs.searchUrls) {
		setSearchStatus("Choose Titles, URLs, or both.");
		clearSearchResults();
		return Promise.resolve();
	}
	if (!allSites && !hasSearchableHost()) {
		setSearchStatus("No site to search.");
		clearSearchResults();
		return Promise.resolve();
	}

	setSearchStatus("Searching…");
	return sendPopupMessage({
		actionPopupSearchLinks: true,
		query,
		searchTitles: prefs.searchTitles,
		searchUrls: prefs.searchUrls,
		allSites,
		host: popupState?.host || ""
	}).then(result => {
		if (generation !== searchGeneration) return;
		if (!result || result.ok === false) {
			clearSearchResults();
			setSearchStatus(result && result.error ? result.error : "Search failed.");
			return;
		}
		const total = Number(result.total) || 0;
		if (total === 0) {
			clearSearchResults();
			setSearchStatus("No matching links.");
			return;
		}
		if (result.truncated) {
			setSearchStatus(`Showing ${formatCount(result.matches.length)} of ${formatCount(total)}`);
		} else {
			setSearchStatus(`${formatCount(total)} ${pluralize(total, "match", "matches")}`);
		}
		renderSearchMatches(result, allSites);
	}).catch(error => {
		if (generation !== searchGeneration) return;
		clearSearchResults();
		setSearchStatus(String(error && error.message ? error.message : error));
	});
}

function scheduleSearch() {
	if (searchTimer) clearTimeout(searchTimer);
	if (!(linkSearch?.value || "").trim()) {
		runSearch();
		return;
	}
	searchTimer = setTimeout(() => {
		searchTimer = null;
		runSearch();
	}, SEARCH_DEBOUNCE_MS);
}

function renderPopup(state) {
	popupState = state && state.ok ? state : null;
	const canAct = !!(popupState && !popupState.restricted && popupState.tabId != null);

	if (hostEl) hostEl.textContent = popupState?.host || "";

	if (!popupState) {
		if (statusEl) statusEl.textContent = "Couldn't read this tab.";
		if (countsEl) {
			countsEl.hidden = true;
			countsEl.textContent = "";
		}
		if (revealRow) revealRow.hidden = true;
		if (refreshBtn) {
			refreshBtn.dataset.keepDisabled = "true";
			refreshBtn.disabled = true;
		}
		if (pickClassesBtn) {
			pickClassesBtn.dataset.keepDisabled = "true";
			pickClassesBtn.disabled = true;
		}
		if (settingsBtn) settingsBtn.disabled = busy;
		syncSearchScope();
		return;
	}

	if (popupState.restricted) {
		if (statusEl) statusEl.textContent = "Looks can't run on this page.";
	} else if (!popupState.siteMatch) {
		if (statusEl) statusEl.textContent = "This site isn't set up yet.";
	} else if (popupState.classGroupCount === 0) {
		if (statusEl) {
			statusEl.textContent = "No class groups yet — cards can't be styled until you pick them.";
		}
	} else {
		if (statusEl) statusEl.textContent = "Set up";
	}

	const parts = [];
	if (popupState.siteMatch) {
		parts.push(
			`${formatCount(popupState.savedLinkCount)} saved ${pluralize(popupState.savedLinkCount, "link", "links")}`
		);
	}
	if (popupState.pageReady && popupState.styled != null && popupState.hidden != null) {
		parts.push(`Styled ${formatCount(popupState.styled)}`);
		parts.push(`Hidden ${formatCount(popupState.hidden)}`);
	}
	if (countsEl) {
		countsEl.textContent = parts.join(" · ");
		countsEl.hidden = parts.length === 0;
	}

	if (revealRow && revealHidden) {
		revealRow.hidden = !(canAct && popupState.pageReady);
		revealHidden.checked = !!popupState.revealHidden;
		revealHidden.disabled = busy || !canAct;
	}

	if (refreshBtn) {
		refreshBtn.dataset.keepDisabled = canAct ? "" : "true";
		refreshBtn.disabled = busy || !canAct;
	}
	if (pickClassesBtn) {
		pickClassesBtn.dataset.keepDisabled = canAct ? "" : "true";
		pickClassesBtn.disabled = busy || !canAct;
	}
	if (settingsBtn) settingsBtn.disabled = busy;
	syncSearchScope();
}

function loadPopupState() {
	return sendPopupMessage({ getActionPopupState: true }).then(state => {
		renderPopup(state);
		if (!state || !state.ok) {
			setError(state && state.error ? state.error : "Couldn't load this tab.");
		} else {
			setError("");
		}
		return state;
	}).catch(error => {
		renderPopup(null);
		setError(String(error && error.message ? error.message : error));
	});
}

function closePopup() {
	window.close();
}

refreshBtn?.addEventListener("click", () => {
	if (busy || !popupState?.tabId) return;
	busy = true;
	setError("");
	setButtonLoading(refreshBtn, true, "Refresh this tab", "Refreshing…");
	renderPopup(popupState);
	sendPopupMessage({ actionPopupRefreshTab: true, tabId: popupState.tabId })
		.then(result => {
			if (result && result.ok === false) {
				throw new Error(result.error || "Refresh failed");
			}
			return loadPopupState();
		})
		.catch(error => {
			setError(String(error && error.message ? error.message : error));
		})
		.finally(() => {
			busy = false;
			setButtonLoading(refreshBtn, false, "Refresh this tab");
			renderPopup(popupState);
		});
});

pickClassesBtn?.addEventListener("click", () => {
	if (busy || !popupState?.tabId) return;
	busy = true;
	setError("");
	setButtonLoading(pickClassesBtn, true, "Select target classes", "Opening…");
	sendPopupMessage({ actionPopupStartClassPicker: true, tabId: popupState.tabId })
		.then(result => {
			if (result && result.ok === false) {
				throw new Error(result.error || "Couldn't start class picker");
			}
			closePopup();
		})
		.catch(error => {
			busy = false;
			setButtonLoading(pickClassesBtn, false, "Select target classes");
			renderPopup(popupState);
			setError(String(error && error.message ? error.message : error));
		});
});

settingsBtn?.addEventListener("click", () => {
	if (busy) return;
	busy = true;
	setError("");
	setButtonLoading(settingsBtn, true, "Open settings", "Opening…");
	sendPopupMessage({
		actionPopupOpenSettings: true,
		url: popupState?.url || ""
	}).then(result => {
		if (result && result.ok === false) {
			throw new Error(result.error || "Couldn't open settings");
		}
		closePopup();
	}).catch(error => {
		busy = false;
		setButtonLoading(settingsBtn, false, "Open settings");
		setError(String(error && error.message ? error.message : error));
	});
});

revealHidden?.addEventListener("change", () => {
	if (busy || !popupState?.tabId) {
		revealHidden.checked = !!popupState?.revealHidden;
		return;
	}
	const enabled = revealHidden.checked;
	sendPopupMessage({
		actionPopupSetRevealHidden: true,
		tabId: popupState.tabId,
		enabled
	}).then(result => {
		if (popupState) popupState.revealHidden = !!(result && result.revealHidden);
		if (result && result.ok === false) {
			throw new Error(result.error || "Couldn't update hidden items");
		}
	}).catch(error => {
		revealHidden.checked = !enabled;
		if (popupState) popupState.revealHidden = !enabled;
		setError(String(error && error.message ? error.message : error));
	});
});

function keepAtLeastOneSearchField(event) {
	if (searchTitles?.checked || searchUrls?.checked) return;
	if (event?.target) event.target.checked = true;
	else if (searchTitles) searchTitles.checked = true;
}

searchTitles?.addEventListener("change", event => {
	keepAtLeastOneSearchField(event);
	saveSearchPrefs();
	scheduleSearch();
});
searchUrls?.addEventListener("change", event => {
	keepAtLeastOneSearchField(event);
	saveSearchPrefs();
	scheduleSearch();
});
searchThisSite?.addEventListener("change", () => {
	if (searchThisSite.checked) preferredAllSites = false;
	saveSearchPrefs();
	scheduleSearch();
});
searchAllSites?.addEventListener("change", () => {
	if (searchAllSites.checked) preferredAllSites = true;
	saveSearchPrefs();
	scheduleSearch();
});
linkSearch?.addEventListener("input", scheduleSearch);
linkSearch?.addEventListener("search", scheduleSearch);
searchResults?.addEventListener("click", event => {
	const button = event.target.closest(".searchResult");
	if (!button) return;
	openSearchMatch(button.dataset.url);
});

loadSearchPrefs().finally(() => {
	loadPopupState().then(() => {
		if ((linkSearch?.value || "").trim()) runSearch();
	});
});
