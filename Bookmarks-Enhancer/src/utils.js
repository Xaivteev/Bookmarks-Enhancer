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
function normalizeHrefForSearch(href) {
	try {
		if (urlNormalizationCache.has(href)) {
			return urlNormalizationCache.get(href);
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

		urlNormalizationCache.set(href, normalized);
		return normalized;
	} catch {
		urlNormalizationCache.set(href, href);
		return href;
	}
}
