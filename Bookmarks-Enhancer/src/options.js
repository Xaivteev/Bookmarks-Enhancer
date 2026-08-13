const BOOKMARK_RULE_STORAGE_KEY = STORAGE_KEYS.bookmarkRules;
const STYLE_RULE_STORAGE_KEY = STORAGE_KEYS.styleRules;

let cachedBookmarkFolders = [];
let cachedStyleRules = DEFAULT_STYLE_RULES.map(rule => ({ ...rule }));
let suppressOptionsStorageReload = false;
let optionsStorageReloadTimer = null;
// False while bookmark rule rows are cleared/awaiting bookmarks.getTree().
// Prevents Save/Export from persisting an empty table as cleared rules.
let bookmarkRulesReady = false;
let previewStyleId = "";

function createDeleteButton(onClick) {
    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "rowDeleteBtn";
    deleteBtn.textContent = "×";
    deleteBtn.setAttribute("aria-label", "Delete");
    deleteBtn.title = "Delete";
    deleteBtn.addEventListener("click", onClick);
    return deleteBtn;
}

function createRowActions(...buttons) {
    const actions = document.createElement("div");
    actions.className = "rowActions";
    actions.append(...buttons);
    return actions;
}

function syncTableEmptyState(tbodySelector, emptySelector, { rowSelector = "tr", hideTable = true } = {}) {
    const tbody = document.querySelector(tbodySelector);
    const empty = document.querySelector(emptySelector);
    if (!tbody || !empty) return;

    const hasRows = tbody.querySelectorAll(rowSelector).length > 0;
    empty.hidden = hasRows;

    const table = tbody.closest("table");
    if (table && hideTable) {
        table.classList.toggle("is-empty", !hasRows);
    }
}

function refreshAllTableEmptyStates() {
    syncTableEmptyState("#styleRuleBody", "#styleRulesEmpty");
    syncTableEmptyState("#bookmarkRuleBody", "#bookmarkRulesEmpty", {
        rowSelector: "tr:not(.unmatchedBookmarkRule)",
        hideTable: false
    });
    syncTableEmptyState("#textRuleBody", "#textRulesEmpty");
    syncTableEmptyState("#tableBody", "#searchPairsEmpty");
    syncTableEmptyState("#urlRuleBody", "#urlRulesEmpty");
}

function createPreviewButton(onClick) {
    const previewBtn = document.createElement("button");
    previewBtn.type = "button";
    previewBtn.className = "rowPreviewBtn";
    previewBtn.setAttribute("aria-label", "Preview style");
    previewBtn.title = "Preview style";
    previewBtn.innerHTML =
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>' +
        '<circle cx="12" cy="12" r="3"></circle>' +
        "</svg>";
    previewBtn.addEventListener("click", onClick);
    return previewBtn;
}

function previewStyleFromRow(row) {
    const styleId = row?.dataset?.styleId;
    const name = row?.querySelector(".styleRuleName")?.value.trim();
    if (!styleId) return;

    if (!name) {
        showStatus("Enter a style name before previewing", true);
        return;
    }

    previewStyleId = styleId;
    updateStylePreview();
    document.querySelector("#stylePreviewRoot")?.scrollIntoView({
        behavior: "smooth",
        block: "nearest"
    });
}

function getDefaultPreviewStyleId(styleRules) {
    const rules = styleRules || [];
    return (
        rules.find(rule => rule.id === previewStyleId)?.id ||
        rules.find(rule => rule.id === "favorited")?.id ||
        rules.find(rule => !styleRuleHidesElements(rule))?.id ||
        rules[0]?.id ||
        ""
    );
}

function getAvailableStyleRules() {
    const fromDom = collectStyleRules();
    if (fromDom.length > 0) return fromDom;
    if (cachedStyleRules.length > 0) return cachedStyleRules;
    return DEFAULT_STYLE_RULES.map(rule => ({ ...rule }));
}

function populateStyleSelect(select, selectedId = "blocked", { includeNone = false } = {}) {
    const styleRules = getAvailableStyleRules();
    select.replaceChildren();

    let selectedExists = false;

    if (includeNone) {
        const noneOption = document.createElement("option");
        noneOption.value = "";
        noneOption.textContent = "None";
        if (!selectedId) {
            noneOption.selected = true;
            selectedExists = true;
        }
        select.appendChild(noneOption);
    }

    for (const rule of styleRules) {
        const option = document.createElement("option");
        option.value = rule.id;
        option.textContent = rule.name;
        if (rule.id === selectedId) {
            option.selected = true;
            selectedExists = true;
        }
        select.appendChild(option);
    }

    if (selectedId && !selectedExists) {
        const missingOption = document.createElement("option");
        missingOption.value = selectedId;
        missingOption.textContent = `Missing style (${selectedId})`;
        missingOption.selected = true;
        select.appendChild(missingOption);
    }

    if (!selectedExists && select.options.length > 0) {
        select.selectedIndex = 0;
    }
}

function refreshAllStyleSelects() {
    for (const select of document.querySelectorAll(
        ".bookmarkRuleStyle, .textRuleStyle"
    )) {
        const includeNone = select.dataset.includeNone === "true";
        populateStyleSelect(
            select,
            select.value || (includeNone ? "" : "blocked"),
            { includeNone }
        );
    }
    updateStylePreview();
}

function buildScopedStylePreviewCss(styleRules) {
    return (styleRules || []).map(rule => {
        const declarations = getStyleRuleDeclarations(rule).trim();
        if (!declarations) return "";
        const className = styleRuleClassName(rule);
        return `#stylePreviewRoot .${className} {\n\t${declarations}\n}`;
    }).filter(Boolean).join("\n\n");
}

function getStyleRulesForPreview() {
    const fromDom = normalizeStyleRules(collectStyleRules());
    if (fromDom.length > 0) return fromDom;
    if (cachedStyleRules.length > 0) return cachedStyleRules;
    return DEFAULT_STYLE_RULES.map(rule => ({ ...rule }));
}

function clearPreviewStyleClasses(element) {
    if (!element) return;
    for (const className of [...element.classList]) {
        if (className.startsWith("rule-be-")) {
            element.classList.remove(className);
        }
    }
}

