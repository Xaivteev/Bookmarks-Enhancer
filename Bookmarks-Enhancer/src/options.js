const BOOKMARK_RULE_STORAGE_KEY = "bookmarkRules";
const ENABLE_SEEN_STYLING_KEY = "enableSeenStyling";
const LEGACY_FOLDER_STORAGE_KEYS = {
    blockedFolderId: "blockedFolderId",
    favoritedFolderId: "favoritedFolderId"
};

let cachedBookmarkFolders = [];

function mergeRowsBySite(rows, valueKey, parseValues, getValueKey = value => value) {
    const rowsBySite = new Map();

    for (const row of rows) {
        const site = normalizeSiteForMatching(row.site);
        if (!site) continue;

        if (!rowsBySite.has(site)) {
            rowsBySite.set(site, new Map());
        }

        const values = rowsBySite.get(site);
        for (const value of parseValues(row[valueKey])) {
            const key = getValueKey(value);
            if (!values.has(key)) {
                values.set(key, value);
            }
        }
    }

    return Array.from(rowsBySite, ([site, values]) => ({
        site,
        [valueKey]: Array.from(values.values()).join(', ')
    })).filter(row => row[valueKey]);
}

function parseCommaSeparatedValues(value) {
    return typeof value === "string"
        ? value.split(',').map(item => item.trim()).filter(Boolean)
        : [];
}

function parseClassGroups(value) {
    return parseCommaSeparatedValues(value)
        .map(classGroup => classGroup.split(/\s+/).filter(Boolean).join(' '))
        .filter(Boolean);
}

function getClassGroupKey(classGroup) {
    return classGroup.split(/\s+/).sort().join('\u0000');
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
        const style = styleSelect?.value;
        return {
            site: siteInput?.value.trim() || "",
            text: textInput?.value.trim() || "",
            style: style === "favorited" || style === "seen" ? style : "blocked"
        };
    }).filter(rule => rule.site && rule.text);
}

function normalizeTextRules(rules) {
    if (!Array.isArray(rules)) return [];

    const seen = new Set();
    const normalized = [];
    for (const rule of rules) {
        if (!isValidTextRule(rule)) continue;
        const text = rule.text.trim();
        const site = normalizeSiteForMatching(rule.site.trim()) || rule.site.trim();
        if (!site) continue;
        const style = rule.style === "favorited" || rule.style === "seen"
            ? rule.style
            : "blocked";
        const key = [site.toLowerCase(), text.toLowerCase(), style].join("\u0000");
        if (seen.has(key)) continue;
        seen.add(key);
        normalized.push({ site, text, style });
    }
    return normalized;
}

function migrateTextRulesFromStorage(result) {
    if (Array.isArray(result.textRules)) {
        return normalizeTextRules(result.textRules);
    }

    if (!Array.isArray(result.textFilters)) return [];

    const migrated = [];
    for (const filter of result.textFilters) {
        if (!filter || typeof filter.filterText !== "string") continue;
        const site = typeof filter.site === "string" ? filter.site : "";
        const texts = filter.filterText.split(',').map(text => text.trim()).filter(Boolean);
        for (const text of texts) {
            migrated.push({
                site,
                text,
                style: "blocked"
            });
        }
    }
    return normalizeTextRules(migrated);
}

function replaceConfigurationRows(searchPairs, urlRules, textRules, bookmarkRules) {
    clearSearchTable();
    clearUrlRuleTable();
    clearTextRuleTable();
    clearBookmarkRuleTable();

    searchPairs.forEach(({ site, classes }) => createRow(site, classes));
    urlRules.forEach(({ site, keepParams }) => createUrlRuleRow(site, keepParams));
    if (!textRules || textRules.length === 0) {
        createTextRuleRow();
    } else {
        textRules.forEach(rule => createTextRuleRow(rule.site, rule.text, rule.style));
    }
    if (!bookmarkRules || bookmarkRules.length === 0) {
        createBookmarkRuleRow("", "blocked");
    } else {
        bookmarkRules.forEach(rule => createBookmarkRuleRow(rule.folderId, rule.style));
    }
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

    const blockedOption = document.createElement("option");
    blockedOption.value = "blocked";
    blockedOption.textContent = "Blocked (hide)";
    blockedOption.selected = style !== "favorited";

    const favoritedOption = document.createElement("option");
    favoritedOption.value = "favorited";
    favoritedOption.textContent = "Favorited (double underline)";
    favoritedOption.selected = style === "favorited";

    styleSelect.append(blockedOption, favoritedOption);
    styleCell.appendChild(styleSelect);

    const actionCell = document.createElement("td");
    const deleteBtn = document.createElement("button");
    deleteBtn.textContent = "Delete";
    deleteBtn.type = "button";
    deleteBtn.addEventListener("click", () => row.remove());
    actionCell.appendChild(deleteBtn);

    row.append(folderCell, styleCell, actionCell);
    document.querySelector("#bookmarkRuleBody").appendChild(row);
}

function collectBookmarkRules() {
    return Array.from(document.querySelectorAll("#bookmarkRuleBody tr")).map(row => {
        const folderSelect = row.querySelector(".bookmarkRuleFolder");
        const styleSelect = row.querySelector(".bookmarkRuleStyle");
        return {
            folderId: folderSelect?.value || "",
            style: styleSelect?.value === "favorited" ? "favorited" : "blocked"
        };
    }).filter(rule => rule.folderId);
}

