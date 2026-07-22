const BOOKMARK_RULE_STORAGE_KEY = "bookmarkRules";
const STYLE_RULE_STORAGE_KEY = "styleRules";
const LEGACY_ENABLE_SEEN_STYLING_KEY = "enableSeenStyling";
const LEGACY_FOLDER_STORAGE_KEYS = {
    blockedFolderId: "blockedFolderId",
    favoritedFolderId: "favoritedFolderId"
};

let cachedBookmarkFolders = [];
let cachedStyleRules = DEFAULT_STYLE_RULES.map(rule => ({ ...rule }));

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
    for (const select of document.querySelectorAll(".bookmarkRuleStyle, .textRuleStyle")) {
        const includeNone = select.dataset.includeNone === "true";
        populateStyleSelect(
            select,
            select.value || (includeNone ? "" : "blocked"),
            { includeNone }
        );
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
    cssCell.appendChild(cssInput);

    const actionCell = document.createElement("td");
    const deleteBtn = document.createElement("button");
    deleteBtn.textContent = "Delete";
    deleteBtn.type = "button";
    deleteBtn.addEventListener("click", () => {
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
    });
    actionCell.appendChild(deleteBtn);

    row.append(nameCell, kindCell, cssCell, actionCell);
    document.querySelector("#styleRuleBody").appendChild(row);
    updateStyleRuleRowVisibility(row);
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
    clearBookmarkRuleTable();
    loadStyleRuleRows(styleRules);

    searchPairs.forEach(({ site, classes }) => createRow(site, classes));
    urlRules.forEach(({ site, keepParams }) => createUrlRuleRow(site, keepParams));
    if (!textRules || textRules.length === 0) {
        createTextRuleRow();
    } else {
        textRules.forEach(rule => createTextRuleRow(rule.site, rule.text, rule.style));
    }
    // Bookmark rows are rebuilt by loadBookmarkRuleRows (includes the permanent unmatched row).
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
        missingOption.selected = true;
        select.appendChild(missingOption);
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
    const deleteBtn = document.createElement("button");
    deleteBtn.textContent = "Delete";
    deleteBtn.type = "button";
    deleteBtn.addEventListener("click", () => row.remove());
    actionCell.appendChild(deleteBtn);

    row.append(folderCell, styleCell, actionCell);

    const body = document.querySelector("#bookmarkRuleBody");
    const unmatchedRow = body?.querySelector("tr.unmatchedBookmarkRule");
    if (unmatchedRow) {
        body.insertBefore(row, unmatchedRow);
    } else {
        body.appendChild(row);
    }
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

function loadBookmarkRuleRows(rules) {
    return browser.bookmarks.getTree().then(tree => {
        cachedBookmarkFolders = flattenBookmarkFolders(tree);
        clearBookmarkRuleTable();
        const normalizedRules = normalizeBookmarkRules(rules);
        const folderRules = normalizedRules.filter(rule => !isUnmatchedBookmarkRule(rule));
        const unmatchedRule = normalizedRules.find(isUnmatchedBookmarkRule);
        const unmatchedStyle = unmatchedRule
            ? unmatchedRule.style
            : migrateUnmatchedBookmarkStyle({ bookmarkRules: rules });

        if (folderRules.length === 0) {
            createBookmarkRuleRow("", "blocked");
        } else {
            folderRules.forEach(rule => createBookmarkRuleRow(rule.folderId, rule.style));
        }
        createUnmatchedBookmarkRuleRow(unmatchedStyle || "");
    }).catch(err => {
        console.error("Could not load bookmark folders:", err);
        showStatus("Could not load bookmark folders", true);
    });
}

function clearBookmarkRuleTable() {
    document.querySelector("#bookmarkRuleBody")?.replaceChildren();
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

function persistOptionsFromForm({ successMessage = "Options saved" } = {}) {
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

    return browser.storage.local.set(payload)
        .then(() => browser.storage.local.remove([
            LEGACY_FOLDER_STORAGE_KEYS.blockedFolderId,
            LEGACY_FOLDER_STORAGE_KEYS.favoritedFolderId,
            LEGACY_ENABLE_SEEN_STYLING_KEY,
            "textFilters"
        ]))
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
        });
}

function saveOptions(e) {
    e.preventDefault();
    persistOptionsFromForm({ successMessage: "Options saved" }).catch(err => {
        console.error("Save failed:", err);
        showStatus("Could not save options", true);
    });
}