function updateStylePreview() {
    const styleEl = document.querySelector("#stylePreviewCss");
    const link = document.querySelector("#stylePreviewLink");
    const card = document.querySelector("#stylePreviewCard");
    const hideNote = document.querySelector("#stylePreviewHideNote");
    const activeLabel = document.querySelector("#stylePreviewActiveLabel");
    if (!styleEl || !link || !card) return;

    const styleRules = getStyleRulesForPreview();
    styleEl.textContent = buildScopedStylePreviewCss(styleRules);

    clearPreviewStyleClasses(link);
    clearPreviewStyleClasses(card);

    previewStyleId = getDefaultPreviewStyleId(styleRules);
    const selectedRule = styleRules.find(rule => rule.id === previewStyleId);

    if (activeLabel) {
        activeLabel.textContent = selectedRule?.name
            ? `Showing: ${selectedRule.name}`
            : "";
    }

    if (selectedRule) {
        const className = styleRuleClassName(selectedRule);
        link.classList.add(className);
        card.classList.add(className);
    }

    if (hideNote) {
        hideNote.hidden = !(selectedRule && styleRuleHidesElements(selectedRule));
    }
}

function collectStyleRules() {
    return Array.from(document.querySelectorAll("#styleRuleBody tr")).map(row => {
        const nameInput = row.querySelector(".styleRuleName");
        const kindSelect = row.querySelector(".styleRuleKind");
        const cssInput = row.querySelector(".styleRuleCss");
        const kind = kindSelect?.value === "custom" ? "custom" : "predefined";
        const predefined = kind === "predefined" ? (kindSelect?.value || "blocked") : "";
        return {
            id: row.dataset.styleId || createStyleRuleId(),
            name: nameInput?.value.trim() || "",
            kind,
            predefined: predefined === "favorited" || predefined === "seen" ? predefined : (kind === "predefined" ? "blocked" : ""),
            css: cssInput?.value || ""
        };
    }).filter(rule => rule.name);
}

function clearStyleRuleTable() {
    document.querySelector("#styleRuleBody")?.replaceChildren();
    refreshAllTableEmptyStates();
}

function updateStyleRuleRowVisibility(row) {
    const kindSelect = row.querySelector(".styleRuleKind");
    const cssInput = row.querySelector(".styleRuleCss");
    if (!kindSelect || !cssInput) return;
    const isCustom = kindSelect.value === "custom";
    cssInput.hidden = !isCustom;
}

function createStyleRuleRow(rule = null) {
    const styleRule = rule || {
        id: createStyleRuleId(),
        name: "",
        kind: "predefined",
        predefined: "blocked",
        css: ""
    };

    const row = document.createElement("tr");
    row.dataset.styleId = styleRule.id;

    const nameCell = document.createElement("td");
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.className = "styleRuleName";
    nameInput.value = styleRule.name || "";
    nameInput.placeholder = "Style name";
    nameInput.addEventListener("input", refreshAllStyleSelects);
    nameCell.appendChild(nameInput);

    const kindCell = document.createElement("td");
    const kindSelect = document.createElement("select");
    kindSelect.className = "styleRuleKind";
    for (const [value, label] of [
        ["blocked", "Blocked (hide)"],
        ["favorited", "Favorited (double underline)"],
        ["seen", "Seen (dashed underline)"],
        ["custom", "Custom CSS"]
    ]) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = label;
        if (styleRule.kind === "custom") {
            option.selected = value === "custom";
        } else {
            option.selected = value === (styleRule.predefined || "blocked");
        }
        kindSelect.appendChild(option);
    }
    kindSelect.addEventListener("change", () => {
        updateStyleRuleRowVisibility(row);
        refreshAllStyleSelects();
    });
    kindCell.appendChild(kindSelect);

    const cssCell = document.createElement("td");
    const cssInput = document.createElement("textarea");
    cssInput.className = "styleRuleCss";
    cssInput.value = styleRule.css || "";
    cssInput.placeholder = "color: red;\noutline: 2px solid blue;";
    cssInput.setAttribute("aria-label", "Custom CSS declarations");
    cssInput.addEventListener("input", updateStylePreview);
    cssCell.appendChild(cssInput);

    const actionCell = document.createElement("td");
    actionCell.appendChild(createRowActions(
        createPreviewButton(() => previewStyleFromRow(row)),
        createDeleteButton(() => {
            const styleId = row.dataset.styleId;
            const styleName = nameInput.value.trim() || styleId || "this style";
            const references = findDomRulesReferencingStyle(styleId);
            if (references.length > 0) {
                const preview = references.slice(0, 5).join("\n- ");
                const more = references.length > 5
                    ? `\n- …and ${references.length - 5} more`
                    : "";
                const confirmed = window.confirm(
                    `"${styleName}" is still referenced by ${references.length} rule(s):\n- ${preview}${more}\n\nDelete it anyway?`
                );
                if (!confirmed) return;
            }
            row.remove();
            refreshAllStyleSelects();
            refreshAllTableEmptyStates();
        })
    ));

    row.append(nameCell, kindCell, cssCell, actionCell);
    document.querySelector("#styleRuleBody").appendChild(row);
    updateStyleRuleRowVisibility(row);
    refreshAllTableEmptyStates();
}

function loadStyleRuleRows(rules) {
    clearStyleRuleTable();
    cachedStyleRules = normalizeStyleRules(rules);
    if (cachedStyleRules.length === 0) {
        for (const rule of DEFAULT_STYLE_RULES) {
            createStyleRuleRow(rule);
        }
    } else {
        cachedStyleRules.forEach(rule => createStyleRuleRow(rule));
    }
    refreshAllStyleSelects();
    refreshAllTableEmptyStates();
}

function collectSearchPairs() {
    const rows = Array.from(document.querySelectorAll("#tableBody tr")).map(row => {
        const inputs = row.querySelectorAll("input");
        return {
            site: inputs[0].value,
            classes: inputs[1].value
        };
    });

    return mergeRowsBySite(rows, "classes", parseClassGroups, getClassGroupKey);
}

function collectUrlRules() {
    const rows = Array.from(document.querySelectorAll("#urlRuleBody tr")).map(row => {
        const inputs = row.querySelectorAll("input");
        return {
            site: inputs[0].value,
            keepParams: inputs[1].value
        };
    });

    return mergeRowsBySite(rows, "keepParams", parseCommaSeparatedValues);
}

function collectTextRules() {
    return Array.from(document.querySelectorAll("#textRuleBody tr")).map(row => {
        const siteInput = row.querySelector(".textRuleSite");
        const textInput = row.querySelector(".textRuleText");
        const styleSelect = row.querySelector(".textRuleStyle");
        return {
            site: siteInput?.value.trim() || "",
            text: textInput?.value.trim() || "",
            style: styleSelect?.value || "blocked"
        };
    }).filter(rule => rule.site && rule.text);
}

