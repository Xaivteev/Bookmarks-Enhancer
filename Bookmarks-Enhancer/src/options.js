const STYLE_RULE_STORAGE_KEY = STORAGE_KEYS.styleRules;

let cachedStyleRules = DEFAULT_STYLE_RULES.map(rule => ({ ...rule }));
let sitesDraft = [];
let selectedSiteIndex = -1;
let detailLinksByLook = null;
let sitesReady = false;
let suppressOptionsStorageReload = false;
let optionsStorageReloadTimer = null;
let previewStyleId = "";
let suppressDirtyTracking = false;
let savedFormSnapshot = null;
let dirtyUiSyncTimer = null;
const OPTIONS_DOC_TITLE = "Bookmarks Enhancer Options";
const DIRTY_CLICK_SELECTOR = [
    "#addSiteBtn",
    "#addClassGroupBtn",
    ".addSavedLinkBtn",
    "#addLinkFolderBtn",
    "#addTextRuleBtn",
    "#addStyleRuleBtn",
    "#siteDetailBack",
    ".rowDeleteBtn",
    ".siteListOpen"
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
    syncTableEmptyState("#classGroupBody", "#classGroupsEmpty");
    syncTableEmptyState("#textRuleBody", "#textRulesEmpty");
    refreshSavedLinkGroupEmptyStates();
    refreshSitesEmptyState();
}

function refreshSitesEmptyState() {
    const empty = document.querySelector("#sitesEmpty");
    const searchEmpty = document.querySelector("#sitesSearchEmpty");
    const list = document.querySelector("#siteList");
    if (!empty || !list) return;
    const hasSites = sitesDraft.length > 0;
    const visibleCount = list.children.length;
    const query = getSiteSearchQuery();
    empty.hidden = hasSites;
    if (searchEmpty) {
        searchEmpty.hidden = !hasSites || !query || visibleCount > 0;
    }
    list.hidden = visibleCount === 0;
}

function getSiteSearchQuery() {
    return (document.querySelector("#searchSitesInput")?.value || "").trim().toLowerCase();
}

function siteMatchesSearch(siteConfig, query) {
    if (!query) return true;
    const host = (siteConfig?.site || "").toLowerCase();
    if (host.includes(query)) return true;
    const normalizedQuery = normalizeSite(query);
    return !!normalizedQuery && host.includes(normalizedQuery);
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
    if (previewStyleId && rules.some(rule => rule.id === previewStyleId)) {
        return previewStyleId;
    }
    return rules.find(rule => !styleRuleHidesElements(rule))?.id ||
        rules[0]?.id ||
        "";
}

function getAvailableStyleRules() {
    return normalizeStyleRules(collectStyleRules());
}

function populateStyleSelect(select, selectedId = "blocked", { includeNone = false } = {}) {
    if (!select) return;
    const styleRules = getAvailableStyleRules();
    const current = selectedId || "";
    select.replaceChildren();

    if (includeNone) {
        const noneOption = document.createElement("option");
        noneOption.value = "";
        noneOption.textContent = "None";
        select.appendChild(noneOption);
    }

    for (const rule of styleRules) {
        const option = document.createElement("option");
        option.value = rule.id;
        option.textContent = rule.name || rule.id;
        select.appendChild(option);
    }

    if (current && ![...select.options].some(option => option.value === current)) {
        const missingOption = document.createElement("option");
        missingOption.value = current;
        missingOption.textContent = `Missing style (${current})`;
        select.appendChild(missingOption);
    }

    select.value = current;
}

function refreshAllStyleSelects() {
    cachedStyleRules = normalizeStyleRules(collectStyleRules());
    for (const select of document.querySelectorAll(
        ".textRuleStyle, .savedLinkMove, .savedLinkGroupLook, #legacyImportLook"
    )) {
        populateStyleSelect(select, select.value);
    }
    const legacyLook = document.querySelector("#legacyImportLook");
    if (legacyLook && !legacyLook.value && legacyLook.options.length > 0) {
        legacyLook.selectedIndex = 0;
    }
    updateStylePreview();
    syncSavedLinkGroupsToLooks();
}

function buildScopedStylePreviewCss(styleRules) {
    return (styleRules || []).map(rule => {
        const declarations = getStyleRuleDeclarations(rule).trim();
        if (!declarations) return "";
        const className = styleRuleClassName(rule);
        return `#stylePreviewRoot .${className} {\n\t${declarations}\n}`;
    }).filter(Boolean).join("\n");
}

function getStyleRulesForPreview() {
    return normalizeStyleRules(collectStyleRules());
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
    previewStyleId = getDefaultPreviewStyleId(styleRules);
    const selectedRule = styleRules.find(rule => rule.id === previewStyleId);

    clearPreviewStyleClasses(link);
    clearPreviewStyleClasses(card);
    if (selectedRule) {
        const className = styleRuleClassName(selectedRule);
        link.classList.add(className);
        card.classList.add(className);
    }
    if (activeLabel) {
        activeLabel.textContent = selectedRule?.name || "";
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
        const iconSelect = row.querySelector(".styleRuleShortcutIcon");
        const colorInput = row.querySelector(".styleRuleShortcutColor");
        const kind = kindSelect?.value === "custom" ? "custom" : "predefined";
        const predefined = kind === "predefined" ? (kindSelect?.value || "blocked") : "";
        return {
            id: row.dataset.styleId || createStyleRuleId(),
            name: nameInput?.value.trim() || "",
            kind,
            predefined: predefined === "favorited" || predefined === "seen" ? predefined : (kind === "predefined" ? "blocked" : ""),
            css: cssInput?.value || "",
            shortcutIcon: iconSelect?.value || "",
            shortcutColor: colorInput?.value || ""
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

function usedShortcutIcons(exceptRow = null) {
    const used = new Set();
    for (const row of document.querySelectorAll("#styleRuleBody tr")) {
        if (row === exceptRow) continue;
        const value = row.querySelector(".styleRuleShortcutIcon")?.value;
        if (value) used.add(value);
    }
    return used;
}

function updateStyleRuleShortcutPreview(row) {
    const preview = row.querySelector(".styleRuleShortcutPreview");
    const iconSelect = row.querySelector(".styleRuleShortcutIcon");
    const colorInput = row.querySelector(".styleRuleShortcutColor");
    if (!preview) return;
    const icon = iconSelect?.value || "";
    const color = colorInput?.value || DEFAULT_SHORTCUT_COLOR;
    preview.innerHTML = icon ? shortcutIconSvgMarkup(icon, { active: false, color }) : "";
    preview.hidden = !icon;
}

function refreshShortcutIconOptions() {
    for (const row of document.querySelectorAll("#styleRuleBody tr")) {
        const select = row.querySelector(".styleRuleShortcutIcon");
        if (!select) continue;
        const used = usedShortcutIcons(row);
        for (const option of select.options) {
            if (!option.value) continue;
            option.disabled = used.has(option.value);
        }
        updateStyleRuleShortcutPreview(row);
    }
}

function createStyleRuleRow(rule = null) {
    const styleRule = rule || {
        id: createStyleRuleId(),
        name: "",
        kind: "predefined",
        predefined: "blocked",
        css: "",
        shortcutIcon: "",
        shortcutColor: DEFAULT_SHORTCUT_COLOR
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
            refreshShortcutIconOptions();
            refreshAllTableEmptyStates();
        })
    ));

    const shortcutCell = document.createElement("td");
    shortcutCell.className = "styleRuleShortcutCell";
    const shortcutWrap = document.createElement("div");
    shortcutWrap.className = "styleRuleShortcut";

    const iconSelect = document.createElement("select");
    iconSelect.className = "styleRuleShortcutIcon";
    iconSelect.setAttribute("aria-label", "Shortcut icon");
    const noneOption = document.createElement("option");
    noneOption.value = "";
    noneOption.textContent = "None";
    iconSelect.appendChild(noneOption);
    for (const iconId of SHORTCUT_ICON_IDS) {
        const option = document.createElement("option");
        option.value = iconId;
        option.textContent = SHORTCUT_ICON_LABELS[iconId];
        if ((styleRule.shortcutIcon || "") === iconId) option.selected = true;
        iconSelect.appendChild(option);
    }
    iconSelect.addEventListener("change", refreshShortcutIconOptions);

    const colorInput = document.createElement("input");
    colorInput.type = "color";
    colorInput.className = "styleRuleShortcutColor";
    colorInput.value = normalizeShortcutColor(styleRule.shortcutColor) || DEFAULT_SHORTCUT_COLOR;
    colorInput.setAttribute("aria-label", "Shortcut color");
    colorInput.addEventListener("input", () => updateStyleRuleShortcutPreview(row));

    const preview = document.createElement("span");
    preview.className = "styleRuleShortcutPreview";
    preview.setAttribute("aria-hidden", "true");

    shortcutWrap.append(preview, iconSelect, colorInput);
    shortcutCell.appendChild(shortcutWrap);

    row.append(nameCell, kindCell, cssCell, shortcutCell, actionCell);
    document.querySelector("#styleRuleBody").appendChild(row);
    updateStyleRuleRowVisibility(row);
    refreshShortcutIconOptions();
    refreshAllTableEmptyStates();
}

