function saveOptions(e) {
    e.preventDefault();
    let obj = {
		enableTopBorder: document.querySelector("#enableTopBorder").checked,
		enableDeepSearch: document.querySelector("#enableDeepSearch").checked,
		onlyUseSites: document.querySelector("#onlyUseSites").checked
    };

    const rows = Array.from(document.querySelectorAll("#tableBody tr")).map(row => {
        const inputs = row.querySelectorAll("input");
        return {
            site: inputs[0].value.trim(),
            tag: inputs[1].value.trim()
        };
    });
    obj.searchPairs = rows;

    const urlRules = Array.from(
        document.querySelectorAll("#urlRuleBody tr")
        ).map(row => {
            const inputs = row.querySelectorAll("input");

            return {
                site: inputs[0].value.trim(),
                keepParams: inputs[1].value.trim()
            };
        });
    obj.urlRules = urlRules;

    const textFilters = Array.from(
        document.querySelectorAll("#textFilterBody tr")
        ).map(row => {
            const inputs = row.querySelectorAll("input");

            return {
                site: inputs[0].value.trim(),
                filterText: inputs[1].value.trim()
            };
        });
    obj.textFilters = textFilters;

    browser.storage.local.set(obj)
        .then(() => showStatus("Options saved"))
        .catch(err => {
            console.error("Save failed:", err);
            showStatus("Could not save options", true);
        });
}

function createRow(site = "", tag = "") {
    const row = document.createElement("tr");

    const siteCell = document.createElement("td");
    const siteInput = document.createElement("input");
    siteInput.type = "text";
    siteInput.value = site;
    siteCell.appendChild(siteInput);

    const tagCell = document.createElement("td");
    const tagInput = document.createElement("input");
    tagInput.type = "text";
    tagInput.value = tag;
    tagCell.appendChild(tagInput);

    const actionCell = document.createElement("td");
    const deleteBtn = document.createElement("button");
    deleteBtn.textContent = "Delete";
    deleteBtn.type = "button";
    deleteBtn.addEventListener("click", () => row.remove());
    actionCell.appendChild(deleteBtn);

    row.appendChild(siteCell);
    row.appendChild(tagCell);
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

function createTextFilterRow(site = "", filterText = "") {
    const row = document.createElement("tr");

    const siteCell = document.createElement("td");
    const siteInput = document.createElement("input");
    siteInput.type = "text";
    siteInput.value = site;
    siteCell.appendChild(siteInput);

    const filterCell = document.createElement("td");
    const filterInput = document.createElement("input");
    filterInput.type = "text";
    filterInput.value = filterText;
    filterCell.appendChild(filterInput);

    const actionCell = document.createElement("td");
    const deleteBtn = document.createElement("button");
    deleteBtn.textContent = "Delete";
    deleteBtn.type = "button";
    deleteBtn.addEventListener("click", () => row.remove());
    actionCell.appendChild(deleteBtn);

    row.appendChild(siteCell);
    row.appendChild(filterCell);
    row.appendChild(actionCell);

    document.querySelector("#textFilterBody").appendChild(row);
}

function restoreOptions() {
    function handleStorage(result) {

        document.querySelector("#enableTopBorder").checked =
            !!result.enableTopBorder;

        document.querySelector("#enableDeepSearch").checked =
            !!result.enableDeepSearch;

        document.querySelector("#onlyUseSites").checked =
            !!result.onlyUseSites;


        if (result.searchPairs) {
            result.searchPairs.forEach(
                ({ site, tag }) =>
                    createRow(site, tag)
            );
        }


        if (result.urlRules) {
            result.urlRules.forEach(
                ({ site, keepParams }) =>
                    createUrlRuleRow(site, keepParams)
            );
        }

        if (result.textFilters) {
            result.textFilters.forEach(
                ({ site, filterText }) =>
                    createTextFilterRow(site, filterText)
            );
        }
    }


    browser.storage.local.get([
        "searchPairs",
        "urlRules",
        "textFilters",
        "enableTopBorder",
        "enableDeepSearch",
        "onlyUseSites"
    ])
    .then(handleStorage)
    .catch(console.error);
}

function initSaveLoadEvents() {
    restoreOptions();
    document.querySelector("form").addEventListener("submit", saveOptions);
}
function exportToClipboard() {
    const searchPairs = Array.from(
        document.querySelectorAll("#tableBody tr")
    ).map(row => {
        const inputs = row.querySelectorAll("input");

        return {
            site: inputs[0].value.trim(),
            tag: inputs[1].value.trim()
        };
    });

    const urlRules = Array.from(
        document.querySelectorAll("#urlRuleBody tr")
    ).map(row => {
        const inputs = row.querySelectorAll("input");

        return {
            site: inputs[0].value.trim(),
            keepParams: inputs[1].value.trim()
        };
    });

    const textFilters = Array.from(
        document.querySelectorAll("#textFilterBody tr")
    ).map(row => {
        const inputs = row.querySelectorAll("input");

        return {
            site: inputs[0].value.trim(),
            filterText: inputs[1].value.trim()
        };
    });

    const data = {
        searchPairs,
        urlRules,
        textFilters,
        enableTopBorder: document.querySelector("#enableTopBorder").checked,
        onlyUseSites: document.querySelector("#onlyUseSites").checked,
        enableDeepSearch: document.querySelector("#enableDeepSearch").checked
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
            data.textFilters &&
            !data.textFilters.every(isValidTextFilter)
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
    }
    catch (err) {
        console.error(err);
        showStatus("Import failed", true);
        return;
    }

    clearSearchTable();
    clearUrlRuleTable();
    clearTextFilterTable();

    (data.searchPairs || []).forEach(
        ({ site, tag }) => createRow(site, tag)
    );

    (data.urlRules || []).forEach(
        ({ site, keepParams }) =>
            createUrlRuleRow(site, keepParams)
    );

    (data.textFilters || []).forEach(
        ({ site, filterText }) =>
            createTextFilterRow(site, filterText)
    );

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

    showStatus("Imported configuration");
}

function isValidSearchPair(row) {
    return row &&
        typeof row.site === "string" &&
        typeof row.tag === "string";
}

function isValidUrlRule(row) {
    return row &&
        typeof row.site === "string" &&
        typeof row.keepParams === "string";
}

function isValidTextFilter(row) {
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

function clearTextFilterTable() {
    document.querySelector("#textFilterBody").replaceChildren();
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

function setupEventListeners() {
    try {
        const addRowBtn = document.querySelector("#addRowBtn");
        const exportBtn = document.querySelector("#exportBtn");
        const importBtn = document.querySelector("#importBtn");
        const addUrlRuleBtn = document.querySelector("#addUrlRuleBtn");
        const addTextFilterBtn = document.querySelector("#addTextFilterBtn");

        if (!addRowBtn) console.warn("addRowBtn not found");
        if (!exportBtn) console.warn("exportBtn not found");
        if (!importBtn) console.warn("importBtn not found");
        if (!addUrlRuleBtn) console.warn("addUrlRuleBtn not found");
        if (!addTextFilterBtn) console.warn("addTextFilterBtn not found");

        if (addRowBtn) addRowBtn.addEventListener("click", () => createRow());
        if (exportBtn) exportBtn.addEventListener("click", exportToClipboard);
        if (importBtn) importBtn.addEventListener("click", importFromClipboard);
        if (addUrlRuleBtn) addUrlRuleBtn.addEventListener("click", () => createUrlRuleRow());
        if (addTextFilterBtn) addTextFilterBtn.addEventListener("click", () => createTextFilterRow());

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