function replaceConfigurationRows(searchPairs, urlRules, textRules, bookmarkRules, styleRules) {
    clearSearchTable();
    clearUrlRuleTable();
    clearTextRuleTable();
    loadStyleRuleRows(styleRules);

    searchPairs.forEach(({ site, classes }) => createRow(site, classes));
    urlRules.forEach(({ site, keepParams }) => createUrlRuleRow(site, keepParams));
    if (textRules && textRules.length > 0) {
        textRules.forEach(rule => createTextRuleRow(rule.site, rule.text, rule.style));
    }
    refreshAllTableEmptyStates();
    // Bookmark rows are rebuilt by loadBookmarkRuleRows (keeps existing rows until then).
}

function flattenBookmarkFolders(nodes, path = "") {
    const folders = [];

    for (const node of nodes || []) {
        const isFolder = node.type === "folder" || (!node.url && Array.isArray(node.children));
        if (!isFolder) continue;

        const title = node.title || "Folder";
        const nextPath = path ? `${path} / ${title}` : title;
        const isRoot = node.id === "root________";

        if (!isRoot) {
            folders.push({ id: node.id, label: nextPath });
        }

        if (Array.isArray(node.children)) {
            folders.push(...flattenBookmarkFolders(
                node.children,
                isRoot ? "" : nextPath
            ));
        }
    }

    return folders;
}

function populateFolderSelect(select, folders, selectedId) {
    select.replaceChildren();

    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "Select a folder";
    select.appendChild(placeholder);

    let selectedExists = false;
    for (const folder of folders) {
        const option = document.createElement("option");
        option.value = folder.id;
        option.textContent = folder.label;
        option.dataset.folderLabel = folder.label.toLowerCase();
        if (folder.id === selectedId) {
            option.selected = true;
            selectedExists = true;
        }
        select.appendChild(option);
    }

    if (selectedId && !selectedExists) {
        const missingOption = document.createElement("option");
        missingOption.value = selectedId;
        missingOption.textContent = `Missing folder (${selectedId})`;
        missingOption.dataset.folderLabel = missingOption.textContent.toLowerCase();
        missingOption.selected = true;
        select.appendChild(missingOption);
    }

    applyFolderFilterToSelect(select);
}

function getFolderFilterQuery() {
    return (document.querySelector("#bookmarkFolderFilter")?.value || "")
        .trim()
        .toLowerCase();
}

function applyFolderFilterToSelect(select) {
    if (!select) return;
    const query = getFolderFilterQuery();
    const selectedValue = select.value;

    for (const option of select.options) {
        if (!option.value) {
            option.hidden = false;
            continue;
        }
        if (option.value === selectedValue) {
            option.hidden = false;
            continue;
        }
        const label = option.dataset.folderLabel || option.textContent.toLowerCase();
        option.hidden = query !== "" && !label.includes(query);
    }
}

function applyFolderFilterToAllSelects() {
    for (const select of document.querySelectorAll(".bookmarkRuleFolder")) {
        applyFolderFilterToSelect(select);
    }
}

function createBookmarkRuleRow(folderId = "", style = "blocked") {
    const row = document.createElement("tr");

    const folderCell = document.createElement("td");
    const folderSelect = document.createElement("select");
    folderSelect.className = "bookmarkRuleFolder";
    populateFolderSelect(folderSelect, cachedBookmarkFolders, folderId || "");
    folderCell.appendChild(folderSelect);

    const styleCell = document.createElement("td");
    const styleSelect = document.createElement("select");
    styleSelect.className = "bookmarkRuleStyle";
    populateStyleSelect(styleSelect, style || "blocked");
    styleCell.appendChild(styleSelect);

    const actionCell = document.createElement("td");
    actionCell.appendChild(createRowActions(
        createDeleteButton(() => {
            row.remove();
            refreshAllTableEmptyStates();
        })
    ));

    row.append(folderCell, styleCell, actionCell);

    const body = document.querySelector("#bookmarkRuleBody");
    const unmatchedRow = body?.querySelector("tr.unmatchedBookmarkRule");
    if (unmatchedRow) {
        body.insertBefore(row, unmatchedRow);
    } else {
        body.appendChild(row);
    }
    refreshAllTableEmptyStates();
}

function createUnmatchedBookmarkRuleRow(style = "") {
    const body = document.querySelector("#bookmarkRuleBody");
    const existing = body?.querySelector("tr.unmatchedBookmarkRule");
    if (existing) existing.remove();

    const row = document.createElement("tr");
    row.className = "unmatchedBookmarkRule";
    row.dataset.folderId = UNMATCHED_BOOKMARK_RULE_ID;

    const folderCell = document.createElement("td");
    const label = document.createElement("span");
    label.textContent = "Bookmarks outside rule folders";
    label.className = "unmatchedBookmarkLabel";
    folderCell.appendChild(label);

    const styleCell = document.createElement("td");
    const styleSelect = document.createElement("select");
    styleSelect.className = "bookmarkRuleStyle";
    styleSelect.dataset.includeNone = "true";
    populateStyleSelect(styleSelect, style || "", { includeNone: true });
    styleCell.appendChild(styleSelect);

    const actionCell = document.createElement("td");
    const note = document.createElement("span");
    note.textContent = "Always applied last";
    note.className = "hint";
    actionCell.appendChild(note);

    row.append(folderCell, styleCell, actionCell);
    body.appendChild(row);
    refreshAllTableEmptyStates();
}

function collectBookmarkRules() {
    const rules = [];

    for (const row of document.querySelectorAll("#bookmarkRuleBody tr")) {
        if (row.classList.contains("unmatchedBookmarkRule")) {
            const styleSelect = row.querySelector(".bookmarkRuleStyle");
            rules.push({
                folderId: UNMATCHED_BOOKMARK_RULE_ID,
                style: styleSelect?.value || ""
            });
            continue;
        }

        const folderSelect = row.querySelector(".bookmarkRuleFolder");
        const styleSelect = row.querySelector(".bookmarkRuleStyle");
        const folderId = folderSelect?.value || "";
        if (!folderId) continue;
        rules.push({
            folderId,
            style: styleSelect?.value || "blocked"
        });
    }

    return rules;
}

function renderBookmarkRuleRows(rules) {
    clearBookmarkRuleTable();
    const normalizedRules = normalizeBookmarkRules(rules);
    const folderRules = normalizedRules.filter(rule => !isUnmatchedBookmarkRule(rule));
    const unmatchedRule = normalizedRules.find(isUnmatchedBookmarkRule);
    const unmatchedStyle = unmatchedRule
        ? unmatchedRule.style
        : migrateUnmatchedBookmarkStyle({ bookmarkRules: rules });

    folderRules.forEach(rule => createBookmarkRuleRow(rule.folderId, rule.style));
    createUnmatchedBookmarkRuleRow(unmatchedStyle || "");
    refreshAllTableEmptyStates();
}