function loadStyleRuleRows(rules) {
    clearStyleRuleTable();
    cachedStyleRules = Array.isArray(rules)
        ? normalizeStyleRules(rules)
        : DEFAULT_STYLE_RULES.map(rule => ({ ...rule }));
        cachedStyleRules.forEach(rule => createStyleRuleRow(rule));
    refreshAllStyleSelects();
    refreshAllTableEmptyStates();
}

function setFieldError(input, errorEl, message) {
    if (input) {
        input.classList.toggle("fieldInvalid", !!message);
        if (message) {
            input.setAttribute("aria-invalid", "true");
        } else {
            input.removeAttribute("aria-invalid");
        }
    }
    if (errorEl) {
        errorEl.textContent = message || "";
        errorEl.hidden = !message;
    }
}

function createFieldError(errorId) {
    const errorEl = document.createElement("p");
    errorEl.className = "fieldError";
    errorEl.id = errorId;
    errorEl.hidden = true;
    return errorEl;
}

function showRowValidationError(tabId, selector, message, actionLabel, extra = {}) {
    showStatus(message, {
        isError: true,
        actions: [
            {
                label: actionLabel,
                onClick: () => {
                    if (typeof extra.openSiteIndex === "number") {
                        activateOptionsTab("sites");
                        openSiteDetail(extra.openSiteIndex);
                    } else {
                        activateOptionsTab(tabId);
                    }
                    const field = document.querySelector(selector);
                    field?.focus();
                    field?.scrollIntoView({ behavior: "smooth", block: "center" });
                }
            }
        ]
    });
}

function formatCount(count, singular, plural = `${singular}s`) {
    return `${count} ${count === 1 ? singular : plural}`;
}

function siteSummary(siteConfig) {
    const groups = siteConfig.classGroups?.length || 0;
    const links = siteConfig.links?.length || 0;
    const texts = siteConfig.textRules?.length || 0;
    return [
        formatCount(groups, "class group"),
        formatCount(links, "saved link"),
        formatCount(texts, "text rule")
    ].join(" · ");
}

function isSiteDetailOpen() {
    return selectedSiteIndex >= 0;
}

function collectClassGroupsFromDetail() {
    return Array.from(document.querySelectorAll("#classGroupBody tr")).map(row =>
        row.querySelector(".classGroupInput")?.value || ""
    );
}

function collectLinkFoldersFromDetail() {
    return Array.from(document.querySelectorAll(".savedLinkGroup"))
        .map(group => group.dataset.styleId)
        .filter(Boolean);
}

function collectSavedLinksFromDetail() {
    for (const group of document.querySelectorAll(".savedLinkGroup")) {
        flushSavedLinkGroupPage(group);
    }
    return sitesDraft[selectedSiteIndex]?.links || [];
}

function collectTextRulesFromDetail() {
    return Array.from(document.querySelectorAll("#textRuleBody tr")).map(row => ({
        text: row.querySelector(".textRuleText")?.value.trim() || "",
        style: row.querySelector(".textRuleStyle")?.value || "blocked"
    })).filter(rule => rule.text);
}

function bumpLinksRevision(site) {
    if (!site) return;
    site.linksRevision = (site.linksRevision || 0) + 1;
}

function flushSiteDetailToDraft() {
    if (!isSiteDetailOpen() || !sitesDraft[selectedSiteIndex]) return;
    const hostInput = document.querySelector("#siteDetailHost");
    const keepParamsInput = document.querySelector("#siteKeepParams");
    const current = sitesDraft[selectedSiteIndex];
    const nextHost = normalizeSite(hostInput?.value || current.site) || current.site;
    for (const group of document.querySelectorAll(".savedLinkGroup")) {
        flushSavedLinkGroupPage(group);
    }
    current.site = nextHost;
    current.classGroups = collectClassGroupsFromDetail();
    current.keepParams = keepParamsInput?.value || "";
    current.textRules = collectTextRulesFromDetail();
    current.linkFolders = collectLinkFoldersFromDetail();
}

function collectSitesFromUi() {
    flushSiteDetailToDraft();
    return sitesDraft;
}

function clearDetailTables() {
    document.querySelector("#classGroupBody")?.replaceChildren();
    document.querySelector("#savedLinkGroups")?.replaceChildren();
    document.querySelector("#textRuleBody")?.replaceChildren();
}

function siteLinkCount(siteConfig) {
    return siteConfig?.links?.length || 0;
}

function compareSitesForList(a, b) {
    const linksDelta = siteLinkCount(b) - siteLinkCount(a);
    if (linksDelta !== 0) return linksDelta;
    return (a.site || "").localeCompare(b.site || "");
}

function renderSiteList() {
    const list = document.querySelector("#siteList");
    if (!list) return;
    list.replaceChildren();

    const query = getSiteSearchQuery();
    sitesDraft
        .map((siteConfig, index) => ({ siteConfig, index }))
        .filter(({ siteConfig }) => siteMatchesSearch(siteConfig, query))
        .sort((a, b) => compareSitesForList(a.siteConfig, b.siteConfig))
        .forEach(({ siteConfig, index }) => {
        const item = document.createElement("li");
        item.className = "siteListItem";

        const openBtn = document.createElement("button");
        openBtn.type = "button";
        openBtn.className = "siteListOpen";
        openBtn.setAttribute("aria-label", `Edit ${siteConfig.site}`);

        const host = document.createElement("span");
        host.className = "siteListHost";
        host.textContent = siteConfig.site;

        const meta = document.createElement("span");
        meta.className = "siteListMeta";
        meta.textContent = siteSummary(siteConfig);

        openBtn.append(host, meta);
        openBtn.addEventListener("click", () => openSiteDetail(index));

        const deleteWrap = document.createElement("div");
        deleteWrap.className = "siteListDelete";
        deleteWrap.appendChild(createDeleteButton(() => deleteSite(index)));

        item.append(openBtn, deleteWrap);
        list.appendChild(item);
    });

    refreshSitesEmptyState();
}

function showSiteListView() {
    const listView = document.querySelector("#siteListView");
    const detailView = document.querySelector("#siteDetailView");
    if (listView) listView.hidden = false;
    if (detailView) detailView.hidden = true;
    selectedSiteIndex = -1;
    renderSiteList();
}

function openSiteDetail(index) {
    if (index < 0 || index >= sitesDraft.length) return;
    if (isSiteDetailOpen() && index !== selectedSiteIndex) {
        flushSiteDetailToDraft();
    }

    selectedSiteIndex = index;
    const siteConfig = sitesDraft[index];
    rebuildDetailLinksIndex();
    const listView = document.querySelector("#siteListView");
    const detailView = document.querySelector("#siteDetailView");
    if (listView) listView.hidden = true;
    if (detailView) detailView.hidden = false;

    const hostInput = document.querySelector("#siteDetailHost");
    const keepParamsInput = document.querySelector("#siteKeepParams");
    if (hostInput) hostInput.value = siteConfig.site || "";
    if (keepParamsInput) keepParamsInput.value = siteConfig.keepParams || "";
    setFieldError(hostInput, document.querySelector("#siteDetailHostError"), "");
    setFieldError(keepParamsInput, document.querySelector("#siteKeepParamsError"), "");

    clearDetailTables();
    (siteConfig.classGroups || []).forEach(group => createClassGroupRow(group));
    (siteConfig.textRules || []).forEach(rule =>
        createTextRuleRow(rule.text, rule.style)
    );
    renderSavedLinkGroups(siteConfig.links || [], siteConfig.linkFolders || []);
    refreshAllStyleSelects();
    refreshAllTableEmptyStates();
    window.scrollTo(0, 0);
}

