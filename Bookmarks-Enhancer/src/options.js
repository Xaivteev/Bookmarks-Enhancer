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
let suppressDirtyTracking = false;
let savedFormSnapshot = null;
let dirtyUiSyncTimer = null;
const OPTIONS_DOC_TITLE = "Bookmarks Enhancer Options";
const DIRTY_CLICK_SELECTOR = [
    "#addRowBtn",
    "#addUrlRuleBtn",
    "#addTextRuleBtn",
    "#addBookmarkRuleBtn",
    "#addStyleRuleBtn",
    ".rowDeleteBtn",
    ".rowMoveBtn"
].join(", ");

function applyGettingStartedVisibility(hidden) {
    const panel = document.querySelector("#gettingStarted");
    if (!panel) return;
    panel.hidden = !!hidden;
}

function dismissGettingStarted() {
    applyGettingStartedVisibility(true);
    browser.storage.local.set({
        [STORAGE_KEYS.hideGettingStarted]: true
    }).catch(err => {
        console.error("Could not save getting started preference:", err);
        showStatus("Could not save preference", true);
    });
}

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

function createMoveButton(direction) {
    const moveBtn = document.createElement("button");
    const moveUp = direction < 0;
    moveBtn.type = "button";
    moveBtn.className = moveUp ? "rowMoveBtn rowMoveUpBtn" : "rowMoveBtn rowMoveDownBtn";
    moveBtn.textContent = moveUp ? "↑" : "↓";
    moveBtn.setAttribute("aria-label", moveUp ? "Move up" : "Move down");
    moveBtn.title = moveUp ? "Move up (higher priority)" : "Move down (lower priority)";
    return moveBtn;
}

function getBookmarkFolderRuleRows() {
    return Array.from(
        document.querySelectorAll("#bookmarkRuleBody tr:not(.unmatchedBookmarkRule)")
    );
}

function refreshBookmarkRulePriorities() {
    const rows = getBookmarkFolderRuleRows();
    rows.forEach((row, index) => {
        const num = row.querySelector(".bookmarkRulePriorityNum");
        if (num) {
            num.textContent = `#${index + 1}`;
        }
        const upBtn = row.querySelector(".rowMoveUpBtn");
        const downBtn = row.querySelector(".rowMoveDownBtn");
        if (upBtn) upBtn.disabled = index === 0;
        if (downBtn) downBtn.disabled = index === rows.length - 1;
    });

    const unmatchedNum = document.querySelector(
        "#bookmarkRuleBody tr.unmatchedBookmarkRule .bookmarkRulePriorityNum"
    );
    if (unmatchedNum) {
        unmatchedNum.textContent = "Last";
    }
}

function moveBookmarkRuleRow(row, direction) {
    const body = row.parentElement;
    if (!body) return;

    const folderRows = getBookmarkFolderRuleRows();
    const index = folderRows.indexOf(row);
    const targetIndex = index + direction;
    if (index < 0 || targetIndex < 0 || targetIndex >= folderRows.length) return;

    const reference = direction < 0
        ? folderRows[targetIndex]
        : folderRows[targetIndex].nextElementSibling;
    body.insertBefore(row, reference);
    refreshBookmarkRulePriorities();

    const preferred = row.querySelector(direction < 0 ? ".rowMoveUpBtn" : ".rowMoveDownBtn");
    const fallback = row.querySelector(direction < 0 ? ".rowMoveDownBtn" : ".rowMoveUpBtn");
    if (preferred && !preferred.disabled) {
        preferred.focus();
    } else {
        fallback?.focus();
    }
}

function createBookmarkPriorityCell({ unmatched = false } = {}) {
    const cell = document.createElement("td");
    const wrap = document.createElement("div");
    wrap.className = "bookmarkRulePriority";

    const num = document.createElement("span");
    num.className = "bookmarkRulePriorityNum";
    num.textContent = unmatched ? "Last" : "#1";
    wrap.appendChild(num);

    if (!unmatched) {
        const move = document.createElement("div");
        move.className = "bookmarkRuleMove";
        const upBtn = createMoveButton(-1);
        const downBtn = createMoveButton(1);
        upBtn.addEventListener("click", () => moveBookmarkRuleRow(cell.parentElement, -1));
        downBtn.addEventListener("click", () => moveBookmarkRuleRow(cell.parentElement, 1));
        move.append(upBtn, downBtn);
        wrap.appendChild(move);
    }

    cell.appendChild(wrap);
    return cell;
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
    syncAdvancedSiteRulesOpen();
}

function openAdvancedSiteRules() {
    const panel = document.querySelector("#advancedSiteRules");
    if (panel) panel.open = true;
}