function refreshBookmarkFolderSelectOptions() {
    for (const select of document.querySelectorAll(".bookmarkRuleFolder")) {
        populateFolderSelect(select, cachedBookmarkFolders, select.value || "");
    }
}

function setBookmarkRulesReady(ready) {
    bookmarkRulesReady = ready;
    // Keep Save/Export disabled until rows exist; Import may still run once busy ends.
    const saveBtn = document.querySelector("#saveBtn");
    const exportBtn = document.querySelector("#exportBtn");
    if (!actionBarBusy) {
        if (saveBtn) saveBtn.disabled = !ready;
        if (exportBtn) exportBtn.disabled = !ready;
    }
}

function loadBookmarkRuleRows(rules) {
    // Rebuild immediately from cache so saves don't flash an empty table while
    // waiting on bookmarks.getTree().
    if (cachedBookmarkFolders.length > 0) {
        renderBookmarkRuleRows(rules);
        setBookmarkRulesReady(true);
        return browser.bookmarks.getTree().then(tree => {
            cachedBookmarkFolders = flattenBookmarkFolders(tree);
            refreshBookmarkFolderSelectOptions();
        }).catch(err => {
            console.error("Could not refresh bookmark folders:", err);
        });
    }

    setBookmarkRulesReady(false);
    return browser.bookmarks.getTree().then(tree => {
        cachedBookmarkFolders = flattenBookmarkFolders(tree);
        renderBookmarkRuleRows(rules);
        setBookmarkRulesReady(true);
    }).catch(err => {
        console.error("Could not load bookmark folders:", err);
        // Still render stored rules (folder selects show "Missing folder") so a
        // later Save cannot overwrite storage with an empty table.
        renderBookmarkRuleRows(rules);
        setBookmarkRulesReady(true);
        showStatus("Could not load bookmark folders", true);
    });
}

function clearBookmarkRuleTable() {
    document.querySelector("#bookmarkRuleBody")?.replaceChildren();
    refreshAllTableEmptyStates();
}

function findDomRulesReferencingStyle(styleId) {
    if (!styleId) return [];

    const references = [];
    for (const row of document.querySelectorAll("#textRuleBody tr")) {
        const styleSelect = row.querySelector(".textRuleStyle");
        if (styleSelect?.value !== styleId) continue;
        const text = row.querySelector(".textRuleText")?.value.trim() || "(text)";
        const site = row.querySelector(".textRuleSite")?.value.trim() || "(site)";
        references.push(`Text rule "${text}" on ${site}`);
    }

    for (const row of document.querySelectorAll("#bookmarkRuleBody tr")) {
        const styleSelect = row.querySelector(".bookmarkRuleStyle");
        if (styleSelect?.value !== styleId) continue;
        if (row.classList.contains("unmatchedBookmarkRule")) {
            references.push("Bookmarks outside rule folders");
            continue;
        }
        const folderSelect = row.querySelector(".bookmarkRuleFolder");
        const label = folderSelect?.selectedOptions?.[0]?.textContent ||
            folderSelect?.value ||
            "Bookmark folder";
        references.push(`Bookmark rule: ${label}`);
    }

    return references;
}

function findDanglingStyleReferences(styleRules, textRules, bookmarkRules) {
    const styleIds = new Set(
        (styleRules || []).map(rule => rule.id).filter(Boolean)
    );
    const dangling = [];

    for (const rule of textRules || []) {
        if (!rule?.style || styleIds.has(rule.style)) continue;
        dangling.push(
            `Text rule "${rule.text}" on ${rule.site || "(site)"} uses missing style "${rule.style}"`
        );
    }

    for (const rule of bookmarkRules || []) {
        if (!rule?.style || styleIds.has(rule.style)) continue;
        const label = isUnmatchedBookmarkRule(rule)
            ? "Bookmarks outside rule folders"
            : `Bookmark folder ${rule.folderId}`;
        dangling.push(`${label} uses missing style "${rule.style}"`);
    }

    return dangling;
}

function formatIssueList(issues, limit = 5) {
    const preview = issues.slice(0, limit).join("\n- ");
    const more = issues.length > limit
        ? `\n- …and ${issues.length - limit} more`
        : "";
    return `- ${preview}${more}`;
}

function buildOptionsPayload() {
    const styleRules = normalizeStyleRules(collectStyleRules());
    cachedStyleRules = styleRules;
    const searchPairs = collectSearchPairs();
    const urlRules = collectUrlRules();
    const textRules = normalizeTextRules(collectTextRules());
    const bookmarkRules = normalizeBookmarkRules(collectBookmarkRules());

    return {
        styleRules,
        searchPairs,
        urlRules,
        textRules,
        bookmarkRules,
        payload: {
            enableTopBorder: document.querySelector("#enableTopBorder").checked,
            enableDeepSearch: document.querySelector("#enableDeepSearch").checked,
            onlyUseSites: document.querySelector("#onlyUseSites").checked,
            [STYLE_RULE_STORAGE_KEY]: styleRules,
            searchPairs,
            urlRules,
            textRules,
            [BOOKMARK_RULE_STORAGE_KEY]: bookmarkRules
        }
    };
}

let actionBarBusy = false;
let actionBarBusyButton = null;

function getActionBarButtons() {
    return [
        document.querySelector("#exportBtn"),
        document.querySelector("#importBtn"),
        document.querySelector("#saveBtn")
    ].filter(Boolean);
}

function beginActionBarBusy(activeButton, busyLabel) {
    if (actionBarBusy) return;
    actionBarBusy = true;
    actionBarBusyButton = activeButton || null;

    for (const button of getActionBarButtons()) {
        button.disabled = true;
        button.setAttribute("aria-busy", "true");
    }

    if (actionBarBusyButton) {
        if (!actionBarBusyButton.dataset.idleLabel) {
            actionBarBusyButton.dataset.idleLabel = actionBarBusyButton.textContent;
        }
        actionBarBusyButton.textContent = busyLabel;
        actionBarBusyButton.classList.add("is-loading");
    }
}

function endActionBarBusy() {
    if (!actionBarBusy) return;
    actionBarBusy = false;

    for (const button of getActionBarButtons()) {
        button.disabled = false;
        button.removeAttribute("aria-busy");
        button.classList.remove("is-loading");
        if (button.dataset.idleLabel) {
            button.textContent = button.dataset.idleLabel;
            delete button.dataset.idleLabel;
        }
    }

    actionBarBusyButton = null;
    // Re-apply hydration gate after busy ends (Save/Export stay off until ready).
    setBookmarkRulesReady(bookmarkRulesReady);
}