function closeSiteDetail() {
    flushSiteDetailToDraft();
    detailLinksByLook = null;
    showSiteListView();
    scheduleDirtyUiUpdate();
}

function deleteSite(index) {
    const siteConfig = sitesDraft[index];
    if (!siteConfig) return;
    const confirmed = window.confirm(
        `Delete ${siteConfig.site} and its class groups, saved links, and text rules?`
    );
    if (!confirmed) return;
    if (selectedSiteIndex === index) {
        selectedSiteIndex = -1;
        detailLinksByLook = null;
        showSiteListView();
    } else if (selectedSiteIndex > index) {
        selectedSiteIndex -= 1;
    }
    sitesDraft.splice(index, 1);
    renderSiteList();
    scheduleDirtyUiUpdate();
}

function addSiteFromInput() {
    const input = document.querySelector("#addSiteInput");
    const errorEl = document.querySelector("#addSiteError");
    const raw = input?.value.trim() || "";
    if (!raw) {
        setFieldError(input, errorEl, "Enter a site hostname.");
        input?.focus();
        return;
    }
    if (!isPlausibleHostname(raw)) {
        setFieldError(input, errorEl, "Enter a valid hostname (example.com).");
        input?.focus();
        return;
    }
    const hostname = normalizeSite(raw);
    if (sitesDraft.some(siteConfig => siteConfig.site === hostname)) {
        setFieldError(input, errorEl, "That website is already in the list.");
        input?.focus();
        return;
    }
    setFieldError(input, errorEl, "");
    if (input) input.value = "";
    sitesDraft.push(createEmptySiteConfig(hostname));
    sitesDraft.sort((a, b) => a.site.localeCompare(b.site));
    const index = sitesDraft.findIndex(siteConfig => siteConfig.site === hostname);
    openSiteDetail(index);
    scheduleDirtyUiUpdate();
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
            folders.push({
                id: node.id,
                label: nextPath,
                groupTitle: nextGroup.title
            });
        }

        if (Array.isArray(node.children)) {
            folders.push(...flattenBookmarkFolders(node.children, nextPath, nextGroup));
        }
    }

    return folders;
}

function populateLegacyImportFolderSelect(folders) {
    const select = document.querySelector("#legacyImportFolder");
    if (!select) return;
    const previous = select.value;
    select.replaceChildren();

    if (!folders || folders.length === 0) {
        const option = document.createElement("option");
        option.value = "";
        option.textContent = "No bookmark folders found";
        select.appendChild(option);
        select.disabled = true;
        return;
    }

    select.disabled = false;
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "Select a folder";
    select.appendChild(placeholder);

    const groups = new Map();
    for (const folder of folders) {
        const groupTitle = folder.groupTitle || "Other";
        if (!groups.has(groupTitle)) groups.set(groupTitle, []);
        groups.get(groupTitle).push(folder);
    }

    for (const [groupTitle, groupFolders] of groups) {
        const optgroup = document.createElement("optgroup");
        optgroup.label = groupTitle;
        for (const folder of groupFolders) {
            const option = document.createElement("option");
            option.value = folder.id;
            option.textContent = folder.label;
            optgroup.appendChild(option);
        }
        select.appendChild(optgroup);
    }

    if (previous && [...select.options].some(option => option.value === previous)) {
        select.value = previous;
    }
}

function loadLegacyImportFolders() {
    const select = document.querySelector("#legacyImportFolder");
    if (!select) return Promise.resolve();
    if (!browser.bookmarks || typeof browser.bookmarks.getTree !== "function") {
        populateLegacyImportFolderSelect([]);
        return Promise.resolve();
    }

    return browser.bookmarks.getTree()
        .then(tree => {
            populateLegacyImportFolderSelect(flattenBookmarkFolders(tree));
        })
        .catch(error => {
            console.error("Could not load bookmark folders:", error);
            populateLegacyImportFolderSelect([]);
        });
}

function importLegacyBookmarkFolder() {
    const folderSelect = document.querySelector("#legacyImportFolder");
    const lookSelect = document.querySelector("#legacyImportLook");
    const errorEl = document.querySelector("#legacyImportError");
    const folderId = folderSelect?.value || "";
    const styleId = lookSelect?.value || "";

    if (!folderId) {
        setFieldError(folderSelect, errorEl, "Choose a bookmark folder to import.");
        folderSelect?.focus();
        return;
    }
    if (!styleId) {
        setFieldError(lookSelect, errorEl, "Choose a look, or add one on the Looks tab.");
        lookSelect?.focus();
        return;
    }
    setFieldError(folderSelect, errorEl, "");
    setFieldError(lookSelect, errorEl, "");

    flushSiteDetailToDraft();
    const openHost = isSiteDetailOpen() ? sitesDraft[selectedSiteIndex]?.site : "";
    const button = document.querySelector("#legacyImportBtn");
    if (button) {
        button.disabled = true;
        button.textContent = "Importing…";
    }

    importBookmarkFolderIntoSites(sitesDraft, folderId, styleId)
        .then(result => {
            sitesDraft = result.sites;
            try {
                if (openHost) {
                    const index = sitesDraft.findIndex(siteConfig => siteConfig.site === openHost);
                    if (index >= 0) {
                        openSiteDetail(index);
                    } else {
                        showSiteListView();
                    }
                } else {
                    renderSiteList();
                }
                scheduleDirtyUiUpdate();
            } catch (uiError) {
                console.error("Bookmark folder import UI update failed:", uiError);
            }

            if (result.sitesTouched === 0) {
                showStatus("No http(s) bookmarks found in that folder", true);
                return;
            }

            const parts = [
                `Added ${formatCount(result.linksAdded, "link")} across ${formatCount(result.sitesTouched, "site")}`
            ];
            if (result.sitesCreated > 0) {
                parts.push(`${formatCount(result.sitesCreated, "new site")}`);
            }
            if (result.linksSkipped > 0) {
                parts.push(`${formatCount(result.linksSkipped, "duplicate")} skipped`);
            }
            showStatus(`${parts.join(". ")}. Save to apply.`);
        })
        .catch(error => {
            console.error("Bookmark folder import failed:", error);
            const detail = error && error.message ? error.message : String(error);
            showStatus(`Could not import that bookmark folder: ${detail}`, true);
        })
        .finally(() => {
            if (button) {
                button.disabled = false;
                button.textContent = "Import folder";
            }
        });
}

let classGroupFieldIdSeq = 0;
function createClassGroupRow(classes = "") {
    const row = document.createElement("tr");
    const idSuffix = `cg-${++classGroupFieldIdSeq}`;

    const classesCell = document.createElement("td");
    const input = document.createElement("input");
    input.type = "text";
    input.className = "classGroupInput";
    input.value = classes;
    input.placeholder = "job-card-container";
    input.setAttribute("aria-label", "Class group");
    input.setAttribute("aria-describedby", `${idSuffix}-error`);
    input.autocomplete = "off";
    const errorEl = createFieldError(`${idSuffix}-error`);
    classesCell.append(input, errorEl);

    const actionCell = document.createElement("td");
    actionCell.appendChild(createRowActions(
        createDeleteButton(() => {
            row.remove();
            validateSiteDetail();
            refreshAllTableEmptyStates();
        })
    ));

    input.addEventListener("input", () => validateSiteDetail());
    input.addEventListener("blur", () => validateSiteDetail());

    row.append(classesCell, actionCell);
    document.querySelector("#classGroupBody").appendChild(row);
    refreshAllTableEmptyStates();
}

let savedLinkFieldIdSeq = 0;
const SAVED_LINK_PAGE_SIZE = 100;

function getLookLabel(styleId) {
    const rules = getAvailableStyleRules();
    const rule = rules.find(entry => entry.id === styleId);
    if (rule?.name) return rule.name;
    return styleId ? `Missing look (${styleId})` : "Look";
}

function rebuildDetailLinksIndex() {
    detailLinksByLook = new Map();
    const site = sitesDraft[selectedSiteIndex];
    if (!site) return;
    for (const link of site.links || []) {
        const id = link.style || "blocked";
        if (!detailLinksByLook.has(id)) detailLinksByLook.set(id, []);
        detailLinksByLook.get(id).push(link);
    }
}