function createRow(site = "", classes = "") {
    const row = document.createElement("tr");

    const siteCell = document.createElement("td");
    const siteInput = document.createElement("input");
    siteInput.type = "text";
    siteInput.value = site;
    siteCell.appendChild(siteInput);

    const classesCell = document.createElement("td");
    const classesInput = document.createElement("input");
    classesInput.type = "text";
    classesInput.value = classes;
    classesCell.appendChild(classesInput);

    const actionCell = document.createElement("td");
    const deleteBtn = document.createElement("button");
    deleteBtn.textContent = "Delete";
    deleteBtn.type = "button";
    deleteBtn.addEventListener("click", () => row.remove());
    actionCell.appendChild(deleteBtn);

    row.appendChild(siteCell);
    row.appendChild(classesCell);
    row.appendChild(actionCell);

    document.querySelector("#tableBody").appendChild(row);
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
    const deleteBtn = document.createElement("button");
    deleteBtn.textContent = "Delete";
    deleteBtn.type = "button";
    deleteBtn.addEventListener("click", () => row.remove());
    actionCell.appendChild(deleteBtn);

    row.appendChild(siteCell);
    row.appendChild(paramsCell);
    row.appendChild(actionCell);

    document.querySelector("#urlRuleBody").appendChild(row);
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
    const deleteBtn = document.createElement("button");
    deleteBtn.textContent = "Delete";
    deleteBtn.type = "button";
    deleteBtn.addEventListener("click", () => row.remove());
    actionCell.appendChild(deleteBtn);

    row.append(siteCell, textCell, styleCell, actionCell);
    document.querySelector("#textRuleBody").appendChild(row);
}

function restoreOptions() {
    function handleStorage(result) {

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

        if (result.textFilters || result.textRules) {
            const textRules = migrateTextRulesFromStorage(result);
            if (textRules.length === 0) {
                createTextRuleRow();
            } else {
                textRules.forEach(rule => createTextRuleRow(
                    rule.site,
                    rule.text,
                    rule.style
                ));
            }
        } else {
            createTextRuleRow();
        }

        return loadBookmarkRuleRows(migrateBookmarkRulesFromStorage(result));
    }


    browser.storage.local.get([
        "searchPairs",
        "urlRules",
        "textRules",
        "textFilters",
        STYLE_RULE_STORAGE_KEY,
        "enableTopBorder",
        "enableDeepSearch",
        "onlyUseSites",
        LEGACY_ENABLE_SEEN_STYLING_KEY,
        BOOKMARK_RULE_STORAGE_KEY,
        LEGACY_FOLDER_STORAGE_KEYS.blockedFolderId,
        LEGACY_FOLDER_STORAGE_KEYS.favoritedFolderId
    ])
    .then(handleStorage)
    .catch(console.error);
}

function initSaveLoadEvents() {
    restoreOptions();
    document.querySelector("form").addEventListener("submit", saveOptions);
}
function exportToClipboard() {
    const data = {
        searchPairs: collectSearchPairs(),
        urlRules: collectUrlRules(),
        textRules: normalizeTextRules(collectTextRules()),
        styleRules: normalizeStyleRules(collectStyleRules()),
        enableTopBorder: document.querySelector("#enableTopBorder").checked,
        onlyUseSites: document.querySelector("#onlyUseSites").checked,
        enableDeepSearch: document.querySelector("#enableDeepSearch").checked,
        bookmarkRules: normalizeBookmarkRules(collectBookmarkRules())
    };

    navigator.clipboard.writeText(
        JSON.stringify(data, null, 2)
    )
    .then(() => showStatus("Exported configuration"))
    .catch(err => {
        console.error(err);
        showStatus("Could not export", true);
    });
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
        return;
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
    if (importedTextRules.length === 0) {
        createTextRuleRow();
    } else {
        importedTextRules.forEach(rule => createTextRuleRow(
            rule.site,
            rule.text,
            rule.style
        ));
    }

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

    loadBookmarkRuleRows(migrateBookmarkRulesFromStorage(data)).then(() => {
        return persistOptionsFromForm({
            successMessage: "Imported and saved configuration"
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

function importFromClipboard() {
    navigator.clipboard.readText()
        .then(text => importFromJson(text))
        .catch(err => {
            console.error("Clipboard read failed:", err);
            showStatus("Could not read from clipboard", true);
        });
}
function clearSearchTable() {
    document.querySelector("#tableBody").replaceChildren();
}

function clearUrlRuleTable() {
    document.querySelector("#urlRuleBody").replaceChildren();
}

function clearTextRuleTable() {
    document.querySelector("#textRuleBody")?.replaceChildren();
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

    if (tabId === "bookmarkRules" || tabId === "textRules") {
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
        if (exportBtn) exportBtn.addEventListener("click", exportToClipboard);
        if (importBtn) importBtn.addEventListener("click", importFromClipboard);
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