function persistOptionsFromForm({
    successMessage = "Options saved",
    setBusy = true,
    busyLabel = "Saving…",
    busyButton = null
} = {}) {
    if (!bookmarkRulesReady) {
        showStatus("Bookmark rules are still loading — try saving again", true);
        return Promise.resolve();
    }

    if (!validateAllSearchPairRows()) {
        activateOptionsTab("siteRules");
        const firstInvalid = document.querySelector(
            "#tableBody input.fieldInvalid"
        );
        firstInvalid?.focus();
        showStatus("Fix Search Pair errors before saving", true);
        return Promise.resolve();
    }

    const {
        styleRules,
        searchPairs,
        urlRules,
        textRules,
        bookmarkRules,
        payload
    } = buildOptionsPayload();

    const dangling = findDanglingStyleReferences(
        styleRules,
        textRules,
        bookmarkRules
    );
    const collisions = findStyleRuleClassNameCollisions(styleRules);

    if (dangling.length > 0) {
        const confirmed = window.confirm(
            `${dangling.length} rule(s) reference missing styles:\n${formatIssueList(dangling)}\n\nSave anyway?`
        );
        if (!confirmed) {
            showStatus("Save cancelled: missing style references", true);
            return Promise.resolve();
        }
    }

    if (collisions.length > 0) {
        const collisionMessages = collisions.map(collision =>
            `${collision.className} ← ${collision.names.join(", ")}`
        );
        const confirmed = window.confirm(
            `${collisions.length} style class name collision(s):\n${formatIssueList(collisionMessages)}\n\nThese styles would override each other. Save anyway?`
        );
        if (!confirmed) {
            showStatus("Save cancelled: style class name collisions", true);
            return Promise.resolve();
        }
    }

    if (setBusy) {
        beginActionBarBusy(
            busyButton || document.querySelector("#saveBtn"),
            busyLabel
        );
    }

    suppressOptionsStorageReload = true;
    return browser.storage.local.set(payload)
        .then(() => browser.storage.local.remove(Object.values(LEGACY_STORAGE_KEYS)))
        .then(() => {
            replaceConfigurationRows(
                searchPairs,
                urlRules,
                textRules,
                bookmarkRules,
                styleRules
            );
            return loadBookmarkRuleRows(bookmarkRules);
        })
        .then(() => {
            suppressOptionsStorageReload = false;
            const warnings = [];
            if (dangling.length > 0) {
                warnings.push(`${dangling.length} missing style reference(s)`);
            }
            if (collisions.length > 0) {
                warnings.push(`${collisions.length} class name collision(s)`);
            }
            if (warnings.length > 0) {
                showStatus(`${successMessage} (with warnings: ${warnings.join("; ")})`, true);
            } else {
                showStatus(successMessage);
            }
        })
        .catch(error => {
            suppressOptionsStorageReload = false;
            throw error;
        })
        .finally(() => {
            if (setBusy) {
                endActionBarBusy();
            }
        });
}

function saveOptions(e) {
    e.preventDefault();
    if (actionBarBusy) return;
    persistOptionsFromForm({
        successMessage: "Options saved",
        busyLabel: "Saving…",
        busyButton: document.querySelector("#saveBtn")
    }).catch(err => {
        console.error("Save failed:", err);
        showStatus("Could not save options", true);
    });
}

let searchPairFieldIdSeq = 0;

function createRow(site = "", classes = "") {
    const row = document.createElement("tr");
    row.className = "searchPairRow";

    const idSuffix = `sp-${++searchPairFieldIdSeq}`;

    const siteCell = document.createElement("td");
    const siteInput = document.createElement("input");
    siteInput.type = "text";
    siteInput.className = "searchPairSite";
    siteInput.value = site;
    siteInput.placeholder = "example.com";
    siteInput.setAttribute("aria-label", "Site");
    siteInput.setAttribute("aria-describedby", `${idSuffix}-site-error`);
    siteInput.autocomplete = "off";

    const siteError = document.createElement("p");
    siteError.className = "fieldError";
    siteError.id = `${idSuffix}-site-error`;
    siteError.hidden = true;

    siteCell.append(siteInput, siteError);

    const classesCell = document.createElement("td");
    const classesInput = document.createElement("input");
    classesInput.type = "text";
    classesInput.className = "searchPairClasses";
    classesInput.value = classes;
    classesInput.placeholder = "card-class, other-class";
    classesInput.setAttribute("aria-label", "Classes");
    classesInput.setAttribute("aria-describedby", `${idSuffix}-classes-error`);
    classesInput.autocomplete = "off";

    const classesError = document.createElement("p");
    classesError.className = "fieldError";
    classesError.id = `${idSuffix}-classes-error`;
    classesError.hidden = true;

    classesCell.append(classesInput, classesError);

    const actionCell = document.createElement("td");
    actionCell.appendChild(createRowActions(
        createDeleteButton(() => {
            row.remove();
            validateAllSearchPairRows();
            refreshAllTableEmptyStates();
        })
    ));

    const scheduleValidate = () => {
        validateAllSearchPairRows();
    };
    siteInput.addEventListener("input", scheduleValidate);
    siteInput.addEventListener("blur", scheduleValidate);
    classesInput.addEventListener("input", scheduleValidate);
    classesInput.addEventListener("blur", scheduleValidate);

    row.append(siteCell, classesCell, actionCell);
    document.querySelector("#tableBody").appendChild(row);
    validateAllSearchPairRows();
    refreshAllTableEmptyStates();
}

function setSearchPairFieldError(input, errorEl, message) {
    if (!input || !errorEl) return;

    const invalid = Boolean(message);
    input.classList.toggle("fieldInvalid", invalid);
    input.setAttribute("aria-invalid", invalid ? "true" : "false");
    if (invalid) {
        errorEl.textContent = message;
        errorEl.hidden = false;
    } else {
        errorEl.textContent = "";
        errorEl.hidden = true;
    }
}

function getSearchPairRowState(row) {
    const siteInput = row.querySelector(".searchPairSite");
    const classesInput = row.querySelector(".searchPairClasses");
    const siteRaw = siteInput?.value.trim() || "";
    const classesRaw = classesInput?.value.trim() || "";
    const classGroups = parseClassGroups(classesRaw);
    const normalizedSite = siteRaw ? normalizeSite(siteRaw) : "";

    return {
        row,
        siteInput,
        classesInput,
        siteError: siteInput?.parentElement?.querySelector(".fieldError"),
        classesError: classesInput?.parentElement?.querySelector(".fieldError"),
        siteRaw,
        classesRaw,
        classGroups,
        normalizedSite,
        isBlank: !siteRaw && !classesRaw
    };
}