function flattenDetailLinksToSite() {
    const site = sitesDraft[selectedSiteIndex];
    if (!site || !detailLinksByLook) return;
    const merged = [];
    const seen = new Set();
    for (const styleId of site.linkFolders || []) {
        const lookLinks = detailLinksByLook.get(styleId) || [];
        merged.push(...lookLinks);
        seen.add(styleId);
    }
    for (const [styleId, lookLinks] of detailLinksByLook) {
        if (seen.has(styleId)) continue;
        merged.push(...lookLinks);
    }
    site.links = merged;
}

function linksForLook(styleId) {
    if (detailLinksByLook && styleId) {
        return detailLinksByLook.get(styleId) || [];
    }
    const site = sitesDraft[selectedSiteIndex];
    if (!site || !styleId) return [];
    return (site.links || []).filter(link => (link.style || "blocked") === styleId);
}

function replaceLinksForLook(styleId, lookLinks) {
    const site = sitesDraft[selectedSiteIndex];
    if (!site || !styleId) return;
    const nextLook = (lookLinks || []).map(link => ({
        url: typeof link.url === "string" ? link.url : "",
        title: typeof link.title === "string" ? link.title : "",
        style: styleId
    }));
    if (!detailLinksByLook) detailLinksByLook = new Map();
    detailLinksByLook.set(styleId, nextLook);
    flattenDetailLinksToSite();
    bumpLinksRevision(site);
}

function commitLookIndexToSite() {
    const site = sitesDraft[selectedSiteIndex];
    if (!site || !detailLinksByLook) return;
    site.linkFolders = collectLinkFoldersFromDetail();
    flattenDetailLinksToSite();
    bumpLinksRevision(site);
}

function collectVisibleSavedLinkRows(group) {
    return Array.from(group.querySelectorAll("tbody tr")).map(row => ({
        url: row.querySelector(".savedLinkUrl")?.value.trim() || "",
        title: row.querySelector(".savedLinkTitle")?.value.trim() || "",
        style: group.dataset.styleId || "blocked",
        lookIndex: Number(row.dataset.lookIndex)
    }));
}

function getGroupLinkSearchQuery(group) {
    return (group.querySelector(".savedLinkSearchInput")?.value || "").trim().toLowerCase();
}

function savedLinkMatchesSearch(link, query) {
    if (!query) return true;
    const url = (link?.url || "").toLowerCase();
    const title = (link?.title || "").toLowerCase();
    return url.includes(query) || title.includes(query);
}

function filteredLookEntries(group) {
    const query = getGroupLinkSearchQuery(group);
    return linksForLook(group.dataset.styleId).map((link, lookIndex) => ({ link, lookIndex }))
        .filter(({ link }) => savedLinkMatchesSearch(link, query));
}

function flushSavedLinkGroupPage(group) {
    if (!group || group.dataset.expanded !== "true" || !group.querySelector("tbody")) {
        return;
    }
    const styleId = group.dataset.styleId;
    if (!styleId) return;
    const all = linksForLook(styleId);
    for (const row of collectVisibleSavedLinkRows(group)) {
        if (!Number.isInteger(row.lookIndex) || row.lookIndex < 0 || row.lookIndex >= all.length) {
            continue;
        }
        const current = all[row.lookIndex];
        if (current) {
            current.url = row.url;
            current.title = row.title;
            current.style = styleId;
        } else {
            all[row.lookIndex] = {
                url: row.url,
                title: row.title,
                style: styleId
            };
        }
    }
}

function refreshSavedLinkGroupEmptyStates() {
    const groups = document.querySelectorAll(".savedLinkGroup");
    const globalEmpty = document.querySelector("#savedLinksEmpty");
    if (globalEmpty) {
        globalEmpty.hidden = groups.length > 0;
    }

    for (const group of groups) {
        updateSavedLinkGroupMeta(group);
        const moveSelects = group.querySelectorAll(".savedLinkMove");
        for (const select of moveSelects) {
            if (select.value !== group.dataset.styleId) {
                populateStyleSelect(select, group.dataset.styleId);
            }
        }
    }
    refreshAddLinkFolderSelect();
}

function updateSavedLinkGroupMeta(group) {
    const styleId = group.dataset.styleId;
    const total = linksForLook(styleId).length;
    const expanded = group.dataset.expanded === "true";
    const query = getGroupLinkSearchQuery(group);
    const filteredTotal = expanded ? filteredLookEntries(group).length : total;
    const page = Number(group.dataset.page || "1") || 1;
    const totalPages = Math.max(1, Math.ceil(Math.max(filteredTotal, 1) / SAVED_LINK_PAGE_SIZE));
    const start = filteredTotal === 0 ? 0 : (page - 1) * SAVED_LINK_PAGE_SIZE + 1;
    const end = Math.min(page * SAVED_LINK_PAGE_SIZE, filteredTotal);

    const count = group.querySelector(".savedLinkGroupCount");
    if (count) count.textContent = formatCount(total, "link");

    const toggle = group.querySelector(".savedLinkGroupToggle");
    if (toggle) toggle.setAttribute("aria-expanded", expanded ? "true" : "false");
    group.classList.toggle("is-expanded", expanded);

    const empty = group.querySelector(".savedLinkGroupEmpty");
    const table = group.querySelector("table");
    const pager = group.querySelector(".savedLinkPager");
    const visibleRows = group.querySelectorAll("tbody tr").length;
    if (empty) {
        if (query && filteredTotal === 0) {
            empty.textContent = "No links match that search.";
            empty.hidden = !expanded;
        } else {
            empty.textContent = "No links in this look yet.";
            empty.hidden = !expanded || visibleRows > 0 || total > 0;
        }
    }
    if (table) {
        table.hidden = !expanded || visibleRows === 0;
        table.classList.toggle("is-empty", visibleRows === 0);
    }
    if (pager) {
        pager.hidden = !expanded || filteredTotal <= SAVED_LINK_PAGE_SIZE;
        const status = pager.querySelector(".savedLinkPagerStatus");
        if (status) {
            status.textContent = filteredTotal === 0
                ? ""
                : (query
                    ? `${start}–${end} of ${filteredTotal} matches`
                    : `${start}–${end} of ${formatCount(total, "link")}`);
        }
        const prev = pager.querySelector(".savedLinkPagerPrev");
        const next = pager.querySelector(".savedLinkPagerNext");
        if (prev) prev.disabled = page <= 1;
        if (next) next.disabled = page >= totalPages;
    }
}

function refreshAddLinkFolderSelect() {
    const select = document.querySelector("#addLinkFolderSelect");
    const toolbar = document.querySelector("#savedLinkAddFolder");
    const button = document.querySelector("#addLinkFolderBtn");
    if (!select || !toolbar) return;

    const used = new Set(
        Array.from(document.querySelectorAll(".savedLinkGroup"))
            .map(group => group.dataset.styleId)
    );
    const unused = getAvailableStyleRules().filter(rule => !used.has(rule.id));
    const previous = select.value;
    select.replaceChildren();

    if (unused.length === 0) {
        const option = document.createElement("option");
        option.value = "";
        option.textContent = getAvailableStyleRules().length === 0
            ? "Add a look on the Looks tab first"
            : "All looks are on this site";
        select.appendChild(option);
        select.disabled = true;
        if (button) button.disabled = true;
        return;
    }

    select.disabled = false;
    if (button) button.disabled = false;
    for (const rule of unused) {
        const option = document.createElement("option");
        option.value = rule.id;
        option.textContent = rule.name || rule.id;
        select.appendChild(option);
    }
    select.value = unused.some(rule => rule.id === previous)
        ? previous
        : unused[0].id;
}

function addLinkFolderFromSelect() {
    const select = document.querySelector("#addLinkFolderSelect");
    const styleId = select?.value;
    if (!styleId) return;
    if (document.querySelector(`.savedLinkGroup[data-style-id="${CSS.escape(styleId)}"]`)) {
        return;
    }
    createSavedLinkGroup(styleId);
    scheduleDirtyUiUpdate();
}