function syncAdvancedSiteRulesOpen() {
    const panel = document.querySelector("#advancedSiteRules");
    if (!panel) return;
    const hasRows =
        document.querySelectorAll("#textRuleBody tr").length > 0 ||
        document.querySelectorAll("#urlRuleBody tr").length > 0;
    if (hasRows) panel.open = true;
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
        return {
            site: row.querySelector(".urlRuleSite")?.value || "",
            keepParams: row.querySelector(".urlRuleParams")?.value || ""
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

function isBookmarkRootNode(node) {
    return !!node && (node.id === "root________" || node.id === "0");
}

function flattenBookmarkFolders(nodes, path = "", group = null) {
    const folders = [];

    for (const node of nodes || []) {
        const isFolder = node.type === "folder" || (!node.url && Array.isArray(node.children));
        if (!isFolder) continue;

        const title = node.title || "Folder";
        const isRoot = isBookmarkRootNode(node);
        const nextGroup = isRoot ? null : (group || { id: node.id, title });
        const nextPath = isRoot ? "" : (path ? `${path} / ${title}` : title);

        if (!isRoot && nextGroup) {
            const displayLabel = nextPath === nextGroup.title
                ? nextGroup.title
                : nextPath.startsWith(`${nextGroup.title} / `)
                    ? nextPath.slice(nextGroup.title.length + 3)
                    : nextPath;
            folders.push({
                id: node.id,
                label: nextPath,
                displayLabel,
                groupId: nextGroup.id,
                groupTitle: nextGroup.title,
                searchText: nextPath.toLowerCase()
            });
        }

        if (Array.isArray(node.children)) {
            folders.push(...flattenBookmarkFolders(
                node.children,
                nextPath,
                nextGroup
            ));
        }
    }

    return folders;
}

function findCachedBookmarkFolder(folderId) {
    return cachedBookmarkFolders.find(folder => folder.id === folderId) || null;
}

function foldersForCombobox(selectedId) {
    const folders = cachedBookmarkFolders.slice();
    if (selectedId && !folders.some(folder => folder.id === selectedId)) {
        const label = `Missing folder (${selectedId})`;
        folders.unshift({
            id: selectedId,
            label,
            displayLabel: label,
            groupId: "__missing__",
            groupTitle: "Missing",
            searchText: label.toLowerCase()
        });
    }
    return folders;
}

function groupBookmarkFolders(folders) {
    const groups = [];
    const byId = new Map();
    for (const folder of folders) {
        const key = folder.groupId || "";
        if (!byId.has(key)) {
            const group = {
                id: key,
                title: folder.groupTitle || "Folders",
                folders: []
            };
            byId.set(key, group);
            groups.push(group);
        }
        byId.get(key).folders.push(folder);
    }
    return groups;
}

function getFolderComboboxLabel(folderId) {
    if (!folderId) return "";
    return findCachedBookmarkFolder(folderId)?.label || `Missing folder (${folderId})`;
}

let folderComboboxSeq = 0;
const folderComboboxState = new WeakMap();

function getOpenFolderCombobox() {
    return document.querySelector(".folderCombobox.is-open");
}

function closeFolderCombobox(box, { revert = true } = {}) {
    const state = folderComboboxState.get(box);
    if (!state) return;
    if (revert) {
        state.input.value = state.committedLabel;
    }
    state.activeId = "";
    state.input.setAttribute("aria-expanded", "false");
    state.input.removeAttribute("aria-activedescendant");
    state.listbox.hidden = true;
    box.classList.remove("is-open");
}

function closeAllFolderComboboxes(except = null) {
    for (const box of document.querySelectorAll(".folderCombobox.is-open")) {
        if (box !== except) closeFolderCombobox(box);
    }
}

function getVisibleFolderOptions(box) {
    const state = folderComboboxState.get(box);
    if (!state) return [];
    return Array.from(state.listbox.querySelectorAll('[role="option"]'));
}

function setActiveFolderOption(box, option) {
    const state = folderComboboxState.get(box);
    if (!state) return;
    for (const item of getVisibleFolderOptions(box)) {
        item.classList.toggle("is-active", item === option);
    }
    state.activeId = option?.id || "";
    if (option) {
        state.input.setAttribute("aria-activedescendant", option.id);
        option.scrollIntoView({ block: "nearest" });
    } else {
        state.input.removeAttribute("aria-activedescendant");
    }
}

function commitFolderCombobox(box, folderId) {
    const state = folderComboboxState.get(box);
    if (!state) return;
    const label = getFolderComboboxLabel(folderId);
    const changed = state.hidden.value !== (folderId || "");
    state.hidden.value = folderId || "";
    state.committedId = folderId || "";
    state.committedLabel = label;
    state.input.value = label;
    closeFolderCombobox(box, { revert: false });
    if (changed) {
        state.hidden.dispatchEvent(new Event("input", { bubbles: true }));
        state.hidden.dispatchEvent(new Event("change", { bubbles: true }));
    }
}

function getFolderComboboxFilter(state) {
    const typed = state.input.value.trim().toLowerCase();
    const committed = (state.committedLabel || "").trim().toLowerCase();
    if (!typed || typed === committed) return "";
    return typed;
}

function renderFolderComboboxList(box) {
    const state = folderComboboxState.get(box);
    if (!state) return;

    const query = getFolderComboboxFilter(state);
    const folders = foldersForCombobox(state.committedId).filter(folder =>
        !query || folder.searchText.includes(query) || folder.displayLabel.toLowerCase().includes(query)
    );
    const groups = groupBookmarkFolders(folders);

    state.listbox.replaceChildren();
    if (folders.length === 0) {
        const empty = document.createElement("div");
        empty.className = "folderComboboxEmpty";
        empty.textContent = cachedBookmarkFolders.length === 0
            ? "No bookmark folders found"
            : "No matching folders";
        state.listbox.appendChild(empty);
        setActiveFolderOption(box, null);
        return;
    }

    let optionIndex = 0;
    let selectedOption = null;
    for (const group of groups) {
        const groupEl = document.createElement("div");
        groupEl.className = "folderComboboxGroup";
        groupEl.setAttribute("role", "group");
        groupEl.setAttribute("aria-label", group.title);

        const label = document.createElement("div");
        label.className = "folderComboboxGroupLabel";
        label.textContent = group.title;
        groupEl.appendChild(label);

        for (const folder of group.folders) {
            const option = document.createElement("div");
            option.className = "folderComboboxOption";
            option.id = `${state.listbox.id}-opt-${optionIndex++}`;
            option.setAttribute("role", "option");
            option.setAttribute("aria-selected", folder.id === state.committedId ? "true" : "false");
            option.dataset.folderId = folder.id;
            option.textContent = folder.displayLabel;
            option.title = folder.label;
            option.addEventListener("pointerdown", event => {
                event.preventDefault();
                commitFolderCombobox(box, folder.id);
            });
            if (folder.id === state.committedId) {
                selectedOption = option;
            }
            groupEl.appendChild(option);
        }

        state.listbox.appendChild(groupEl);
    }

    setActiveFolderOption(box, selectedOption || getVisibleFolderOptions(box)[0] || null);
}

function openFolderCombobox(box) {
    const state = folderComboboxState.get(box);
    if (!state) return;
    closeAllFolderComboboxes(box);
    renderFolderComboboxList(box);
    state.listbox.hidden = false;
    state.input.setAttribute("aria-expanded", "true");
    box.classList.add("is-open");
}

function moveFolderComboboxActive(box, offset) {
    const options = getVisibleFolderOptions(box);
    if (options.length === 0) return;
    const state = folderComboboxState.get(box);
    const currentIndex = options.findIndex(option => option.id === state?.activeId);
    let nextIndex = currentIndex + offset;
    if (currentIndex < 0) {
        nextIndex = offset > 0 ? 0 : options.length - 1;
    } else {
        nextIndex = (nextIndex + options.length) % options.length;
    }
    setActiveFolderOption(box, options[nextIndex]);
}

function createFolderCombobox(selectedId = "") {
    const id = `folder-combobox-${++folderComboboxSeq}`;
    const box = document.createElement("div");
    box.className = "folderCombobox";

    const hidden = document.createElement("input");
    hidden.type = "hidden";
    hidden.className = "bookmarkRuleFolder";
    hidden.value = selectedId || "";

    const input = document.createElement("input");
    input.type = "text";
    input.className = "folderComboboxInput";
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-expanded", "false");
    input.setAttribute("aria-controls", `${id}-list`);
    input.setAttribute("aria-autocomplete", "list");
    input.setAttribute("aria-label", "Bookmark folder");
    input.placeholder = "Search folders";
    input.autocomplete = "off";
    input.spellcheck = false;

    const listbox = document.createElement("div");
    listbox.className = "folderComboboxList";
    listbox.id = `${id}-list`;
    listbox.setAttribute("role", "listbox");
    listbox.hidden = true;

    const committedLabel = getFolderComboboxLabel(selectedId);
    input.value = committedLabel;
    folderComboboxState.set(box, {
        hidden,
        input,
        listbox,
        activeId: "",
        committedId: selectedId || "",
        committedLabel
    });

    input.addEventListener("focus", () => {
        input.select();
    });
    input.addEventListener("click", () => {
        openFolderCombobox(box);
    });
    input.addEventListener("input", () => {
        openFolderCombobox(box);
    });
    input.addEventListener("keydown", event => {
        const isOpen = box.classList.contains("is-open");
        if (event.key === "ArrowDown") {
            event.preventDefault();
            if (!isOpen) openFolderCombobox(box);
            else moveFolderComboboxActive(box, 1);
        } else if (event.key === "ArrowUp") {
            event.preventDefault();
            if (!isOpen) openFolderCombobox(box);
            else moveFolderComboboxActive(box, -1);
        } else if (event.key === "Home" && isOpen) {
            event.preventDefault();
            const options = getVisibleFolderOptions(box);
            if (options[0]) setActiveFolderOption(box, options[0]);
        } else if (event.key === "End" && isOpen) {
            event.preventDefault();
            const options = getVisibleFolderOptions(box);
            if (options.length) setActiveFolderOption(box, options[options.length - 1]);
        } else if (event.key === "Enter") {
            event.preventDefault();
            if (!isOpen) {
                openFolderCombobox(box);
                return;
            }
            const current = folderComboboxState.get(box);
            const active = current?.activeId
                ? document.getElementById(current.activeId)
                : null;
            if (active?.dataset.folderId) {
                commitFolderCombobox(box, active.dataset.folderId);
            }
        } else if (event.key === "Escape") {
            if (isOpen) {
                event.preventDefault();
                closeFolderCombobox(box);
            }
        } else if (event.key === "Tab") {
            if (isOpen) closeFolderCombobox(box);
        }
    });
    input.addEventListener("blur", () => {
        window.setTimeout(() => {
            if (box.classList.contains("is-open") && document.activeElement !== input) {
                closeFolderCombobox(box);
            }
        }, 0);
    });

    box.append(hidden, input, listbox);
    return box;
}

function refreshFolderCombobox(box) {
    const state = folderComboboxState.get(box);
    if (!state) return;
    const folderId = state.hidden.value || "";
    state.committedId = folderId;
    state.committedLabel = getFolderComboboxLabel(folderId);
    if (!box.classList.contains("is-open")) {
        state.input.value = state.committedLabel;
    } else {
        renderFolderComboboxList(box);
    }
}

function refreshBookmarkFolderSelectOptions() {
    for (const hidden of document.querySelectorAll(".bookmarkRuleFolder")) {
        const box = hidden.closest(".folderCombobox");
        if (box) refreshFolderCombobox(box);
    }
}

function setupFolderComboboxDismiss() {
    document.addEventListener("pointerdown", event => {
        const open = getOpenFolderCombobox();
        if (!open) return;
        const target = event.target instanceof Element ? event.target : null;
        if (target && open.contains(target)) return;
        closeFolderCombobox(open);
    });
}

function createBookmarkRuleRow(folderId = "", style = "blocked") {
    const row = document.createElement("tr");

    const priorityCell = createBookmarkPriorityCell();

    const folderCell = document.createElement("td");
    folderCell.appendChild(createFolderCombobox(folderId || ""));

    const styleCell = document.createElement("td");
    const styleSelect = document.createElement("select");
    styleSelect.className = "bookmarkRuleStyle";
    populateStyleSelect(styleSelect, style || "blocked");
    styleCell.appendChild(styleSelect);

    const actionCell = document.createElement("td");
    actionCell.appendChild(createRowActions(
        createDeleteButton(() => {
            row.remove();
            refreshBookmarkRulePriorities();
            refreshAllTableEmptyStates();
        })
    ));

    row.append(priorityCell, folderCell, styleCell, actionCell);

    const body = document.querySelector("#bookmarkRuleBody");
    const unmatchedRow = body?.querySelector("tr.unmatchedBookmarkRule");
    if (unmatchedRow) {
        body.insertBefore(row, unmatchedRow);
    } else {
        body.appendChild(row);
    }
    refreshBookmarkRulePriorities();
    refreshAllTableEmptyStates();
}

function createUnmatchedBookmarkRuleRow(style = "") {
    const body = document.querySelector("#bookmarkRuleBody");
    const existing = body?.querySelector("tr.unmatchedBookmarkRule");
    if (existing) existing.remove();

    const row = document.createElement("tr");
    row.className = "unmatchedBookmarkRule";
    row.dataset.folderId = UNMATCHED_BOOKMARK_RULE_ID;

    const priorityCell = createBookmarkPriorityCell({ unmatched: true });

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

    row.append(priorityCell, folderCell, styleCell, actionCell);
    body.appendChild(row);
    refreshBookmarkRulePriorities();
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

let lastBookmarkRulesForLoad = [];

function retryLoadBookmarkFolders() {
    const rules = lastBookmarkRulesForLoad.length > 0
        ? lastBookmarkRulesForLoad
        : normalizeBookmarkRules(collectBookmarkRules());
    return loadBookmarkRuleRows(rules).then(() => {
        if (bookmarkRulesReady && cachedBookmarkFolders.length > 0) {
            showStatus("Bookmark folders loaded");
        }
    });
}

function loadBookmarkRuleRows(rules) {
    lastBookmarkRulesForLoad = Array.isArray(rules) ? rules.slice() : [];
    // Rebuild immediately from cache so saves don't flash an empty table while
    // waiting on bookmarks.getTree().
    if (cachedBookmarkFolders.length > 0) {
        renderBookmarkRuleRows(rules);
        setBookmarkRulesReady(true);
        if (suppressDirtyTracking) {
            captureSavedFormSnapshot();
        }
        return browser.bookmarks.getTree().then(tree => {
            cachedBookmarkFolders = flattenBookmarkFolders(tree);
            refreshBookmarkFolderSelectOptions();
        }).catch(err => {
            console.error("Could not refresh bookmark folders:", err);
            showStatus("Could not refresh bookmark folders", {
                isError: true,
                actions: [
                    {
                        label: "Retry",
                        onClick: () => retryLoadBookmarkFolders()
                    }
                ]
            });
        });
    }

    setBookmarkRulesReady(false);
    return browser.bookmarks.getTree().then(tree => {
        cachedBookmarkFolders = flattenBookmarkFolders(tree);
        renderBookmarkRuleRows(rules);
        setBookmarkRulesReady(true);
        if (suppressDirtyTracking) {
            captureSavedFormSnapshot();
        }
    }).catch(err => {
        console.error("Could not load bookmark folders:", err);
        // Still render stored rules (folder selects show "Missing folder") so a
        // later Save cannot overwrite storage with an empty table.
        renderBookmarkRuleRows(rules);
        setBookmarkRulesReady(true);
        if (suppressDirtyTracking) {
            captureSavedFormSnapshot();
        }
        showStatus("Could not load bookmark folders", {
            isError: true,
            actions: [
                {
                    label: "Retry",
                    onClick: () => retryLoadBookmarkFolders()
                }
            ]
        });
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
        const folderInput = row.querySelector(".bookmarkRuleFolder");
        const combobox = folderInput?.closest(".folderCombobox");
        const label = combobox?.querySelector(".folderComboboxInput")?.value ||
            folderInput?.value ||
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
            enableToastNotifications: document.querySelector("#enableToastNotifications").checked,
            [STYLE_RULE_STORAGE_KEY]: styleRules,
            searchPairs,
            urlRules,
            textRules,
            [BOOKMARK_RULE_STORAGE_KEY]: bookmarkRules
        }
    };
}

function getFormSnapshot() {
    if (!bookmarkRulesReady) return null;
    try {
        return JSON.stringify({
            payload: buildExportPayload(),
            rows: {
                styles: document.querySelectorAll("#styleRuleBody tr").length,
                bookmarks: document.querySelectorAll(
                    "#bookmarkRuleBody tr:not(.unmatchedBookmarkRule)"
                ).length,
                text: document.querySelectorAll("#textRuleBody tr").length,
                search: document.querySelectorAll("#tableBody tr").length,
                url: document.querySelectorAll("#urlRuleBody tr").length
            }
        });
    } catch (err) {
        console.error("Could not snapshot options form:", err);
        return null;
    }
}

function isFormDirty() {
    if (savedFormSnapshot == null) return false;
    const current = getFormSnapshot();
    return current != null && current !== savedFormSnapshot;
}

function updateDirtyUi() {
    const dirty = isFormDirty();
    document.body.classList.toggle("has-unsaved-changes", dirty);

    const label = document.querySelector("#unsavedChangesLabel");
    if (label) {
        label.hidden = !dirty;
    }

    const saveBtn = document.querySelector("#saveBtn");
    if (saveBtn) {
        saveBtn.title = dirty ? "Save unsaved changes" : "Save";
    }

    document.title = dirty
        ? `${OPTIONS_DOC_TITLE} — Unsaved`
        : OPTIONS_DOC_TITLE;
}

function scheduleDirtyUiUpdate() {
    if (suppressDirtyTracking) return;
    if (dirtyUiSyncTimer) {
        clearTimeout(dirtyUiSyncTimer);
    }
    dirtyUiSyncTimer = setTimeout(() => {
        dirtyUiSyncTimer = null;
        if (suppressDirtyTracking) return;
        updateDirtyUi();
    }, 50);
}

function captureSavedFormSnapshot() {
    savedFormSnapshot = getFormSnapshot();
    updateDirtyUi();
}

function showExternalOptionsChangeNotice() {
    showStatus(
        "Settings changed elsewhere. Save to keep this form, or reload to discard your edits.",
        {
            warning: true,
            duration: 15000,
            actions: [
                {
                    label: "Reload",
                    onClick: () => {
                        restoreOptions().then(() => {
                            showStatus("Reloaded saved settings");
                        });
                    }
                }
            ]
        }
    );
}

function setupDirtyTracking() {
    const form = document.querySelector("form");
    if (!form) return;

    form.addEventListener("input", scheduleDirtyUiUpdate);
    form.addEventListener("change", scheduleDirtyUiUpdate);
    form.addEventListener("click", event => {
        const target = event.target instanceof Element ? event.target : null;
        if (target?.closest(DIRTY_CLICK_SELECTOR)) {
            scheduleDirtyUiUpdate();
        }
    });

    window.addEventListener("beforeunload", event => {
        if (!isFormDirty()) return;
        event.preventDefault();
        event.returnValue = "";
    });

    document.addEventListener("keydown", event => {
        if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) {
            return;
        }
        if (event.key !== "s" && event.key !== "S") return;
        event.preventDefault();
        if (actionBarBusy || !bookmarkRulesReady) return;
        persistOptionsFromForm({
            successMessage: "Options saved",
            busyLabel: "Saving…",
            busyButton: document.querySelector("#saveBtn")
        }).catch(err => {
            console.error("Save failed:", err);
            showStatus("Could not save options", true);
        });
    });
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

    if (!validateConfigurableRuleRows()) {
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
    suppressDirtyTracking = true;
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
            suppressDirtyTracking = false;
            updateDirtyUi();
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
            suppressDirtyTracking = false;
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

function setFieldError(input, errorEl, message) {
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

function createFieldError(errorId) {
    const error = document.createElement("p");
    error.className = "fieldError";
    error.id = errorId;
    error.hidden = true;
    return error;
}

function showRowValidationError(tabId, selector, message, actionLabel, {
    openAdvanced = false
} = {}) {
    activateOptionsTab(tabId);
    if (openAdvanced) openAdvancedSiteRules();
    const firstInvalid = document.querySelector(selector);
    firstInvalid?.focus();
    showStatus(message, {
        isError: true,
        actions: [
            {
                label: actionLabel,
                onClick: () => {
                    activateOptionsTab(tabId);
                    if (openAdvanced) openAdvancedSiteRules();
                    document.querySelector(selector)?.focus();
                }
            }
        ]
    });
}

function validateConfigurableRuleRows() {
    const textValid = validateAllTextRuleRows();
    const searchValid = validateAllSearchPairRows();
    const urlValid = validateAllUrlRuleRows();
    if (textValid && searchValid && urlValid) return true;

    if (!textValid) {
        showRowValidationError(
            "sites",
            "#textRuleBody .fieldInvalid",
            "Fix Text Rule errors before saving",
            "Open Text Rules",
            { openAdvanced: true }
        );
    } else if (!searchValid) {
        showRowValidationError(
            "sites",
            "#tableBody input.fieldInvalid",
            "Fix Search Pair errors before saving",
            "Open Sites"
        );
    } else {
        showRowValidationError(
            "sites",
            "#urlRuleBody input.fieldInvalid",
            "Fix URL Parameter Rule errors before saving",
            "Open URL Rules",
            { openAdvanced: true }
        );
    }
    return false;
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
            setFieldError(state.siteInput, state.siteError, "");
            setFieldError(state.classesInput, state.classesError, "");
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

        setFieldError(state.siteInput, state.siteError, siteMessage);
        setFieldError(state.classesInput, state.classesError, classesMessage);

        if (siteMessage || classesMessage) {
            allValid = false;
        }
    }

    return allValid;
}

function isPlausibleQueryParamName(name) {
    return /^[A-Za-z0-9._~-]+$/.test(name);
}

let urlRuleFieldIdSeq = 0;

function createUrlRuleRow(site = "", keepParams = "") {
    const row = document.createElement("tr");
    const idSuffix = `url-${++urlRuleFieldIdSeq}`;

    const siteCell = document.createElement("td");
    const siteInput = document.createElement("input");
    siteInput.type = "text";
    siteInput.className = "urlRuleSite";
    siteInput.value = site;
    siteInput.placeholder = "example.com";
    siteInput.setAttribute("aria-label", "Site");
    siteInput.setAttribute("aria-describedby", `${idSuffix}-site-error`);
    siteInput.autocomplete = "off";
    const siteError = createFieldError(`${idSuffix}-site-error`);
    siteCell.append(siteInput, siteError);

    const paramsCell = document.createElement("td");
    const paramsInput = document.createElement("input");
    paramsInput.type = "text";
    paramsInput.className = "urlRuleParams";
    paramsInput.value = keepParams;
    paramsInput.placeholder = "id, jk";
    paramsInput.setAttribute("aria-label", "Parameters to keep");
    paramsInput.setAttribute("aria-describedby", `${idSuffix}-params-error`);
    paramsInput.autocomplete = "off";
    const paramsError = createFieldError(`${idSuffix}-params-error`);
    paramsCell.append(paramsInput, paramsError);

    const actionCell = document.createElement("td");
    actionCell.appendChild(createRowActions(
        createDeleteButton(() => {
            row.remove();
            validateAllUrlRuleRows();
            refreshAllTableEmptyStates();
        })
    ));

    const scheduleValidate = () => {
        validateAllUrlRuleRows();
    };
    siteInput.addEventListener("input", scheduleValidate);
    siteInput.addEventListener("blur", scheduleValidate);
    paramsInput.addEventListener("input", scheduleValidate);
    paramsInput.addEventListener("blur", scheduleValidate);

    row.append(siteCell, paramsCell, actionCell);
    document.querySelector("#urlRuleBody").appendChild(row);
    validateAllUrlRuleRows();
    refreshAllTableEmptyStates();
}

function getUrlRuleRowState(row) {
    const siteInput = row.querySelector(".urlRuleSite");
    const paramsInput = row.querySelector(".urlRuleParams");
    const siteRaw = siteInput?.value.trim() || "";
    const paramsRaw = paramsInput?.value.trim() || "";
    const keepParams = parseCommaSeparatedValues(paramsRaw);
    const normalizedSite = siteRaw ? normalizeSite(siteRaw) : "";

    return {
        siteInput,
        paramsInput,
        siteError: siteInput?.parentElement?.querySelector(".fieldError"),
        paramsError: paramsInput?.parentElement?.querySelector(".fieldError"),
        siteRaw,
        paramsRaw,
        keepParams,
        normalizedSite,
        isBlank: !siteRaw && !paramsRaw
    };
}

function validateAllUrlRuleRows() {
    const rows = Array.from(document.querySelectorAll("#urlRuleBody tr"))
        .map(getUrlRuleRowState)
        .filter(state => state.siteInput && state.paramsInput);

    const seenSites = new Map();
    let allValid = true;

    for (let index = 0; index < rows.length; index++) {
        const state = rows[index];
        let siteMessage = "";
        let paramsMessage = "";

        if (state.isBlank) {
            setFieldError(state.siteInput, state.siteError, "");
            setFieldError(state.paramsInput, state.paramsError, "");
            continue;
        }

        if (!state.siteRaw) {
            siteMessage = "Enter a site hostname.";
        } else if (!isPlausibleHostname(state.siteRaw)) {
            siteMessage = "Enter a valid hostname (example.com).";
        }

        if (!state.paramsRaw || state.keepParams.length === 0) {
            paramsMessage = "Enter at least one parameter to keep (id, jk).";
        } else {
            const invalidNames = state.keepParams.filter(
                name => !isPlausibleQueryParamName(name)
            );
            if (invalidNames.length > 0) {
                paramsMessage = "Use parameter names only (id, jk), not values or full URLs.";
            }
        }

        if (!siteMessage && !paramsMessage && state.normalizedSite) {
            if (seenSites.has(state.normalizedSite)) {
                siteMessage = "Duplicate site. Combine parameters into one row.";
            } else {
                seenSites.set(state.normalizedSite, index);
            }
        }

        setFieldError(state.siteInput, state.siteError, siteMessage);
        setFieldError(state.paramsInput, state.paramsError, paramsMessage);

        if (siteMessage || paramsMessage) {
            allValid = false;
        }
    }

    return allValid;
}

let textRuleFieldIdSeq = 0;

function createTextRuleRow(site = "", text = "", style = "blocked") {
    const row = document.createElement("tr");
    const idSuffix = `tr-${++textRuleFieldIdSeq}`;

    const siteCell = document.createElement("td");
    const siteInput = document.createElement("input");
    siteInput.type = "text";
    siteInput.className = "textRuleSite";
    siteInput.value = site;
    siteInput.placeholder = "example.com";
    siteInput.setAttribute("aria-label", "Site");
    siteInput.setAttribute("aria-describedby", `${idSuffix}-site-error`);
    siteInput.autocomplete = "off";
    const siteError = createFieldError(`${idSuffix}-site-error`);
    siteCell.append(siteInput, siteError);

    const textCell = document.createElement("td");
    const textInput = document.createElement("input");
    textInput.type = "text";
    textInput.className = "textRuleText";
    textInput.value = text;
    textInput.placeholder = "company or keyword";
    textInput.setAttribute("aria-label", "Text");
    textInput.setAttribute("aria-describedby", `${idSuffix}-text-error`);
    textInput.autocomplete = "off";
    const textError = createFieldError(`${idSuffix}-text-error`);
    textCell.append(textInput, textError);

    const styleCell = document.createElement("td");
    const styleSelect = document.createElement("select");
    styleSelect.className = "textRuleStyle";
    styleSelect.setAttribute("aria-label", "Style");
    populateStyleSelect(styleSelect, style || "blocked");
    styleCell.appendChild(styleSelect);

    const actionCell = document.createElement("td");
    actionCell.appendChild(createRowActions(
        createDeleteButton(() => {
            row.remove();
            validateAllTextRuleRows();
            refreshAllTableEmptyStates();
        })
    ));

    const scheduleValidate = () => {
        validateAllTextRuleRows();
    };
    siteInput.addEventListener("input", scheduleValidate);
    siteInput.addEventListener("blur", scheduleValidate);
    textInput.addEventListener("input", scheduleValidate);
    textInput.addEventListener("blur", scheduleValidate);

    row.append(siteCell, textCell, styleCell, actionCell);
    document.querySelector("#textRuleBody").appendChild(row);
    validateAllTextRuleRows();
    refreshAllTableEmptyStates();
}

function getTextRuleRowState(row) {
    const siteInput = row.querySelector(".textRuleSite");
    const textInput = row.querySelector(".textRuleText");
    const siteRaw = siteInput?.value.trim() || "";
    const textRaw = textInput?.value.trim() || "";
    const normalizedSite = siteRaw ? normalizeSite(siteRaw) : "";

    return {
        siteInput,
        textInput,
        siteError: siteInput?.parentElement?.querySelector(".fieldError"),
        textError: textInput?.parentElement?.querySelector(".fieldError"),
        siteRaw,
        textRaw,
        normalizedSite,
        isBlank: !siteRaw && !textRaw
    };
}

function validateAllTextRuleRows() {
    const rows = Array.from(document.querySelectorAll("#textRuleBody tr"))
        .map(getTextRuleRowState)
        .filter(state => state.siteInput && state.textInput);

    const seenKeys = new Map();
    let allValid = true;

    for (let index = 0; index < rows.length; index++) {
        const state = rows[index];
        let siteMessage = "";
        let textMessage = "";

        if (state.isBlank) {
            setFieldError(state.siteInput, state.siteError, "");
            setFieldError(state.textInput, state.textError, "");
            continue;
        }

        if (!state.siteRaw) {
            siteMessage = "Enter a site hostname.";
        } else if (!isPlausibleHostname(state.siteRaw)) {
            siteMessage = "Enter a valid hostname (example.com).";
        }

        if (!state.textRaw) {
            textMessage = "Enter text to match.";
        }

        if (!siteMessage && !textMessage && state.normalizedSite) {
            const key = `${state.normalizedSite}\u0000${state.textRaw.toLowerCase()}`;
            if (seenKeys.has(key)) {
                textMessage = "Duplicate text for this site.";
            } else {
                seenKeys.set(key, index);
            }
        }

        setFieldError(state.siteInput, state.siteError, siteMessage);
        setFieldError(state.textInput, state.textError, textMessage);

        if (siteMessage || textMessage) {
            allValid = false;
        }
    }

    return allValid;
}

function restoreOptions() {
    suppressOptionsStorageReload = true;
    suppressDirtyTracking = true;
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

        document.querySelector("#enableToastNotifications").checked =
            result.enableToastNotifications !== false;

        applyGettingStartedVisibility(!!result[STORAGE_KEYS.hideGettingStarted]);

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
        STORAGE_KEYS.enableToastNotifications,
        STORAGE_KEYS.hideGettingStarted,
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
        suppressDirtyTracking = false;
        updateDirtyUi();
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
        if (isFormDirty()) {
            showExternalOptionsChangeNotice();
            return;
        }
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

        if (Object.prototype.hasOwnProperty.call(changes, STORAGE_KEYS.hideGettingStarted)) {
            applyGettingStartedVisibility(!!changes[STORAGE_KEYS.hideGettingStarted].newValue);
        }

        const relevant = Object.keys(changes).some(key =>
            CONFIG_REFRESH_STORAGE_KEYS.includes(key) ||
            Object.values(LEGACY_STORAGE_KEYS).includes(key) ||
            key === STORAGE_KEYS.enableToastNotifications
        );
        if (relevant) {
            scheduleOptionsStorageReload();
        }
    });

    document.querySelector("#gettingStartedDismiss")?.addEventListener(
        "click",
        dismissGettingStarted
    );
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
        enableToastNotifications: document.querySelector("#enableToastNotifications").checked,
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
            data.enableToastNotifications !== undefined &&
            typeof data.enableToastNotifications !== "boolean"
        ) {
            throw new Error("Invalid enableToastNotifications");
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
        showStatus("Import failed", {
            isError: true,
            actions: [
                {
                    label: "Try again",
                    onClick: () => importFromFile()
                }
            ]
        });
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

    if (data.enableToastNotifications !== undefined) {
        document.querySelector("#enableToastNotifications").checked =
            data.enableToastNotifications;
    }

    return loadBookmarkRuleRows(migrateBookmarkRulesFromStorage(data)).then(() => {
        return persistOptionsFromForm({
            successMessage: "Imported and saved configuration",
            setBusy: false
        });
    }).catch(err => {
        console.error("Import failed:", err);
        showStatus("Import loaded into form but could not save", {
            isError: true,
            actions: [
                {
                    label: "Retry save",
                    onClick: () => persistOptionsFromForm({
                        successMessage: "Imported and saved configuration"
                    })
                },
                {
                    label: "Open Sites",
                    onClick: () => activateOptionsTab("sites")
                }
            ]
        });
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
            showStatus("Could not read import file", {
                isError: true,
                actions: [
                    {
                        label: "Try again",
                        onClick: () => importFromFile()
                    }
                ]
            });
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

function hideStatus() {
    const toast = document.querySelector("#statusToast");
    if (!toast) return;
    toast.classList.remove("visible");
    toast.hidden = true;
    clearTimeout(statusTimeout);
    statusTimeout = null;
}

/**
 * @param {string} message
 * @param {boolean|{
 *   isError?: boolean,
 *   warning?: boolean,
 *   duration?: number,
 *   dismissible?: boolean,
 *   actions?: Array<{ label: string, onClick?: () => void }>
 * }} [options]
 */
function showStatus(message, options = false) {
    const toast = document.querySelector("#statusToast");
    if (!toast) return;

    const opts = typeof options === "boolean"
        ? { isError: options }
        : (options || {});
    const isError = !!opts.isError;
    const isWarning = !!opts.warning;
    const actions = Array.isArray(opts.actions) ? opts.actions : [];
    const dismissible = opts.dismissible !== false;
    const duration = typeof opts.duration === "number"
        ? opts.duration
        : (actions.length > 0 ? 12000 : (isError || isWarning ? 6000 : 3000));

    toast.classList.toggle("error", isError && !isWarning);
    toast.classList.toggle("warning", isWarning);
    toast.replaceChildren();

    const body = document.createElement("div");
    body.className = "statusToastBody";

    const messageEl = document.createElement("p");
    messageEl.className = "statusToastMessage";
    messageEl.textContent = message;
    body.appendChild(messageEl);

    if (actions.length > 0) {
        const actionsEl = document.createElement("div");
        actionsEl.className = "statusToastActions";
        for (const action of actions) {
            if (!action?.label) continue;
            const button = document.createElement("button");
            button.type = "button";
            button.textContent = action.label;
            button.addEventListener("click", () => {
                hideStatus();
                try {
                    action.onClick?.();
                } catch (err) {
                    console.error("Toast action failed:", err);
                }
            });
            actionsEl.appendChild(button);
        }
        body.appendChild(actionsEl);
    }

    toast.appendChild(body);

    if (dismissible) {
        const dismissBtn = document.createElement("button");
        dismissBtn.type = "button";
        dismissBtn.className = "statusToastDismiss";
        dismissBtn.setAttribute("aria-label", "Dismiss notification");
        dismissBtn.title = "Dismiss";
        dismissBtn.textContent = "×";
        dismissBtn.addEventListener("click", hideStatus);
        toast.appendChild(dismissBtn);
    }

    toast.hidden = false;
    toast.classList.add("visible");

    clearTimeout(statusTimeout);
    statusTimeout = setTimeout(() => {
        hideStatus();
    }, duration);
}

function activateOptionsTab(tabId) {
    const tabs = Array.from(document.querySelectorAll('[role="tab"][data-tab]'));
    const panels = Array.from(document.querySelectorAll("[data-tab-panel]"));
    const alreadySelected = tabs.some(
        tab => tab.dataset.tab === tabId && tab.getAttribute("aria-selected") === "true"
    );

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

    if (tabId === "folders" || tabId === "sites" || tabId === "looks") {
        refreshAllStyleSelects();
    }

    if (!alreadySelected) {
        window.scrollTo(0, 0);
    }
}

function setupStickyTabShadow() {
    const tabList = document.querySelector(".tabList");
    const sentinel = document.querySelector(".tabListSentinel");
    if (!tabList || !sentinel || typeof IntersectionObserver !== "function") return;

    const observer = new IntersectionObserver(entries => {
        const entry = entries[0];
        tabList.classList.toggle("is-stuck", !!(entry && !entry.isIntersecting));
    });
    observer.observe(sentinel);
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

function setupTabJumps() {
    document.addEventListener("click", event => {
        const target = event.target instanceof Element ? event.target : null;
        const jump = target?.closest("[data-open-tab]");
        if (!jump) return;
        const tabId = jump.getAttribute("data-open-tab");
        if (!tabId) return;
        event.preventDefault();
        activateOptionsTab(tabId);
        document.querySelector(`[role="tab"][data-tab="${tabId}"]`)?.focus();
    });
}

function setupEventListeners() {
    try {
        setupOptionsTabs();
        setupStickyTabShadow();
        setupTabJumps();
        setupFolderComboboxDismiss();
        setupDirtyTracking();

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
        if (addUrlRuleBtn) {
            addUrlRuleBtn.addEventListener("click", () => {
                openAdvancedSiteRules();
                createUrlRuleRow();
            });
        }
        if (addTextRuleBtn) {
            addTextRuleBtn.addEventListener("click", () => {
                openAdvancedSiteRules();
                createTextRuleRow();
            });
        }
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