/**
 * Inline validation for Search Pairs: invalid host, empty classes/site,
 * and duplicate site+class-group pairs. Returns false when any row is invalid.
 */
function validateAllSearchPairRows() {
    const rows = Array.from(document.querySelectorAll("#tableBody tr"))
        .map(getSearchPairRowState)
        .filter(state => state.siteInput && state.classesInput);

    const seenKeys = new Map(); // key -> first row index
    let allValid = true;

    for (let index = 0; index < rows.length; index++) {
        const state = rows[index];
        let siteMessage = "";
        let classesMessage = "";

        if (state.isBlank) {
            setSearchPairFieldError(state.siteInput, state.siteError, "");
            setSearchPairFieldError(state.classesInput, state.classesError, "");
            continue;
        }

        if (!state.siteRaw) {
            siteMessage = "Enter a site hostname.";
        } else if (!isPlausibleHostname(state.siteRaw)) {
            siteMessage = "Enter a valid hostname (example.com).";
        }

        if (!state.classesRaw || state.classGroups.length === 0) {
            classesMessage = "Enter at least one CSS class group.";
        }

        if (!siteMessage && !classesMessage && state.normalizedSite) {
            const duplicateGroups = [];
            for (const group of state.classGroups) {
                const key = `${state.normalizedSite}\u0000${getClassGroupKey(group)}`;
                if (seenKeys.has(key)) {
                    duplicateGroups.push(group);
                } else {
                    seenKeys.set(key, index);
                }
            }
            if (duplicateGroups.length > 0) {
                classesMessage = duplicateGroups.length === 1
                    ? `Duplicate of class group "${duplicateGroups[0]}" for this site.`
                    : `Duplicate of class groups: ${duplicateGroups.map(g => `"${g}"`).join(", ")}.`;
            }
        }

        setSearchPairFieldError(state.siteInput, state.siteError, siteMessage);
        setSearchPairFieldError(state.classesInput, state.classesError, classesMessage);

        if (siteMessage || classesMessage) {
            allValid = false;
        }
    }

    return allValid;
}

function createUrlRuleRow(site = "", keepParams = "") {
    const row = document.createElement("tr");

    const siteCell = document.createElement("td");
    const siteInput = document.createElement("input");
    siteInput.type = "text";
    siteInput.value = site;
    siteCell.appendChild(siteInput);

    const paramsCell = document.createElement("td");
    const paramsInput = document.createElement("input");
    paramsInput.type = "text";
    paramsInput.value = keepParams;
    paramsCell.appendChild(paramsInput);

    const actionCell = document.createElement("td");
    actionCell.appendChild(createRowActions(
        createDeleteButton(() => {
            row.remove();
            refreshAllTableEmptyStates();
        })
    ));

    row.appendChild(siteCell);
    row.appendChild(paramsCell);
    row.appendChild(actionCell);

    document.querySelector("#urlRuleBody").appendChild(row);
    refreshAllTableEmptyStates();
}

function createTextRuleRow(site = "", text = "", style = "blocked") {
    const row = document.createElement("tr");

    const siteCell = document.createElement("td");
    const siteInput = document.createElement("input");
    siteInput.type = "text";
    siteInput.className = "textRuleSite";
    siteInput.value = site;
    siteCell.appendChild(siteInput);

    const textCell = document.createElement("td");
    const textInput = document.createElement("input");
    textInput.type = "text";
    textInput.className = "textRuleText";
    textInput.value = text;
    textCell.appendChild(textInput);

    const styleCell = document.createElement("td");
    const styleSelect = document.createElement("select");
    styleSelect.className = "textRuleStyle";
    populateStyleSelect(styleSelect, style || "blocked");
    styleCell.appendChild(styleSelect);

    const actionCell = document.createElement("td");
    actionCell.appendChild(createRowActions(
        createDeleteButton(() => {
            row.remove();
            refreshAllTableEmptyStates();
        })
    ));

    row.append(siteCell, textCell, styleCell, actionCell);
    document.querySelector("#textRuleBody").appendChild(row);
    refreshAllTableEmptyStates();
}

function restoreOptions() {
    suppressOptionsStorageReload = true;
    // Do not clear bookmark rows here — keep the previous table until
    // loadBookmarkRuleRows/renderBookmarkRuleRows replaces it, so a mid-restore
    // Save cannot persist an empty bookmarkRules array.
    setBookmarkRulesReady(false);

    function handleStorage(result) {
        clearSearchTable();
        clearUrlRuleTable();
        clearTextRuleTable();
        clearStyleRuleTable();

        document.querySelector("#enableTopBorder").checked =
            !!result.enableTopBorder;

        document.querySelector("#enableDeepSearch").checked =
            !!result.enableDeepSearch;

        document.querySelector("#onlyUseSites").checked =
            !!result.onlyUseSites;

        loadStyleRuleRows(migrateStyleRulesFromStorage(result));

        if (result.searchPairs) {
            result.searchPairs.forEach(pair => {
                const classes = typeof pair.classes === "string"
                    ? pair.classes
                    : pair.tag;
                createRow(pair.site, classes);
            });
        }


        if (result.urlRules) {
            result.urlRules.forEach(
                ({ site, keepParams }) =>
                    createUrlRuleRow(site, keepParams)
            );
        }

        if (result[LEGACY_STORAGE_KEYS.textFilters] || result.textRules) {
            const textRules = migrateTextRulesFromStorage(result);
            textRules.forEach(rule => createTextRuleRow(
                rule.site,
                rule.text,
                rule.style
            ));
        }

        return loadBookmarkRuleRows(migrateBookmarkRulesFromStorage(result))
            .then(() => purgeLegacyStorage(result))
            .then(() => refreshAllTableEmptyStates());
    }


    return browser.storage.local.get([
        STORAGE_KEYS.searchPairs,
        STORAGE_KEYS.urlRules,
        STORAGE_KEYS.textRules,
        LEGACY_STORAGE_KEYS.textFilters,
        STORAGE_KEYS.styleRules,
        STORAGE_KEYS.enableTopBorder,
        STORAGE_KEYS.enableDeepSearch,
        STORAGE_KEYS.onlyUseSites,
        LEGACY_STORAGE_KEYS.enableSeenStyling,
        STORAGE_KEYS.bookmarkRules,
        LEGACY_STORAGE_KEYS.blockedFolderId,
        LEGACY_STORAGE_KEYS.favoritedFolderId
    ])
    .then(handleStorage)
    .catch(error => {
        console.error(error);
    })
    .finally(() => {
        suppressOptionsStorageReload = false;
    });
}