function createSavedLinkGroup(styleId) {
    const groupsRoot = document.querySelector("#savedLinkGroups");
    if (!groupsRoot || !styleId) return null;

    const group = document.createElement("section");
    group.className = "savedLinkGroup";
    group.dataset.styleId = styleId;
    group.dataset.expanded = "false";
    group.dataset.page = "1";

    const header = document.createElement("div");
    header.className = "savedLinkGroupHeader";

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "savedLinkGroupToggle";
    toggle.setAttribute("aria-expanded", "false");
    toggle.setAttribute("aria-label", `Show links for ${getLookLabel(styleId)}`);

    const chevron = document.createElement("span");
    chevron.className = "savedLinkGroupChevron";
    chevron.setAttribute("aria-hidden", "true");
    chevron.textContent = "▸";

    const count = document.createElement("span");
    count.className = "savedLinkGroupCount";

    toggle.append(chevron);
    toggle.addEventListener("click", event => {
        event.stopPropagation();
        toggleSavedLinkGroup(group);
    });

    const lookSelect = document.createElement("select");
    lookSelect.className = "savedLinkGroupLook";
    lookSelect.setAttribute("aria-label", "Look for this folder");
    lookSelect.title = "Change look for all links in this folder";
    populateStyleSelect(lookSelect, styleId);
    lookSelect.addEventListener("mousedown", event => event.stopPropagation());
    lookSelect.addEventListener("click", event => event.stopPropagation());
    lookSelect.addEventListener("change", () => {
        changeSavedLinkGroupLook(group, lookSelect.value);
    });

    const deleteFolderBtn = createDeleteButton(() => {
        const currentStyleId = group.dataset.styleId;
        const rowCount = linksForLook(currentStyleId).length;
        if (rowCount > 0) {
            const confirmed = window.confirm(
                `Remove the "${getLookLabel(currentStyleId)}" folder and its ${formatCount(rowCount, "link")} from this site?`
            );
            if (!confirmed) return;
        }
        replaceLinksForLook(currentStyleId, []);
        if (detailLinksByLook) detailLinksByLook.delete(currentStyleId);
        group.remove();
        commitLookIndexToSite();
        validateSiteDetail();
        refreshSavedLinkGroupEmptyStates();
        scheduleDirtyUiUpdate();
    });
    deleteFolderBtn.classList.add("savedLinkGroupDelete");
    deleteFolderBtn.setAttribute("aria-label", `Remove ${getLookLabel(styleId)} folder`);
    deleteFolderBtn.title = "Remove folder";
    header.append(toggle, lookSelect, count, deleteFolderBtn);
    header.addEventListener("click", event => {
        if (event.target.closest(".savedLinkGroupLook, .savedLinkGroupDelete")) return;
        toggleSavedLinkGroup(group);
    });

    group.append(header);
    groupsRoot.appendChild(group);
    refreshSavedLinkGroupEmptyStates();
    return group;
}

function toggleSavedLinkGroup(group) {
    if (group.dataset.expanded === "true") {
        collapseSavedLinkGroup(group);
    } else {
        expandSavedLinkGroup(group, Number(group.dataset.page || "1") || 1);
    }
}

function collapseSavedLinkGroup(group) {
    flushSavedLinkGroupPage(group);
    group.dataset.expanded = "false";
    group.querySelector(".savedLinkGroupBody")?.remove();
    const toggle = group.querySelector(".savedLinkGroupToggle");
    if (toggle) {
        toggle.setAttribute("aria-label", `Show links for ${getLookLabel(group.dataset.styleId)}`);
    }
    refreshSavedLinkGroupEmptyStates();
}

function ensureSavedLinkGroupBody(group) {
    let body = group.querySelector(".savedLinkGroupBody");
    if (body) return body;

    body = document.createElement("div");
    body.className = "savedLinkGroupBody";

    const search = document.createElement("input");
    search.type = "search";
    search.className = "savedLinkSearchInput";
    search.placeholder = "Search links…";
    search.setAttribute("aria-label", `Search ${getLookLabel(group.dataset.styleId)} links`);
    search.autocomplete = "off";
    search.addEventListener("keydown", event => {
        if (event.key === "Enter") event.preventDefault();
    });
    search.addEventListener("input", () => expandSavedLinkGroup(group, 1));
    search.addEventListener("search", () => expandSavedLinkGroup(group, 1));

    const table = document.createElement("table");
    const thead = document.createElement("thead");
    thead.innerHTML = "<tr><th>Title</th><th>URL</th><th>Actions</th></tr>";
    const tbody = document.createElement("tbody");
    table.append(thead, tbody);

    const empty = document.createElement("p");
    empty.className = "tableEmptyState savedLinkGroupEmpty";
    empty.textContent = "No links in this look yet.";

    const pager = document.createElement("div");
    pager.className = "savedLinkPager";
    const status = document.createElement("span");
    status.className = "savedLinkPagerStatus";
    const prev = document.createElement("button");
    prev.type = "button";
    prev.className = "savedLinkPagerPrev";
    prev.textContent = "Previous";
    prev.addEventListener("click", () => {
        const page = Number(group.dataset.page || "1") || 1;
        expandSavedLinkGroup(group, page - 1);
    });
    const next = document.createElement("button");
    next.type = "button";
    next.className = "savedLinkPagerNext";
    next.textContent = "Next";
    next.addEventListener("click", () => {
        const page = Number(group.dataset.page || "1") || 1;
        expandSavedLinkGroup(group, page + 1);
    });
    pager.append(status, prev, next);

    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "addSavedLinkBtn";
    addBtn.textContent = "Add link";
    addBtn.addEventListener("click", () => addSavedLinkToGroup(group));

    body.append(search, table, empty, pager, addBtn);
    group.appendChild(body);
    return body;
}

function expandSavedLinkGroup(group, page = 1, { skipFlush = false } = {}) {
    if (!skipFlush) flushSavedLinkGroupPage(group);
    ensureSavedLinkGroupBody(group);
    const styleId = group.dataset.styleId;
    const entries = filteredLookEntries(group);
    const totalPages = Math.max(1, Math.ceil(Math.max(entries.length, 1) / SAVED_LINK_PAGE_SIZE));
    const nextPage = Math.min(Math.max(1, page), totalPages);
    const start = (nextPage - 1) * SAVED_LINK_PAGE_SIZE;
    const slice = entries.slice(start, start + SAVED_LINK_PAGE_SIZE);

    group.dataset.expanded = "true";
    group.dataset.page = String(nextPage);
    const tbody = group.querySelector("tbody");
    tbody.replaceChildren();
    for (const { link, lookIndex } of slice) {
        createSavedLinkRow(link.url, link.title, group, true, lookIndex);
    }
    group.dataset.loadedCount = String(slice.length);

    const toggle = group.querySelector(".savedLinkGroupToggle");
    if (toggle) {
        toggle.setAttribute("aria-label", `Hide links for ${getLookLabel(styleId)}`);
    }
    refreshSavedLinkGroupEmptyStates();
}

function addSavedLinkToGroup(group) {
    const styleId = group.dataset.styleId;
    flushSavedLinkGroupPage(group);
    const search = group.querySelector(".savedLinkSearchInput");
    if (search) search.value = "";
    const all = linksForLook(styleId);
    all.push({ url: "", title: "", style: styleId });
    replaceLinksForLook(styleId, all);
    const lastPage = Math.max(1, Math.ceil(all.length / SAVED_LINK_PAGE_SIZE));
    expandSavedLinkGroup(group, lastPage);
    group.querySelector("tbody tr:last-child .savedLinkUrl")?.focus();
    scheduleDirtyUiUpdate();
}

function renderSavedLinkGroups(links = [], folderIds = []) {
    const groupsRoot = document.querySelector("#savedLinkGroups");
    if (!groupsRoot) return;
    groupsRoot.replaceChildren();

    for (const styleId of normalizeLinkFolderIds(folderIds, [])) {
        createSavedLinkGroup(styleId);
    }

    refreshSavedLinkGroupEmptyStates();
}

function updateSavedLinkGroupLookUi(group) {
    const styleId = group?.dataset.styleId;
    if (!group || !styleId) return;

    const select = group.querySelector(".savedLinkGroupLook");
    if (select) populateStyleSelect(select, styleId);

    const expanded = group.dataset.expanded === "true";
    const toggle = group.querySelector(".savedLinkGroupToggle");
    if (toggle) {
        toggle.setAttribute("aria-label", expanded
            ? `Hide links for ${getLookLabel(styleId)}`
            : `Show links for ${getLookLabel(styleId)}`);
    }

    const search = group.querySelector(".savedLinkSearchInput");
    if (search) search.setAttribute("aria-label", `Search ${getLookLabel(styleId)} links`);

    const deleteBtn = group.querySelector(".savedLinkGroupDelete");
    if (deleteBtn) {
        deleteBtn.setAttribute("aria-label", `Remove ${getLookLabel(styleId)} folder`);
    }
}

