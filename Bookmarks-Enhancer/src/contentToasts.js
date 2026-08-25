/* Look-application progress toast. Loaded after contentScript.js.
 * Re-injection is guarded; functions read content-script globals at call time.
 */
if (!globalThis.__beContentToastsInstalled) {
globalThis.__beContentToastsInstalled = true;

const STYLING_INDICATOR_DELAY_MS = 300;
const STYLING_RESULT_DURATION_MS = 4000;
const STYLING_INDICATOR_HOST_ID = "bookmarks-enhancer-loading";
let stylingIndicatorDepth = 0;
let stylingIndicatorShowTimer = null;
let stylingResultHideTimer = null;
let stylingIndicatorHost = null;
let stylingIndicatorUserDismissed = false;

function formatStylingSummary({ styled = 0, hidden = 0 } = {}) {
	return `Styled ${styled} · Hidden ${hidden}`;
}

function beginStylingIndicator() {
	stylingIndicatorDepth += 1;
	stylingIndicatorUserDismissed = false;
	if (!enableToastNotifications) return;
	if (stylingIndicatorDepth !== 1) return;
	if (stylingResultHideTimer) {
		clearTimeout(stylingResultHideTimer);
		stylingResultHideTimer = null;
	}
	if (stylingIndicatorShowTimer) return;
	stylingIndicatorShowTimer = setTimeout(() => {
		stylingIndicatorShowTimer = null;
		if (
			stylingIndicatorDepth > 0 &&
			enableToastNotifications &&
			!stylingIndicatorUserDismissed
		) {
			showStylingIndicator("Applying looks…", { busy: true });
		}
	}, STYLING_INDICATOR_DELAY_MS);
}

function endStylingIndicator(summary = null) {
	if (stylingIndicatorDepth <= 0) return;
	stylingIndicatorDepth -= 1;
	if (stylingIndicatorDepth > 0) return;
	if (stylingIndicatorShowTimer) {
		clearTimeout(stylingIndicatorShowTimer);
		stylingIndicatorShowTimer = null;
	}

	if (!enableToastNotifications || stylingIndicatorUserDismissed) {
		hideStylingIndicator();
		return;
	}

	if (summary) {
		showStylingResult(summary);
		return;
	}

	hideStylingIndicator();
}

function showStylingResult(summary) {
	if (!enableToastNotifications || stylingIndicatorUserDismissed) {
		hideStylingIndicator();
		return;
	}

	showStylingIndicator(formatStylingSummary(summary), { busy: false });

	if (stylingResultHideTimer) {
		clearTimeout(stylingResultHideTimer);
	}
	stylingResultHideTimer = setTimeout(() => {
		stylingResultHideTimer = null;
		if (stylingIndicatorDepth === 0) {
			hideStylingIndicator();
		}
	}, STYLING_RESULT_DURATION_MS);
}

function dismissStylingIndicator() {
	stylingIndicatorUserDismissed = true;
	if (stylingIndicatorShowTimer) {
		clearTimeout(stylingIndicatorShowTimer);
		stylingIndicatorShowTimer = null;
	}
	hideStylingIndicator();
}

function showStylingIndicator(message, { busy = true } = {}) {
	if (!enableToastNotifications || stylingIndicatorUserDismissed) return;

	if (stylingIndicatorHost?.isConnected) {
		updateStylingIndicatorContent(message, busy);
		stylingIndicatorHost.hidden = false;
		return;
	}

	const existing = document.getElementById(STYLING_INDICATOR_HOST_ID);
	if (existing) {
		existing.remove();
	}

	const host = document.createElement("div");
	host.id = STYLING_INDICATOR_HOST_ID;
	host.setAttribute("data-be-styling-indicator", "host");
	host.setAttribute("role", "status");
	host.setAttribute("aria-live", "polite");
	host.style.cssText = [
		"all: initial",
		"position: fixed",
		"z-index: 2147483646",
		"right: 16px",
		"bottom: 16px",
		"pointer-events: none"
	].join(";");

	const shadow = host.attachShadow({ mode: "open" });
	const style = document.createElement("style");
	style.textContent = `
		:host {
			display: block !important;
		}
		.toast {
			display: flex;
			align-items: flex-start;
			gap: 8px;
			max-width: min(320px, calc(100vw - 32px));
			padding: 10px 12px;
			border: 1px solid #475569;
			border-radius: 8px;
			background: #0f172a;
			color: #f8fafc;
			box-shadow: 0 10px 28px rgb(0 0 0 / 35%);
			font: 13px/1.35 system-ui, -apple-system, sans-serif;
			pointer-events: auto;
		}
		.toast-main {
			display: flex;
			align-items: center;
			gap: 8px;
			flex: 1;
			min-width: 0;
		}
		.spinner {
			box-sizing: border-box;
			width: 14px;
			height: 14px;
			flex: 0 0 auto;
			border: 2px solid #94a3b8;
			border-top-color: #f8fafc;
			border-radius: 50%;
			animation: be-spin 0.7s linear infinite;
		}
		.spinner[hidden] {
			display: none;
		}
		.label {
			flex: 1;
			min-width: 0;
		}
		.dismiss {
			display: inline-flex;
			align-items: center;
			justify-content: center;
			flex: 0 0 auto;
			width: 1.35rem;
			height: 1.35rem;
			margin: -0.1rem -0.2rem 0 0;
			padding: 0;
			border: 0;
			border-radius: 4px;
			background: transparent;
			color: inherit;
			font: 700 1rem/1 system-ui, -apple-system, sans-serif;
			cursor: pointer;
			opacity: 0.85;
		}
		.dismiss:hover {
			background: rgb(255 255 255 / 14%);
			opacity: 1;
		}
		.dismiss:focus-visible {
			outline: 2px solid #f8fafc;
			outline-offset: 1px;
		}
		@keyframes be-spin {
			to { transform: rotate(360deg); }
		}
	`;

	const toast = document.createElement("div");
	toast.className = "toast";

	const main = document.createElement("div");
	main.className = "toast-main";

	const spinner = document.createElement("div");
	spinner.className = "spinner";
	spinner.setAttribute("aria-hidden", "true");

	const label = document.createElement("span");
	label.className = "label";

	main.append(spinner, label);

	const dismissBtn = document.createElement("button");
	dismissBtn.type = "button";
	dismissBtn.className = "dismiss";
	dismissBtn.setAttribute("aria-label", "Dismiss notification");
	dismissBtn.title = "Dismiss";
	dismissBtn.textContent = "×";
	dismissBtn.addEventListener("click", event => {
		event.preventDefault();
		event.stopPropagation();
		dismissStylingIndicator();
	});

	toast.append(main, dismissBtn);
	shadow.append(style, toast);

	const root = document.documentElement || document.body;
	if (!root) return;
	root.appendChild(host);
	stylingIndicatorHost = host;
	updateStylingIndicatorContent(message, busy);
}

function updateStylingIndicatorContent(message, busy) {
	const shadow = stylingIndicatorHost?.shadowRoot;
	if (!shadow) return;
	const label = shadow.querySelector(".label");
	const spinner = shadow.querySelector(".spinner");
	if (label) label.textContent = message;
	if (spinner) spinner.hidden = !busy;
}

function hideStylingIndicator() {
	if (stylingResultHideTimer) {
		clearTimeout(stylingResultHideTimer);
		stylingResultHideTimer = null;
	}
	if (!stylingIndicatorHost) {
		const existing = document.getElementById(STYLING_INDICATOR_HOST_ID);
		if (existing) existing.remove();
		return;
	}
	stylingIndicatorHost.remove();
	stylingIndicatorHost = null;
}

}
