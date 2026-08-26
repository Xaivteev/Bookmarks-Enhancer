/**
 * Class-picker helper. Load after utils.js and utilsSites.js. Injected into
 * the page only when selecting target classes.
 */


function mergeClassGroupIntoSites(sites, site, classGroup) {
	const { sites: next, siteConfig } = ensureSiteConfig(sites, site);
	if (!siteConfig) return next;
	siteConfig.classGroups = normalizeClassGroupList([
		...siteConfig.classGroups,
		classGroup
	]);
	return next;
}