function normalizeBookmarkRules(rules) {
    if (!Array.isArray(rules)) return [];

    const seenFolders = new Set();
    const normalized = [];

    for (const rule of rules) {
        if (!isValidBookmarkRule(rule)) continue;
        if (seenFolders.has(rule.folderId)) continue;
        seenFolders.add(rule.folderId);
        normalized.push({
            folderId: rule.folderId,
            style: rule.style === "favorited" ? "favorited" : "blocked"
        });
    }

    return normalized;
}

function migrateBookmarkRulesFromStorage(result) {
    if (Array.isArray(result.bookmarkRules)) {
        return normalizeBookmarkRules(result.bookmarkRules);
    }

    const legacyRules = [];
    if (typeof result.blockedFolderId === "string" && result.blockedFolderId) {
        legacyRules.push({ folderId: result.blockedFolderId, style: "blocked" });
    }
    if (typeof result.favoritedFolderId === "string" && result.favoritedFolderId) {
        legacyRules.push({ folderId: result.favoritedFolderId, style: "favorited" });
    }
    return normalizeBookmarkRules(legacyRules);
}

function loadBookmarkRuleRows(rules) {
    return browser.bookmarks.getTree().then(tree => {
        cachedBookmarkFolders = flattenBookmarkFolders(tree);
        clearBookmarkRuleTable();
        const normalizedRules = normalizeBookmarkRules(rules);
        if (normalizedRules.length === 0) {
            createBookmarkRuleRow("", "blocked");
            return;
        }
        normalizedRules.forEach(rule => createBookmarkRuleRow(rule.folderId, rule.style));
    }).catch(err => {
        console.error("Could not load bookmark folders:", err);
        showStatus("Could not load bookmark folders", true);
    });
}

function clearBookmarkRuleTable() {
    document.querySelector("#bookmarkRuleBody")?.replaceChildren();
}

function saveOptions(e) {
    e.preventDefault();
    const searchPairs = collectSearchPairs();
    const urlRules = collectUrlRules();
    const textRules = normalizeTextRules(collectTextRules());
    const bookmarkRules = normalizeBookmarkRules(collectBookmarkRules());

    let obj = {
		enableTopBorder: document.querySelector("#enableTopBorder").checked,
		enableDeepSearch: document.querySelector("#enableDeepSearch").checked,
		onlyUseSites: document.querySelector("#onlyUseSites").checked,
        [ENABLE_SEEN_STYLING_KEY]: document.querySelector("#enableSeenStyling").checked,
        searchPairs,
        urlRules,
        textRules,
        [BOOKMARK_RULE_STORAGE_KEY]: bookmarkRules
    };

    browser.storage.local.set(obj)
        .then(() => browser.storage.local.remove([
            LEGACY_FOLDER_STORAGE_KEYS.blockedFolderId,
            LEGACY_FOLDER_STORAGE_KEYS.favoritedFolderId,
            "textFilters"
        ]))
        .then(() => {
            replaceConfigurationRows(searchPairs, urlRules, textRules, bookmarkRules);
            showStatus("Options saved");
        })
        .catch(err => {
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
    for (const [value, label] of [
        ["blocked", "Blocked (hide)"],
        ["favorited", "Favorited (double underline)"],
        ["seen", "Seen (dashed underline)"]
    ]) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = label;
        option.selected = style === value;
        styleSelect.appendChild(option);
    }
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

        document.querySelector("#enableSeenStyling").checked =
            result.enableSeenStyling !== false;


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
        "enableTopBorder",
        "enableDeepSearch",
        "onlyUseSites",
        ENABLE_SEEN_STYLING_KEY,
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
        enableTopBorder: document.querySelector("#enableTopBorder").checked,
        onlyUseSites: document.querySelector("#onlyUseSites").checked,
        enableDeepSearch: document.querySelector("#enableDeepSearch").checked,
        enableSeenStyling: document.querySelector("#enableSeenStyling").checked,
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

    if (data.enableSeenStyling !== undefined) {
        document.querySelector("#enableSeenStyling").checked =
            data.enableSeenStyling;
    }

    loadBookmarkRuleRows(migrateBookmarkRulesFromStorage(data)).then(() => {
        showStatus("Imported configuration");
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

function isValidTextRule(row) {
    return row &&
        typeof row.site === "string" &&
        row.site.trim() !== "" &&
        typeof row.text === "string" &&
        row.text.trim() !== "" &&
        (
            row.style === undefined ||
            row.style === "blocked" ||
            row.style === "favorited" ||
            row.style === "seen"
        );
}

function isValidBookmarkRule(row) {
    return row &&
        typeof row.folderId === "string" &&
        row.folderId.trim() !== "" &&
        (row.style === "blocked" || row.style === "favorited");
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
    }, 3000);
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

        if (!addRowBtn) console.warn("addRowBtn not found");
        if (!exportBtn) console.warn("exportBtn not found");
        if (!importBtn) console.warn("importBtn not found");
        if (!addUrlRuleBtn) console.warn("addUrlRuleBtn not found");
        if (!addTextRuleBtn) console.warn("addTextRuleBtn not found");
        if (!addBookmarkRuleBtn) console.warn("addBookmarkRuleBtn not found");

        if (addRowBtn) addRowBtn.addEventListener("click", () => createRow());
        if (exportBtn) exportBtn.addEventListener("click", exportToClipboard);
        if (importBtn) importBtn.addEventListener("click", importFromClipboard);
        if (addUrlRuleBtn) addUrlRuleBtn.addEventListener("click", () => createUrlRuleRow());
        if (addTextRuleBtn) addTextRuleBtn.addEventListener("click", () => createTextRuleRow());
        if (addBookmarkRuleBtn) {
            addBookmarkRuleBtn.addEventListener("click", () => createBookmarkRuleRow());
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
