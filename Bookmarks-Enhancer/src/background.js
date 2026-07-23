/* Background service worker entry for Manifest V3.
 * Loads the Promise-based browser API, shared utils, then the main background logic.
 */
importScripts("browser-polyfill.js", "utils.js", "backgroundScript.js");