function scheduleOptionsStorageReload() {
    if (suppressOptionsStorageReload) return;
    if (optionsStorageReloadTimer) {
        clearTimeout(optionsStorageReloadTimer);
    }
    optionsStorageReloadTimer = setTimeout(() => {
        optionsStorageReloadTimer = null;
        if (suppressOptionsStorageReload) return;
        restoreOptions().then(() => {
            showStatus("Options updated from another change");
        });
    }, 150);
}

function initSaveLoadEvents() {
    setBookmarkRulesReady(false);
    restoreOptions();
    document.querySelector("form").addEventListener("submit", saveOptions);

    browser.storage.onChanged.addListener((changes, areaName) => {
        if (areaName !== "local") return;
        const relevant = Object.keys(changes).some(key =>
            CONFIG_REFRESH_STORAGE_KEYS.includes(key) ||
            Object.values(LEGACY_STORAGE_KEYS).includes(key)
        );
        if (relevant) {
            scheduleOptionsStorageReload();
        }
    });

    document.querySelector("#bookmarkFolderFilter")?.addEventListener("input", () => {
        applyFolderFilterToAllSelects();
    });
}
function buildExportPayload() {
    return {
        searchPairs: collectSearchPairs(),
        urlRules: collectUrlRules(),
        textRules: normalizeTextRules(collectTextRules()),
        styleRules: normalizeStyleRules(collectStyleRules()),
        enableTopBorder: document.querySelector("#enableTopBorder").checked,
        onlyUseSites: document.querySelector("#onlyUseSites").checked,
        enableDeepSearch: document.querySelector("#enableDeepSearch").checked,
        bookmarkRules: normalizeBookmarkRules(collectBookmarkRules())
    };
}

function exportConfigurationFilename() {
    const date = new Date().toISOString().slice(0, 10);
    return `bookmarks-enhancer-config-${date}.json`;
}

function exportToFile() {
    if (actionBarBusy) return;
    if (!bookmarkRulesReady) {
        showStatus("Bookmark rules are still loading — try exporting again", true);
        return;
    }

    beginActionBarBusy(document.querySelector("#exportBtn"), "Exporting…");

    try {
        const json = JSON.stringify(buildExportPayload(), null, 2);
        const blob = new Blob([json], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = exportConfigurationFilename();
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        URL.revokeObjectURL(url);
        showStatus("Exported configuration");
    } catch (err) {
        console.error(err);
        showStatus("Could not export", true);
    } finally {
        endActionBarBusy();
    }
}

function importFromJson(jsonString) {
    let data;

    try {
        data = JSON.parse(jsonString);

        if (
            !data ||
            typeof data !== "object" ||
            Array.isArray(data)
        ) {
            throw new Error("Invalid format");
        }

        if (
            data.searchPairs &&
            !data.searchPairs.every(isValidSearchPair)
        ) {
            throw new Error("Invalid searchPairs");
        }

        if (
            data.urlRules &&
            !data.urlRules.every(isValidUrlRule)
        ) {
            throw new Error("Invalid urlRules");
        }

        if (
            data.styleRules !== undefined &&
            (
                !Array.isArray(data.styleRules) ||
                !data.styleRules.every(isValidStyleRule)
            )
        ) {
            throw new Error("Invalid styleRules");
        }

        if (
            data.textRules !== undefined &&
            (
                !Array.isArray(data.textRules) ||
                !data.textRules.every(isValidTextRule)
            )
        ) {
            throw new Error("Invalid textRules");
        }

        if (
            data.textFilters &&
            !data.textFilters.every(isValidLegacyTextFilter)
        ) {
            throw new Error("Invalid textFilters");
        }

        if (
            data.enableDeepSearch !== undefined &&
            typeof data.enableDeepSearch !== "boolean"
        ) {
            throw new Error("Invalid enableDeepSearch");
        }

        if (
            data.enableTopBorder !== undefined &&
            typeof data.enableTopBorder !== "boolean"
        ) {
            throw new Error("Invalid enableTopBorder");
        }

        if (
            data.onlyUseSites !== undefined &&
            typeof data.onlyUseSites !== "boolean"
        ) {
            throw new Error("Invalid onlyUseSites");
        }

        if (
            data.enableSeenStyling !== undefined &&
            typeof data.enableSeenStyling !== "boolean"
        ) {
            throw new Error("Invalid enableSeenStyling");
        }

        if (
            data.bookmarkRules !== undefined &&
            (
                !Array.isArray(data.bookmarkRules) ||
                !data.bookmarkRules.every(isValidBookmarkRule)
            )
        ) {
            throw new Error("Invalid bookmarkRules");
        }

        if (
            data.blockedFolderId !== undefined &&
            data.blockedFolderId !== null &&
            typeof data.blockedFolderId !== "string"
        ) {
            throw new Error("Invalid blockedFolderId");
        }

        if (
            data.favoritedFolderId !== undefined &&
            data.favoritedFolderId !== null &&
            typeof data.favoritedFolderId !== "string"
        ) {
            throw new Error("Invalid favoritedFolderId");
        }
    }
    catch (err) {
        console.error(err);
        showStatus("Import failed", true);
        return Promise.resolve();
    }

    clearSearchTable();
    clearUrlRuleTable();
    clearTextRuleTable();
    loadStyleRuleRows(migrateStyleRulesFromStorage(data));

    (data.searchPairs || []).forEach(pair => {
        const classes = typeof pair.classes === "string"
            ? pair.classes
            : pair.tag;
        createRow(pair.site, classes);
    });

    (data.urlRules || []).forEach(
        ({ site, keepParams }) =>
            createUrlRuleRow(site, keepParams)
    );

    const importedTextRules = migrateTextRulesFromStorage(data);
    importedTextRules.forEach(rule => createTextRuleRow(
        rule.site,
        rule.text,
        rule.style
    ));

    if (data.enableDeepSearch !== undefined) {
        document.querySelector("#enableDeepSearch").checked =
            data.enableDeepSearch;
    }

    if (data.enableTopBorder !== undefined) {
        document.querySelector("#enableTopBorder").checked =
            data.enableTopBorder;
    }

    if (data.onlyUseSites !== undefined) {
        document.querySelector("#onlyUseSites").checked =
            data.onlyUseSites;
    }

    return loadBookmarkRuleRows(migrateBookmarkRulesFromStorage(data)).then(() => {
        return persistOptionsFromForm({
            successMessage: "Imported and saved configuration",
            setBusy: false
        });
    }).catch(err => {
        console.error("Import failed:", err);
        showStatus("Import loaded into form but could not save", true);
    });
}

function isValidSearchPair(row) {
    return row &&
        typeof row.site === "string" &&
        (
            typeof row.classes === "string" ||
            typeof row.tag === "string"
        );
}

function isValidUrlRule(row) {
    return row &&
        typeof row.site === "string" &&
        typeof row.keepParams === "string";
}

function isValidLegacyTextFilter(row) {
    return row &&
        typeof row.site === "string" &&
        typeof row.filterText === "string";
}

function importFromFile() {
    if (actionBarBusy) return;

    const input = document.querySelector("#importFileInput");
    if (!input) {
        showStatus("Could not open file picker", true);
        return;
    }

    input.value = "";
    input.click();
}

function handleImportFileChange(event) {
    const file = event.target?.files?.[0];
    if (!file) return;
    if (actionBarBusy) return;

    beginActionBarBusy(document.querySelector("#importBtn"), "Importing…");
    file.text()
        .then(text => importFromJson(text))
        .catch(err => {
            console.error("File read failed:", err);
            showStatus("Could not read import file", true);
        })
        .finally(() => {
            endActionBarBusy();
            event.target.value = "";
        });
}
function clearSearchTable() {
    document.querySelector("#tableBody").replaceChildren();
    refreshAllTableEmptyStates();
}

function clearUrlRuleTable() {
    document.querySelector("#urlRuleBody").replaceChildren();
    refreshAllTableEmptyStates();
}

function clearTextRuleTable() {
    document.querySelector("#textRuleBody")?.replaceChildren();
    refreshAllTableEmptyStates();
}

let statusTimeout = null;
function showStatus(message, isError = false) {
    const toast = document.querySelector("#statusToast");
    if (!toast) return;

    toast.textContent = message;
    toast.classList.toggle("error", isError);
    toast.classList.add("visible");

    clearTimeout(statusTimeout);
    statusTimeout = setTimeout(() => {
        toast.classList.remove("visible");
    }, isError ? 6000 : 3000);
}

function activateOptionsTab(tabId) {
    const tabs = Array.from(document.querySelectorAll('[role="tab"][data-tab]'));
    const panels = Array.from(document.querySelectorAll("[data-tab-panel]"));

    for (const tab of tabs) {
        const selected = tab.dataset.tab === tabId;
        tab.setAttribute("aria-selected", selected ? "true" : "false");
        tab.tabIndex = selected ? 0 : -1;
    }

    for (const panel of panels) {
        const selected = panel.dataset.tabPanel === tabId;
        panel.classList.toggle("active", selected);
        panel.hidden = !selected;
    }

    if (tabId === "bookmarkRules" || tabId === "textRules" || tabId === "styleRules") {
        refreshAllStyleSelects();
    }
}

function setupOptionsTabs() {
    const tabs = Array.from(document.querySelectorAll('[role="tab"][data-tab]'));
    if (tabs.length === 0) return;

    for (const tab of tabs) {
        tab.addEventListener("click", () => {
            activateOptionsTab(tab.dataset.tab);
        });

        tab.addEventListener("keydown", event => {
            const currentIndex = tabs.indexOf(tab);
            let nextIndex = currentIndex;

            if (event.key === "ArrowRight" || event.key === "ArrowDown") {
                nextIndex = (currentIndex + 1) % tabs.length;
            } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
                nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
            } else if (event.key === "Home") {
                nextIndex = 0;
            } else if (event.key === "End") {
                nextIndex = tabs.length - 1;
            } else {
                return;
            }

            event.preventDefault();
            const nextTab = tabs[nextIndex];
            activateOptionsTab(nextTab.dataset.tab);
            nextTab.focus();
        });
    }

    const initiallySelected =
        tabs.find(tab => tab.getAttribute("aria-selected") === "true") || tabs[0];
    activateOptionsTab(initiallySelected.dataset.tab);
}