function changeSavedLinkGroupLook(group, nextStyleId) {
    const prevStyleId = group?.dataset.styleId;
    const lookSelect = group?.querySelector(".savedLinkGroupLook");
    if (!group || !nextStyleId || !prevStyleId || nextStyleId === prevStyleId) return;

    const revertSelect = () => {
        if (lookSelect) lookSelect.value = prevStyleId;
    };

    flushSavedLinkGroupPage(group);
    const destGroup = document.querySelector(
        `.savedLinkGroup[data-style-id="${CSS.escape(nextStyleId)}"]`
    );
    const moving = linksForLook(prevStyleId).slice();
    const count = moving.length;
    const fromLabel = getLookLabel(prevStyleId);
    const toLabel = getLookLabel(nextStyleId);

    if (destGroup && destGroup !== group) {
        const destCount = linksForLook(nextStyleId).length;
        const confirmed = window.confirm(
            count > 0
                ? `Move ${formatCount(count, "link")} from "${fromLabel}" into "${toLabel}"? That look already has ${formatCount(destCount, "link")} on this site. Duplicate URLs will be kept in "${toLabel}" only.`
                : `"${toLabel}" is already on this site. Remove the empty "${fromLabel}" folder?`
        );
        if (!confirmed) {
            revertSelect();
            return;
        }
        if (destGroup.dataset.expanded === "true") flushSavedLinkGroupPage(destGroup);
        const destLinks = linksForLook(nextStyleId).slice();
        const seen = new Set(destLinks.map(link => link.url));
        const merged = destLinks.map(link => ({
            url: link.url,
            title: link.title,
            style: nextStyleId
        }));
        for (const link of moving) {
            if (seen.has(link.url)) continue;
            seen.add(link.url);
            merged.push({
                url: link.url,
                title: link.title,
                style: nextStyleId
            });
        }
        if (!detailLinksByLook) detailLinksByLook = new Map();
        detailLinksByLook.delete(prevStyleId);
        detailLinksByLook.set(nextStyleId, merged);
        group.remove();
        commitLookIndexToSite();
        if (destGroup.dataset.expanded === "true") {
            expandSavedLinkGroup(destGroup, Number(destGroup.dataset.page || "1") || 1, { skipFlush: true });
        } else {
            updateSavedLinkGroupMeta(destGroup);
        }
        refreshSavedLinkGroupEmptyStates();
        scheduleDirtyUiUpdate();
        validateSiteDetail();
        return;
    }

    if (!detailLinksByLook) detailLinksByLook = new Map();
    detailLinksByLook.delete(prevStyleId);
    detailLinksByLook.set(nextStyleId, moving.map(link => ({
        url: link.url,
        title: link.title,
        style: nextStyleId
    })));
    group.dataset.styleId = nextStyleId;
    commitLookIndexToSite();
    updateSavedLinkGroupLookUi(group);
    if (group.dataset.expanded === "true") {
        expandSavedLinkGroup(group, Number(group.dataset.page || "1") || 1, { skipFlush: true });
    } else {
        updateSavedLinkGroupMeta(group);
    }
    refreshSavedLinkGroupEmptyStates();
    scheduleDirtyUiUpdate();
    validateSiteDetail();
}

function syncSavedLinkGroupsToLooks() {
    const groupsRoot = document.querySelector("#savedLinkGroups");
    if (!groupsRoot) return;

    const lookIds = new Set(getAvailableStyleRules().map(rule => rule.id));

    for (const group of Array.from(groupsRoot.querySelectorAll(".savedLinkGroup"))) {
        const styleId = group.dataset.styleId;
        const hasRows = linksForLook(styleId).length > 0;
        if (lookIds.has(styleId)) {
            updateSavedLinkGroupLookUi(group);
            continue;
        }
        if (hasRows) {
            updateSavedLinkGroupLookUi(group);
        } else {
            group.remove();
        }
    }

    refreshSavedLinkGroupEmptyStates();
}

function moveSavedLinkRow(row, styleId) {
    if (!row || !styleId) return;
    const sourceGroup = row.closest(".savedLinkGroup");
    if (!sourceGroup) return;
    const oldStyleId = sourceGroup.dataset.styleId;
    if (!oldStyleId || oldStyleId === styleId) return;

    const lookIndex = Number(row.dataset.lookIndex);
    const page = Number(sourceGroup.dataset.page || "1") || 1;
    flushSavedLinkGroupPage(sourceGroup);
    const from = linksForLook(oldStyleId);
    if (!Number.isInteger(lookIndex) || lookIndex < 0 || lookIndex >= from.length) return;
    const [moved] = from.splice(lookIndex, 1);
    if (!moved) return;
    moved.style = styleId;
    replaceLinksForLook(oldStyleId, from);

    let destGroup = document.querySelector(`.savedLinkGroup[data-style-id="${CSS.escape(styleId)}"]`);
    if (destGroup?.dataset.expanded === "true") {
        flushSavedLinkGroupPage(destGroup);
    }
    replaceLinksForLook(styleId, [...linksForLook(styleId), moved]);
    if (!destGroup) {
        destGroup = createSavedLinkGroup(styleId);
    }
    expandSavedLinkGroup(sourceGroup, page, { skipFlush: true });
    if (destGroup?.dataset.expanded === "true") {
        expandSavedLinkGroup(destGroup, Number(destGroup.dataset.page || "1") || 1, { skipFlush: true });
    } else {
        updateSavedLinkGroupMeta(destGroup);
    }
    validateSiteDetail();
    refreshSavedLinkGroupEmptyStates();
    scheduleDirtyUiUpdate();
}

function createSavedLinkRow(url = "", title = "", group = null, silent = false, lookIndex = null) {
    if (!group) return;
    const tbody = group.querySelector("tbody");
    if (!tbody) return;

    const row = document.createElement("tr");
    if (lookIndex != null && lookIndex !== "") {
        row.dataset.lookIndex = String(lookIndex);
    }
    const idSuffix = `sl-${++savedLinkFieldIdSeq}`;

    const urlCell = document.createElement("td");
    const urlInput = document.createElement("input");
    urlInput.type = "text";
    urlInput.className = "savedLinkUrl";
    urlInput.value = url;
    urlInput.placeholder = "https://example.com/job/123";
    urlInput.setAttribute("aria-label", "URL");
    urlInput.setAttribute("aria-describedby", `${idSuffix}-url-error`);
    urlInput.autocomplete = "off";
    const urlError = createFieldError(`${idSuffix}-url-error`);
    urlCell.append(urlInput, urlError);

    const titleCell = document.createElement("td");
    const titleInput = document.createElement("input");
    titleInput.type = "text";
    titleInput.className = "savedLinkTitle";
    titleInput.value = title || "";
    titleInput.placeholder = "Title";
    titleInput.setAttribute("aria-label", "Title");
    titleInput.autocomplete = "off";
    titleCell.appendChild(titleInput);

    const actionCell = document.createElement("td");
    const moveSelect = document.createElement("select");
    moveSelect.className = "savedLinkMove";
    moveSelect.setAttribute("aria-label", "Move to look");
    populateStyleSelect(moveSelect, group.dataset.styleId || "blocked");
    moveSelect.addEventListener("change", () => {
        moveSavedLinkRow(row, moveSelect.value);
    });

    actionCell.appendChild(createRowActions(
        moveSelect,
        createDeleteButton(() => {
            const page = Number(group.dataset.page || "1") || 1;
            const lookIndex = Number(row.dataset.lookIndex);
            flushSavedLinkGroupPage(group);
            const all = linksForLook(group.dataset.styleId);
            if (Number.isInteger(lookIndex) && lookIndex >= 0 && lookIndex < all.length) {
                all.splice(lookIndex, 1);
                replaceLinksForLook(group.dataset.styleId, all);
            }
            const filteredTotal = filteredLookEntries(group).length;
            const totalPages = Math.max(1, Math.ceil(Math.max(filteredTotal, 1) / SAVED_LINK_PAGE_SIZE));
            expandSavedLinkGroup(group, Math.min(page, totalPages), { skipFlush: true });
            validateSiteDetail();
            scheduleDirtyUiUpdate();
        })
    ));

    urlInput.addEventListener("input", () => validateSiteDetail());
    urlInput.addEventListener("blur", () => validateSiteDetail());

    row.append(titleCell, urlCell, actionCell);
    tbody.appendChild(row);
    if (!silent) refreshSavedLinkGroupEmptyStates();
}

