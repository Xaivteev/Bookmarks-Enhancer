/* Background service worker entry for Manifest V3.
 * Loads the Promise-based browser API, shared utils, link index, then the message router.
 */
importScripts(
	"browser-polyfill.js",
	"utils.js",
	"utilsSites.js",
	"backgroundLinks.js",
	"backgroundScript.js"
);