function setupEventListeners() {
    try {
        setupOptionsTabs();

        const addRowBtn = document.querySelector("#addRowBtn");
        const exportBtn = document.querySelector("#exportBtn");
        const importBtn = document.querySelector("#importBtn");
        const addUrlRuleBtn = document.querySelector("#addUrlRuleBtn");
        const addTextRuleBtn = document.querySelector("#addTextRuleBtn");
        const addBookmarkRuleBtn = document.querySelector("#addBookmarkRuleBtn");
        const addStyleRuleBtn = document.querySelector("#addStyleRuleBtn");

        if (!addRowBtn) console.warn("addRowBtn not found");
        if (!exportBtn) console.warn("exportBtn not found");
        if (!importBtn) console.warn("importBtn not found");
        if (!addUrlRuleBtn) console.warn("addUrlRuleBtn not found");
        if (!addTextRuleBtn) console.warn("addTextRuleBtn not found");
        if (!addBookmarkRuleBtn) console.warn("addBookmarkRuleBtn not found");
        if (!addStyleRuleBtn) console.warn("addStyleRuleBtn not found");

        if (addRowBtn) addRowBtn.addEventListener("click", () => createRow());
        if (exportBtn) exportBtn.addEventListener("click", exportToFile);
        if (importBtn) importBtn.addEventListener("click", importFromFile);
        const importFileInput = document.querySelector("#importFileInput");
        if (importFileInput) {
            importFileInput.addEventListener("change", handleImportFileChange);
        }
        if (addUrlRuleBtn) addUrlRuleBtn.addEventListener("click", () => createUrlRuleRow());
        if (addTextRuleBtn) addTextRuleBtn.addEventListener("click", () => createTextRuleRow());
        if (addBookmarkRuleBtn) {
            addBookmarkRuleBtn.addEventListener("click", () => createBookmarkRuleRow());
        }
        if (addStyleRuleBtn) {
            addStyleRuleBtn.addEventListener("click", () => {
                createStyleRuleRow();
                refreshAllStyleSelects();
            });
        }

        const stylePreviewLink = document.querySelector("#stylePreviewLink");
        if (stylePreviewLink) {
            stylePreviewLink.addEventListener("click", event => {
                event.preventDefault();
            });
        }

        console.log("Event listeners attached successfully");
    } catch (err) {
        console.error("Error setting up event listeners:", err);
    }
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
        try {
            initSaveLoadEvents();
        } catch (err) {
            console.error("Error in initSaveLoadEvents:", err);
        }
        setupEventListeners();
    });
} else {
    try {
        initSaveLoadEvents();
    } catch (err) {
        console.error("Error in initSaveLoadEvents:", err);
    }
    setupEventListeners();
}