let textRuleFieldIdSeq = 0;
function createTextRuleRow(text = "", style = "blocked") {
    const row = document.createElement("tr");
    const idSuffix = `tr-${++textRuleFieldIdSeq}`;

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
    styleSelect.setAttribute("aria-label", "Look");
    populateStyleSelect(styleSelect, style || "blocked");
    styleCell.appendChild(styleSelect);

    const actionCell = document.createElement("td");
    actionCell.appendChild(createRowActions(
        createDeleteButton(() => {
            row.remove();
            validateSiteDetail();
    refreshAllTableEmptyStates();
        })
    ));

    textInput.addEventListener("input", () => validateSiteDetail());
    textInput.addEventListener("blur", () => validateSiteDetail());

    row.append(textCell, styleCell, actionCell);
    document.querySelector("#textRuleBody").appendChild(row);
    refreshAllTableEmptyStates();
}

function isPlausibleQueryParamName(name) {
    return /^[A-Za-z0-9._~-]+$/.test(name);
}

function validateSiteDetail() {
    if (!isSiteDetailOpen()) return true;

    const hostInput = document.querySelector("#siteDetailHost");
    const hostError = document.querySelector("#siteDetailHostError");
    const keepParamsInput = document.querySelector("#siteKeepParams");
    const keepParamsError = document.querySelector("#siteKeepParamsError");
    const hostRaw = hostInput?.value.trim() || "";
    let allValid = true;
    let hostMessage = "";

    if (!hostRaw) {
        hostMessage = "Enter a site hostname.";
    } else if (!isPlausibleHostname(hostRaw)) {
        hostMessage = "Enter a valid hostname (example.com).";
    } else {
        const hostname = normalizeSite(hostRaw);
        const duplicate = sitesDraft.some((siteConfig, index) =>
            index !== selectedSiteIndex && siteConfig.site === hostname
        );
        if (duplicate) {
            hostMessage = "That website is already in the list.";
        }
    }
    setFieldError(hostInput, hostError, hostMessage);
    if (hostMessage) allValid = false;

    const keepParamsRaw = keepParamsInput?.value.trim() || "";
    let keepParamsMessage = "";
    if (keepParamsRaw) {
        const invalidNames = parseCommaSeparatedValues(keepParamsRaw)
            .filter(name => !isPlausibleQueryParamName(name));
        if (invalidNames.length > 0) {
            keepParamsMessage = "Use parameter names only (id, jk), not values or full URLs.";
        }
    }
    setFieldError(keepParamsInput, keepParamsError, keepParamsMessage);
    if (keepParamsMessage) allValid = false;

    const seenClassGroups = new Map();
    for (const row of document.querySelectorAll("#classGroupBody tr")) {
        const input = row.querySelector(".classGroupInput");
        const errorEl = input?.parentElement?.querySelector(".fieldError");
        const raw = input?.value.trim() || "";
        let message = "";
        if (raw) {
            const groups = parseClassGroups(raw);
            if (groups.length === 0) {
                message = "Enter CSS class names, separated by spaces.";
            } else {
                const key = getClassGroupKey(groups[0]);
                if (seenClassGroups.has(key)) {
                    message = "Duplicate class group.";
                } else {
                    seenClassGroups.set(key, true);
                }
            }
        }
        setFieldError(input, errorEl, message);
        if (message) allValid = false;
    }

    const seenUrls = new Map();
    for (const row of document.querySelectorAll(".savedLinkGroup tbody tr")) {
        const input = row.querySelector(".savedLinkUrl");
        const errorEl = input?.parentElement?.querySelector(".fieldError");
        const title = row.querySelector(".savedLinkTitle")?.value.trim() || "";
        const raw = input?.value.trim() || "";
        let message = "";
        if (!raw && !title) {
            setFieldError(input, errorEl, "");
            continue;
        }
        if (!raw) {
            message = "Enter a URL.";
        } else if (!isValidHttpUrl(raw)) {
            message = "Enter a valid http(s) URL.";
        } else if (seenUrls.has(raw)) {
            message = "Duplicate URL.";
        } else {
            seenUrls.set(raw, true);
        }
        setFieldError(input, errorEl, message);
        if (message) allValid = false;
    }

    const seenText = new Map();
    for (const row of document.querySelectorAll("#textRuleBody tr")) {
        const input = row.querySelector(".textRuleText");
        const errorEl = input?.parentElement?.querySelector(".fieldError");
        const raw = input?.value.trim() || "";
        let message = "";
        if (!raw) {
            setFieldError(input, errorEl, "");
            continue;
        }
        const key = raw.toLowerCase();
        if (seenText.has(key)) {
            message = "Duplicate text for this site.";
        } else {
            seenText.set(key, true);
        }
        setFieldError(input, errorEl, message);
        if (message) allValid = false;
    }

    return allValid;
}

function validateConfigurableRuleRows() {
    if (isSiteDetailOpen() && !validateSiteDetail()) {
        showRowValidationError(
            "sites",
            ".fieldInvalid",
            "Fix the highlighted fields before saving",
            "Review site",
            { openSiteIndex: selectedSiteIndex }
        );
        return false;
    }
    return true;
}

function findDomRulesReferencingStyle(styleId) {
    if (!styleId) return [];
    flushSiteDetailToDraft();
    const references = [];
    sitesDraft.forEach(siteConfig => {
        for (const link of siteConfig.links || []) {
            if (link.style === styleId) {
                references.push(`Saved link on ${siteConfig.site}`);
            }
        }
        for (const rule of siteConfig.textRules || []) {
            if (rule.style === styleId) {
                references.push(`Text rule "${rule.text}" on ${siteConfig.site}`);
            }
        }
    });
    return references;
}

