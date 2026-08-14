// Recover from a prior inject that set the guard then threw before exporting start.
if (
	globalThis.__beClassPickerInstalled &&
	typeof globalThis.__beStartClassPicker !== "function"
) {
	globalThis.__beClassPickerInstalled = false;
}

if (!globalThis.__beClassPickerInstalled) {

const CLASS_PICKER_PREFIX = "be-class-picker-";
const CLASS_PICKER_MATCH = `${CLASS_PICKER_PREFIX}match`;
const CLASS_PICKER_CURRENT = `${CLASS_PICKER_PREFIX}current`;
const CLASS_PICKER_HOST_ID = `${CLASS_PICKER_PREFIX}host`;
const CLASS_PICKER_STYLE_ID = `${CLASS_PICKER_PREFIX}styles`;
const EXTENSION_CLASS_PREFIX = "be-bookmarks-enhancer-";

let classPickerState = null;
let classPickerSessionId = 0;
let classPickerPageListenersAttached = false;

browser.runtime.onMessage.addListener(message => {
	if (message && message.startClassPicker) {
		startClassPicker();
	}
});

function attachClassPickerPageListeners() {
	if (classPickerPageListenersAttached) return;
	classPickerPageListenersAttached = true;
	window.addEventListener("pointerdown", suppressClassPickerPageEvent, true);
	window.addEventListener("pointerup", suppressClassPickerPageEvent, true);
	window.addEventListener("mousedown", suppressClassPickerPageEvent, true);
	window.addEventListener("mouseup", suppressClassPickerPageEvent, true);
	window.addEventListener("click", handleClassPickerClick, true);
	window.addEventListener("keydown", handleClassPickerKeyDown, true);
}

function detachClassPickerPageListeners() {
	if (!classPickerPageListenersAttached) return;
	classPickerPageListenersAttached = false;
	window.removeEventListener("pointerdown", suppressClassPickerPageEvent, true);
	window.removeEventListener("pointerup", suppressClassPickerPageEvent, true);
	window.removeEventListener("mousedown", suppressClassPickerPageEvent, true);
	window.removeEventListener("mouseup", suppressClassPickerPageEvent, true);
	window.removeEventListener("click", handleClassPickerClick, true);
	window.removeEventListener("keydown", handleClassPickerKeyDown, true);
}

function startClassPicker() {
	stopClassPicker();

	classPickerState = {
		sessionId: ++classPickerSessionId,
		active: true,
		frozen: false,
		hoveredElement: null,
		selectedElement: null,
		selectedClasses: new Set(),
		selectionHistory: [],
		host: null,
		shadow: null,
		countElement: null,
		warningElement: null,
		saveButton: null,
		previouslyFocusedElement: document.activeElement,
		dragging: false,
		dragOffsetX: 0,
		dragOffsetY: 0,
		position: null
	};

	attachClassPickerPageListeners();
	injectClassPickerStyles();
	createClassPickerPanel();
	window.addEventListener("resize", clampClassPickerHostToViewport);
	document.addEventListener("pointermove", handleClassPickerPointerMove, true);
}

// Callable from background via scripting.executeScript (avoids message races).
globalThis.__beStartClassPicker = startClassPicker;

function stopClassPicker() {
	if (!classPickerState) return;

	document.removeEventListener("pointermove", handleClassPickerPointerMove, true);
	window.removeEventListener("resize", clampClassPickerHostToViewport);
	detachClassPickerPageListeners();
	clearClassPickerHighlights();
	if (classPickerState.host) {
		try {
			classPickerState.host.hidePopover?.();
		} catch {
			// Host may already be disconnected.
		}
		classPickerState.host.remove();
	}
	document.getElementById(CLASS_PICKER_STYLE_ID)?.remove();
	if (classPickerState.previouslyFocusedElement?.isConnected) {
		classPickerState.previouslyFocusedElement.focus();
	}
	classPickerState = null;
}

function injectClassPickerStyles() {
	document.getElementById(CLASS_PICKER_STYLE_ID)?.remove();

	const style = document.createElement("style");
	style.id = CLASS_PICKER_STYLE_ID;
	style.textContent = `
		.${CLASS_PICKER_MATCH} {
			outline: 3px solid #22c55e !important;
			outline-offset: -3px !important;
		}
		.${CLASS_PICKER_CURRENT} {
			outline: 4px solid #f59e0b !important;
			outline-offset: -4px !important;
		}
	`;
	(document.head || document.documentElement).appendChild(style);
}

function applyClassPickerHostStyles(host) {
	// Inline !important beats page author styles that target bare divs / html>*.
	// IMPORTANT: set `inset` before top/right/left/bottom. `inset` is a shorthand
	// and would otherwise clear the explicit edges (Firefox then leaves the fixed
	// host at its static position, often off-screen).
	const hostStyles = [
		["display", "block"],
		["position", "fixed"],
		["z-index", "2147483647"],
		["inset", "auto"],
		["top", "16px"],
		["right", "16px"],
		["left", "auto"],
		["bottom", "auto"],
		["width", "min(380px, calc(100vw - 32px))"],
		["max-width", "calc(100vw - 32px)"],
		["height", "auto"],
		["max-height", "calc(100vh - 32px)"],
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
		["contain", "none"],
		["color-scheme", "dark"]
	];

	for (const [property, value] of hostStyles) {
		host.style.setProperty(property, value, "important");
	}
	applyClassPickerHostPosition(host);
}

function isFirefoxBrowser() {
	return typeof CSS !== "undefined" && CSS.supports("(-moz-appearance: none)");
}

function isClassPickerHostVisible(host) {
	if (!host?.isConnected) return false;
	const rect = host.getBoundingClientRect();
	return rect.width > 1 && rect.height > 1;
}

function promoteClassPickerHostToTopLayer(host) {
	// Top layer escapes page stacking contexts / transforms that break
	// position:fixed in Chrome. Skip on Firefox — fixed on <html> is reliable.
	if (isFirefoxBrowser() || typeof host.showPopover !== "function") return;

	try {
		host.setAttribute("popover", "manual");
		host.showPopover();
		applyClassPickerHostStyles(host);
		if (host.matches(":popover-open") && isClassPickerHostVisible(host)) {
			return;
		}
	} catch {
		// Ignore if the UA rejects popover in this document.
	}

	try {
		host.hidePopover?.();
	} catch {
		// Host may already be disconnected or not a popover.
	}
	host.removeAttribute("popover");
	applyClassPickerHostStyles(host);
}

function createClassPickerPanel() {
	const host = document.createElement("div");
	host.id = CLASS_PICKER_HOST_ID;
	host.setAttribute("data-be-class-picker", "host");
	applyClassPickerHostStyles(host);

	const shadow = host.attachShadow({ mode: "open" });
	classPickerState.host = host;
	classPickerState.shadow = shadow;

	const style = document.createElement("style");
	style.textContent = `
		:host {
			display: block !important;
			position: fixed !important;
			z-index: 2147483647 !important;
			inset: auto !important;
			top: 16px !important;
			right: 16px !important;
			left: auto !important;
			bottom: auto !important;
			width: min(380px, calc(100vw - 32px)) !important;
			max-width: calc(100vw - 32px) !important;
			margin: 0 !important;
			color-scheme: dark !important;
		}
		.panel {
			box-sizing: border-box;
			display: block;
			width: 100%;
			max-height: calc(100vh - 32px);
			overflow: auto;
			padding: 16px;
			border: 1px solid #475569;
			border-radius: 10px;
			background: #0f172a;
			color: #f8fafc;
			box-shadow: 0 16px 40px rgb(0 0 0 / 45%);
			font: 14px/1.4 system-ui, -apple-system, sans-serif;
		}
		h2 {
			margin: 0;
			font-size: 17px;
		}
		.panelHeader {
			display: flex;
			align-items: center;
			gap: 8px;
			margin: -4px -4px 10px;
			padding: 6px 4px;
			cursor: grab;
			user-select: none;
			touch-action: none;
		}
		.panelHeader.is-dragging {
			cursor: grabbing;
		}
		.dragGrip {
			position: relative;
			flex: 0 0 auto;
			width: 10px;
			height: 14px;
		}
		.dragGrip::before,
		.dragGrip::after {
			content: "";
			position: absolute;
			top: 1px;
			width: 2px;
			height: 2px;
			border-radius: 50%;
			background: #94a3b8;
			box-shadow: 0 4px 0 #94a3b8, 0 8px 0 #94a3b8;
		}
		.dragGrip::before { left: 1px; }
		.dragGrip::after { left: 5px; }
		p {
			margin: 6px 0;
		}
		.muted {
			color: #cbd5e1;
			font-size: 12px;
		}
		.classes {
			display: grid;
			gap: 6px;
			margin: 12px 0;
			padding: 0;
			border: 0;
		}
		.class-option {
			display: flex;
			gap: 8px;
			align-items: flex-start;
			overflow-wrap: anywhere;
		}
		.generated {
			color: #fbbf24;
		}
		.warning {
			min-height: 20px;
			color: #fbbf24;
		}
		.actions {
			display: flex;
			flex-wrap: wrap;
			gap: 8px;
			margin-top: 12px;
		}
		button {
			padding: 7px 10px;
			border: 1px solid #64748b;
			border-radius: 6px;
			background: #1e293b;
			color: #f8fafc;
			cursor: pointer;
			font: inherit;
		}
		button:hover:not(:disabled) {
			background: #334155;
		}
		button:focus-visible,
		input:focus-visible {
			outline: 2px solid #38bdf8;
			outline-offset: 2px;
		}
		button.primary {
			border-color: #15803d;
			background: #166534;
		}
		button:disabled {
			cursor: not-allowed;
			opacity: 0.5;
		}
		code {
			color: #bae6fd;
		}
	`;
	shadow.appendChild(style);

	// Firefox: mount on <html> (pre-popover behavior). Chrome: prefer <body>,
	// then promote to the top layer when possible.
	const mountRoot = isFirefoxBrowser()
		? document.documentElement
		: (document.body || document.documentElement);
	mountRoot.appendChild(host);

	renderClassPickerInstructions();
	promoteClassPickerHostToTopLayer(host);
}

function renderClassPickerInstructions() {
	const panel = document.createElement("section");
	panel.className = "panel";
	panel.setAttribute("role", "dialog");
	panel.setAttribute("aria-label", "Select target classes");

	const heading = createClassPickerHeader("Select target classes");

	const instructions = document.createElement("p");
	instructions.textContent = "Hover over the page and click the element you want the extension to affect.";

	const help = document.createElement("p");
	help.className = "muted";
	help.textContent = "Drag the header to move this panel. Press Escape to cancel. Page clicks are blocked while selecting.";

	const actions = document.createElement("div");
	actions.className = "actions";
	const cancelButton = createClassPickerButton("Cancel", stopClassPicker);
	actions.appendChild(cancelButton);

	panel.append(heading, instructions, help, actions);
	replaceClassPickerPanel(panel);
	setTimeout(() => {
		if (classPickerState?.active) {
			cancelButton.focus();
		}
	}, 0);
}

function replaceClassPickerPanel(panel) {
	const existingPanel = classPickerState.shadow.querySelector(".panel");
	existingPanel?.remove();
	classPickerState.shadow.appendChild(panel);
	attachClassPickerDrag(panel);
	clampClassPickerHostToViewport();
}

function createClassPickerHeader(title) {
	const header = document.createElement("div");
	header.className = "panelHeader";
	header.setAttribute("data-drag-handle", "");
	header.setAttribute("aria-label", "Drag to move panel");

	const grip = document.createElement("span");
	grip.className = "dragGrip";
	grip.setAttribute("aria-hidden", "true");

	const heading = document.createElement("h2");
	heading.textContent = title;

	header.append(grip, heading);
	return header;
}

const CLASS_PICKER_VIEWPORT_MARGIN = 8;

function applyClassPickerHostPosition(host) {
	if (!host) return;
	const position = classPickerState?.position;
	if (!position) {
		host.style.setProperty("top", "16px", "important");
		host.style.setProperty("right", "16px", "important");
		host.style.setProperty("left", "auto", "important");
		host.style.setProperty("bottom", "auto", "important");
		return;
	}

	host.style.setProperty("top", `${position.top}px`, "important");
	host.style.setProperty("left", `${position.left}px`, "important");
	host.style.setProperty("right", "auto", "important");
	host.style.setProperty("bottom", "auto", "important");
}

function clampClassPickerHostToViewport() {
	if (!classPickerState?.host || !classPickerState.position) return;

	const host = classPickerState.host;
	const width = host.offsetWidth;
	const height = host.offsetHeight;
	const margin = CLASS_PICKER_VIEWPORT_MARGIN;
	const maxLeft = Math.max(margin, window.innerWidth - width - margin);
	const maxTop = Math.max(margin, window.innerHeight - height - margin);
	classPickerState.position = {
		left: Math.min(Math.max(margin, classPickerState.position.left), maxLeft),
		top: Math.min(Math.max(margin, classPickerState.position.top), maxTop)
	};
	applyClassPickerHostPosition(host);
}

function attachClassPickerDrag(panel) {
	const handle = panel.querySelector("[data-drag-handle]");
	if (!handle) return;

	handle.addEventListener("pointerdown", event => {
		if (event.button != null && event.button !== 0) return;
		event.preventDefault();
		event.stopPropagation();
		beginClassPickerDrag(event, handle);
	});
}

function beginClassPickerDrag(event, handle) {
	const host = classPickerState?.host;
	if (!host) return;

	const rect = host.getBoundingClientRect();
	classPickerState.dragging = true;
	classPickerState.dragOffsetX = event.clientX - rect.left;
	classPickerState.dragOffsetY = event.clientY - rect.top;
	classPickerState.position = { left: rect.left, top: rect.top };
	applyClassPickerHostPosition(host);
	handle.classList.add("is-dragging");

	try {
		handle.setPointerCapture(event.pointerId);
	} catch {
		// Pointer capture is optional; window listeners still move the panel.
	}

	const onMove = moveEvent => {
		if (!classPickerState?.dragging) return;
		moveClassPickerHost(moveEvent.clientX, moveEvent.clientY);
	};
	const onUp = upEvent => {
		if (classPickerState) {
			classPickerState.dragging = false;
		}
		handle.classList.remove("is-dragging");
		handle.removeEventListener("pointermove", onMove);
		handle.removeEventListener("pointerup", onUp);
		handle.removeEventListener("pointercancel", onUp);
		try {
			handle.releasePointerCapture(upEvent.pointerId);
		} catch {
			// Capture may already have been released.
		}
	};

	handle.addEventListener("pointermove", onMove);
	handle.addEventListener("pointerup", onUp);
	handle.addEventListener("pointercancel", onUp);
}

function moveClassPickerHost(clientX, clientY) {
	if (!classPickerState?.host) return;

	classPickerState.position = {
		left: clientX - classPickerState.dragOffsetX,
		top: clientY - classPickerState.dragOffsetY
	};
	clampClassPickerHostToViewport();
}

function createClassPickerButton(label, onClick, className = "") {
	const button = document.createElement("button");
	button.type = "button";
	button.textContent = label;
	button.className = className;
	button.addEventListener("click", onClick);
	return button;
}

function handleClassPickerPointerMove(event) {
	if (!classPickerState?.active || classPickerState.frozen || classPickerState.dragging) return;
	if (isClassPickerUiTarget(event.target)) return;

	const element = event.target instanceof Element ? event.target : null;
	if (!element || element === classPickerState.hoveredElement) return;

	classPickerState.hoveredElement?.classList.remove(CLASS_PICKER_CURRENT);
	classPickerState.hoveredElement = element;
	element.classList.add(CLASS_PICKER_CURRENT);
}

function suppressClassPickerPageEvent(event) {
	if (!classPickerState?.active || isClassPickerUiTarget(event.target)) return;

	event.preventDefault();
	event.stopImmediatePropagation();
}

function handleClassPickerClick(event) {
	if (!classPickerState?.active || isClassPickerUiTarget(event.target)) return;

	event.preventDefault();
	event.stopImmediatePropagation();

	const element = event.target instanceof Element ? event.target : null;
	if (!element) return;

	selectClassPickerElement(element, false);
}

function handleClassPickerKeyDown(event) {
	if (!classPickerState?.active) return;

	if (event.key === "Tab") {
		const focusableElements = Array.from(
			classPickerState.shadow.querySelectorAll(
				'button:not(:disabled), input:not(:disabled)'
			)
		);
		if (focusableElements.length === 0) return;

		const first = focusableElements[0];
		const last = focusableElements.at(-1);
		const activeElement = classPickerState.shadow.activeElement;
		if (event.shiftKey && (activeElement === first || !activeElement)) {
			event.preventDefault();
			last.focus();
		} else if (!event.shiftKey && activeElement === last) {
			event.preventDefault();
			first.focus();
		}
		return;
	}

	if (event.key !== "Escape") return;

	event.preventDefault();
	event.stopImmediatePropagation();
	stopClassPicker();
}

function isClassPickerUiTarget(target) {
	if (!classPickerState?.host || !(target instanceof Node)) return false;
	if (target === classPickerState.host || classPickerState.host.contains(target)) {
		return true;
	}
	// Nodes inside the open shadow tree are not light-DOM descendants of the host.
	return target.getRootNode() === classPickerState.shadow;
}

function selectClassPickerElement(element, preserveHistory) {
	clearClassPickerHighlights();
	classPickerState.frozen = true;
	classPickerState.hoveredElement = null;
	classPickerState.selectedElement = element;

	if (!preserveHistory) {
		classPickerState.selectionHistory = [element];
	}

	const availableClasses = getSelectableClasses(element);
	const stableClasses = availableClasses.filter(className => !looksGeneratedClass(className));
	classPickerState.selectedClasses = new Set(
		stableClasses.length > 0 ? stableClasses : availableClasses
	);
	element.classList.add(CLASS_PICKER_CURRENT);
	renderClassPickerSelection(availableClasses);
	updateClassPickerPreview();
}

function getSelectableClasses(element) {
	return Array.from(element.classList).filter(className =>
		className &&
		!className.startsWith(CLASS_PICKER_PREFIX) &&
		!className.startsWith(EXTENSION_CLASS_PREFIX)
	);
}

function looksGeneratedClass(className) {
	return className.length > 40 ||
		/(?:^|[-_])(?:css|sc|jsx)-?[a-z0-9_-]{6,}/i.test(className) ||
		/(?:^|[-_])[a-f0-9]{10,}(?:$|[-_])/i.test(className) ||
		/\d{7,}/.test(className);
}

function saveClassPickerSelection() {
	const sessionId = classPickerState.sessionId;
	const site = normalizeSite(window.location.hostname);
	const selectedClassGroup = parseClassGroups(
		Array.from(classPickerState.selectedClasses).join(' ')
	)[0];
	if (!site || !selectedClassGroup) return;

	classPickerState.saveButton.disabled = true;
	classPickerState.saveButton.textContent = "Saving…";

	browser.storage.local.get(null).then(result => {
		const existing = migrateSitesFromStorage(result);
		const next = mergeClassGroupIntoSites(
			existing,
			site,
			selectedClassGroup
		);
		return browser.storage.local.set({ [STORAGE_KEYS.sites]: next });
	}).then(() => {
		if (classPickerState?.sessionId !== sessionId) return;
		classPickerState.saveButton.textContent = "Saved";
		setTimeout(() => {
			if (classPickerState?.sessionId === sessionId) {
				stopClassPicker();
			}
		}, 700);
	}).catch(error => {
		if (classPickerState?.sessionId !== sessionId) return;
		console.error("Could not save selected classes:", error);
		classPickerState.saveButton.disabled = false;
		classPickerState.saveButton.textContent = "Try again";
		classPickerState.warningElement.textContent =
			"Could not save the selected classes.";
	});
}

function renderClassPickerSelection(availableClasses) {
	const element = classPickerState.selectedElement;
	const panel = document.createElement("section");
	panel.className = "panel";
	panel.setAttribute("role", "dialog");
	panel.setAttribute("aria-label", "Confirm target classes");

	const heading = createClassPickerHeader("Confirm target classes");

	const site = document.createElement("p");
	site.append("Site: ");
	const siteCode = document.createElement("code");
	siteCode.textContent = normalizeSite(window.location.hostname);
	site.appendChild(siteCode);

	const selectedElement = document.createElement("p");
	selectedElement.append("Element: ");
	const elementCode = document.createElement("code");
	elementCode.textContent = element.tagName.toLowerCase();
	selectedElement.appendChild(elementCode);

	const classes = document.createElement("fieldset");
	classes.className = "classes";
	const legend = document.createElement("legend");
	legend.textContent = "Classes to require";
	classes.appendChild(legend);

	if (availableClasses.length === 0) {
		const noClasses = document.createElement("p");
		noClasses.className = "warning";
		noClasses.textContent = "This element has no usable classes. Choose a parent or another element.";
		classes.appendChild(noClasses);
	} else {
		availableClasses.forEach((className, index) => {
			const label = document.createElement("label");
			label.className = "class-option";
			if (looksGeneratedClass(className)) {
				label.classList.add("generated");
			}

			const checkbox = document.createElement("input");
			checkbox.type = "checkbox";
			checkbox.checked = classPickerState.selectedClasses.has(className);
			const generatedWarning = looksGeneratedClass(className)
				? "; looks generated and may change between visits"
				: "";
			checkbox.setAttribute(
				"aria-label",
				`Require class ${className}${generatedWarning}`
			);
			checkbox.addEventListener("change", () => {
				if (checkbox.checked) {
					classPickerState.selectedClasses.add(className);
				} else {
					classPickerState.selectedClasses.delete(className);
				}
				updateClassPickerPreview();
			});

			const text = document.createElement("span");
			text.textContent = looksGeneratedClass(className)
				? `${className} (looks generated; may change)`
				: className;
			if (looksGeneratedClass(className)) {
				text.title = "This class looks generated and may change between visits.";
			}

			label.append(checkbox, text);
			classes.appendChild(label);

			if (index === 0) {
				setTimeout(() => checkbox.focus(), 0);
			}
		});
	}

	const count = document.createElement("p");
	count.setAttribute("aria-live", "polite");
	classPickerState.countElement = count;

	const warning = document.createElement("p");
	warning.className = "warning";
	warning.setAttribute("aria-live", "polite");
	classPickerState.warningElement = warning;

	const explanation = document.createElement("p");
	explanation.className = "muted";
	explanation.textContent = "Checked classes are combined: matching elements must contain all of them.";

	const actions = document.createElement("div");
	actions.className = "actions";

	const parentButton = createClassPickerButton("Parent", () => {
		const parent = getSelectableParent(classPickerState.selectedElement);
		if (!parent) return;

		classPickerState.selectionHistory.push(parent);
		selectClassPickerElement(parent, true);
	});
	parentButton.disabled = !getSelectableParent(element);

	const childButton = createClassPickerButton("Back", () => {
		if (classPickerState.selectionHistory.length < 2) return;

		classPickerState.selectionHistory.pop();
		const child = classPickerState.selectionHistory.at(-1);
		selectClassPickerElement(child, true);
	});
	childButton.disabled = classPickerState.selectionHistory.length < 2;

	const repickButton = createClassPickerButton("Pick another", () => {
		clearClassPickerHighlights();
		classPickerState.frozen = false;
		classPickerState.selectedElement = null;
		classPickerState.selectedClasses = new Set();
		classPickerState.selectionHistory = [];
		renderClassPickerInstructions();
	});

	const cancelButton = createClassPickerButton("Cancel", stopClassPicker);
	const saveButton = createClassPickerButton("Save", saveClassPickerSelection, "primary");
	classPickerState.saveButton = saveButton;

	actions.append(parentButton, childButton, repickButton, cancelButton, saveButton);
	panel.append(heading, site, selectedElement, classes, count, warning, explanation, actions);
	replaceClassPickerPanel(panel);

	if (availableClasses.length === 0) {
		setTimeout(() => {
			if (!classPickerState?.active) return;
			(parentButton.disabled ? repickButton : parentButton).focus();
		}, 0);
	}
}

function getSelectableParent(element) {
	const parent = element?.parentElement;
	if (!parent || parent === document.body || parent === document.documentElement) {
		return null;
	}
	return parent;
}

function updateClassPickerPreview() {
	clearClassPickerMatchHighlights();

	const selectedClasses = Array.from(classPickerState.selectedClasses);
	const canSave = selectedClasses.length > 0;
	classPickerState.saveButton.disabled = !canSave;

	if (!canSave) {
		classPickerState.countElement.textContent = "Select at least one class.";
		classPickerState.warningElement.textContent = "";
		return;
	}

	const classGroup = selectedClasses.join(' ');
	const matches = Array.from(document.getElementsByClassName(classGroup))
		.filter(element => element !== classPickerState.host);
	for (const match of matches) {
		match.classList.add(CLASS_PICKER_MATCH);
	}
	classPickerState.selectedElement?.classList.add(CLASS_PICKER_CURRENT);

	classPickerState.countElement.textContent =
		`${matches.length} element${matches.length === 1 ? "" : "s"} match this combination.`;

	const generatedClasses = selectedClasses.filter(looksGeneratedClass);
	if (generatedClasses.length > 0) {
		classPickerState.warningElement.textContent =
			"Warning: selected generated-looking classes may change between visits.";
	} else if (matches.length === 0) {
		classPickerState.warningElement.textContent =
			"No elements currently match this combination.";
	} else if (matches.length > 100) {
		classPickerState.warningElement.textContent =
			"This selection is broad and may affect more elements than intended.";
	} else {
		classPickerState.warningElement.textContent = "";
	}
}

function clearClassPickerMatchHighlights() {
	for (const element of Array.from(document.getElementsByClassName(CLASS_PICKER_MATCH))) {
		element.classList.remove(CLASS_PICKER_MATCH);
	}
}

function clearClassPickerHighlights() {
	if (!classPickerState) return;

	clearClassPickerMatchHighlights();
	for (const element of Array.from(document.getElementsByClassName(CLASS_PICKER_CURRENT))) {
		element.classList.remove(CLASS_PICKER_CURRENT);
	}
}

globalThis.__beClassPickerInstalled = true;
} // end __beClassPickerInstalled install guard

// Runs on every inject so a re-inject can still launch after a prior install.
if (globalThis.__beLaunchClassPicker) {
	globalThis.__beLaunchClassPicker = false;
	if (typeof globalThis.__beStartClassPicker === "function") {
		globalThis.__beStartClassPicker();
	}
}