function findDanglingStyleReferences(styleRules, sites) {
    const styleIds = new Set(
        (styleRules || []).map(rule => rule.id).filter(Boolean)
    );
    const dangling = [];
    for (const siteConfig of sites || []) {
        for (const link of siteConfig.links || []) {
            if (!link.style || styleIds.has(link.style)) continue;
        dangling.push(
                `Saved link on ${siteConfig.site} uses missing style "${link.style}"`
            );
        }
        for (const rule of siteConfig.textRules || []) {
            if (!rule.style || styleIds.has(rule.style)) continue;
            dangling.push(
                `Text rule "${rule.text}" on ${siteConfig.site} uses missing style "${rule.style}"`
            );
        }
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
    const sites = collectSitesFromUi();

    return {
        styleRules,
        sites,
        payload: {
            enableTopBorder: document.querySelector("#enableTopBorder").checked,
            enableDeepSearch: document.querySelector("#enableDeepSearch").checked,
            enableToastNotifications: document.querySelector("#enableToastNotifications").checked,
            [STYLE_RULE_STORAGE_KEY]: styleRules,
            ...buildSitesStorageWrites(sites)
        }
    };
}

function collectVisibleSavedLinkSnapshot() {
    const rows = [];
    for (const group of document.querySelectorAll(".savedLinkGroup[data-expanded='true']")) {
        for (const row of group.querySelectorAll("tbody tr")) {
            rows.push({
                look: group.dataset.styleId,
                i: row.dataset.lookIndex,
                url: row.querySelector(".savedLinkUrl")?.value || "",
                title: row.querySelector(".savedLinkTitle")?.value || ""
            });
        }
    }
    return rows;
}

function getFormSnapshot() {
    if (!sitesReady) return null;
    try {
        return JSON.stringify({
            general: {
                enableTopBorder: document.querySelector("#enableTopBorder").checked,
                enableDeepSearch: document.querySelector("#enableDeepSearch").checked,
                enableToastNotifications: document.querySelector("#enableToastNotifications").checked
            },
            styleRules: collectStyleRules(),
            siteDetail: isSiteDetailOpen() ? {
                host: document.querySelector("#siteDetailHost")?.value || "",
                keepParams: document.querySelector("#siteKeepParams")?.value || "",
                classGroups: collectClassGroupsFromDetail(),
                textRules: collectTextRulesFromDetail(),
                linkFolders: collectLinkFoldersFromDetail()
            } : null,
            sites: sitesDraft.map(siteConfig => ({
                site: siteConfig.site,
                classGroups: siteConfig.classGroups,
                keepParams: siteConfig.keepParams,
                textRules: siteConfig.textRules,
                linkFolders: siteConfig.linkFolders,
                linkCount: (siteConfig.links || []).length,
                linksRevision: siteConfig.linksRevision || 0
            })),
            visibleLinks: collectVisibleSavedLinkSnapshot()
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
        if (actionBarBusy || !sitesReady) return;
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
    setSitesReady(sitesReady);
}

function setSitesReady(ready) {
    sitesReady = ready;
    const saveBtn = document.querySelector("#saveBtn");
    const exportBtn = document.querySelector("#exportBtn");
    if (!actionBarBusy) {
        if (saveBtn) saveBtn.disabled = !ready;
        if (exportBtn) exportBtn.disabled = !ready;
    }
}

function persistOptionsFromForm({
    successMessage = "Options saved",
    setBusy = true,
    busyLabel = "Saving…",
    busyButton = null
} = {}) {
    if (!sitesReady) {
        showStatus("Settings are still loading — try saving again", true);
        return Promise.resolve();
    }

    if (!validateConfigurableRuleRows()) {
        return Promise.resolve();
    }

    const { styleRules, sites, payload } = buildOptionsPayload();
    const dangling = findDanglingStyleReferences(styleRules, sites);
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
    const openHost = isSiteDetailOpen() ? sitesDraft[selectedSiteIndex]?.site : "";
    return browser.storage.local.set(payload)
        .then(() => browser.storage.local.remove(Object.values(LEGACY_STORAGE_KEYS)))
        .then(() => {
            applyLoadedConfiguration(sites, styleRules, {
                enableTopBorder: payload.enableTopBorder,
                enableDeepSearch: payload.enableDeepSearch,
                enableToastNotifications: payload.enableToastNotifications
            });
            if (openHost) {
                const index = sitesDraft.findIndex(siteConfig => siteConfig.site === openHost);
                if (index >= 0) openSiteDetail(index);
            }
        })
        .then(() => {
            suppressOptionsStorageReload = false;
            suppressDirtyTracking = false;
            captureSavedFormSnapshot();
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

function applyLoadedConfiguration(sites, styleRules, general = {}) {
    if (general.enableTopBorder !== undefined) {
        document.querySelector("#enableTopBorder").checked = !!general.enableTopBorder;
    }
    if (general.enableDeepSearch !== undefined) {
        document.querySelector("#enableDeepSearch").checked = !!general.enableDeepSearch;
    }
    if (general.enableToastNotifications !== undefined) {
        document.querySelector("#enableToastNotifications").checked =
            general.enableToastNotifications !== false;
    }

    loadStyleRuleRows(styleRules);
    sitesDraft = normalizeSites(sites, { preserveLinks: true });
    selectedSiteIndex = -1;
    detailLinksByLook = null;
    showSiteListView();
    setSitesReady(true);
            refreshAllTableEmptyStates();
    loadLegacyImportFolders();
}

function restoreOptions() {
    suppressOptionsStorageReload = true;
    suppressDirtyTracking = true;
    setSitesReady(false);

    return browser.storage.local.get(null)
        .then(result => {
        applyGettingStartedVisibility(!!result[STORAGE_KEYS.hideGettingStarted]);
            const styleRules = migrateStyleRulesFromStorage(result);
            return purgeLegacyStorage(result).then(sites => {
                applyLoadedConfiguration(sites, styleRules, {
                    enableTopBorder: !!result.enableTopBorder,
                    enableDeepSearch: !!result.enableDeepSearch,
                    enableToastNotifications: result.enableToastNotifications !== false
                });
            });
        })
    .catch(error => {
        console.error(error);
    })
    .finally(() => {
        suppressOptionsStorageReload = false;
        suppressDirtyTracking = false;
            captureSavedFormSnapshot();
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
    setSitesReady(false);
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
        sites: collectSitesFromUi(),
        styleRules: normalizeStyleRules(collectStyleRules()),
        enableTopBorder: document.querySelector("#enableTopBorder").checked,
        enableDeepSearch: document.querySelector("#enableDeepSearch").checked,
        enableToastNotifications: document.querySelector("#enableToastNotifications").checked
    };
}

function exportConfigurationFilename() {
    const date = new Date().toISOString().slice(0, 10);
    return `bookmarks-enhancer-config-${date}.json`;
}

function exportToFile() {
    if (actionBarBusy) return;
    if (!sitesReady) {
        showStatus("Settings are still loading — try exporting again", true);
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

function isValidImportedSite(siteConfig) {
    return !!siteConfig && typeof siteConfig.site === "string";
}

function importFromJson(jsonString) {
    let data;

    try {
        data = JSON.parse(jsonString);

        if (!data || typeof data !== "object" || Array.isArray(data)) {
            throw new Error("Invalid format");
        }

        if (
            data.sites !== undefined &&
            (!Array.isArray(data.sites) || !data.sites.every(isValidImportedSite))
        ) {
            throw new Error("Invalid sites");
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
            data.enableToastNotifications !== undefined &&
            typeof data.enableToastNotifications !== "boolean"
        ) {
            throw new Error("Invalid enableToastNotifications");
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
    } catch (err) {
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

    const styleRules = migrateStyleRulesFromStorage(data);
    const loadSites = Array.isArray(data.sites)
        ? Promise.resolve(normalizeSites(data.sites))
        : importBookmarkFolderLinksIntoSites(data, migrateSitesFromStorage(data));

    return loadSites.then(sites => {
        applyLoadedConfiguration(sites, styleRules, {
            enableDeepSearch: data.enableDeepSearch,
            enableTopBorder: data.enableTopBorder,
            enableToastNotifications: data.enableToastNotifications
        });
        setSitesReady(true);
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

    if (tabId === "sites" || tabId === "looks" || tabId === "general") {
        refreshAllStyleSelects();
    }
    if (tabId === "general") {
        loadLegacyImportFolders();
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
        setupDirtyTracking();

        document.querySelector("#addSiteBtn")?.addEventListener("click", addSiteFromInput);
        document.querySelector("#addSiteInput")?.addEventListener("keydown", event => {
            if (event.key === "Enter") {
                event.preventDefault();
                addSiteFromInput();
            }
        });
        document.querySelector("#searchSitesInput")?.addEventListener("input", renderSiteList);
        document.querySelector("#searchSitesInput")?.addEventListener("search", renderSiteList);
        document.querySelector("#siteDetailBack")?.addEventListener("click", closeSiteDetail);
        document.querySelector("#siteDetailHost")?.addEventListener("input", () => validateSiteDetail());
        document.querySelector("#siteDetailHost")?.addEventListener("blur", () => validateSiteDetail());
        document.querySelector("#siteKeepParams")?.addEventListener("input", () => validateSiteDetail());
        document.querySelector("#siteKeepParams")?.addEventListener("blur", () => validateSiteDetail());
        document.querySelector("#addClassGroupBtn")?.addEventListener("click", () => createClassGroupRow());
        document.querySelector("#addLinkFolderBtn")?.addEventListener("click", addLinkFolderFromSelect);
        document.querySelector("#legacyImportBtn")?.addEventListener("click", importLegacyBookmarkFolder);
        document.querySelector("#addTextRuleBtn")?.addEventListener("click", () => createTextRuleRow());
        document.querySelector("#addStyleRuleBtn")?.addEventListener("click", () => {
                createStyleRuleRow();
                refreshAllStyleSelects();
                refreshShortcutIconOptions();
            });
        document.querySelector("#exportBtn")?.addEventListener("click", exportToFile);
        document.querySelector("#importBtn")?.addEventListener("click", importFromFile);
        document.querySelector("#importFileInput")?.addEventListener("change", handleImportFileChange);

        const stylePreviewLink = document.querySelector("#stylePreviewLink");
        if (stylePreviewLink) {
            stylePreviewLink.addEventListener("click", event => {
                event.preventDefault();
            });
        }
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
