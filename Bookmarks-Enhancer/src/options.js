function init() {
    try {
        initSaveLoadEvents();
    }
    catch (err) {
        console.error(err);
    }
}

function saveOptions(e) {
    e.preventDefault();
    let obj = {
		enableTopBorder: document.querySelector("#enableTopBorder").checked,
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

function restoreOptions() {
    function handleStorage(result) {
		document.querySelector("#enableTopBorder").checked = !!result.enableTopBorder;
        document.querySelector("#onlyUseSites").checked = !!result.onlyUseSites;

        if (result.searchPairs) {
            result.searchPairs.forEach(({ site, tag }) => createRow(site, tag));
        }
    }


    function onError(error) {
        console.error(`Error: ${error}`);
    }

    let getting = browser.storage.local.get(["searchPairs", "enableTopBorder", "onlyUseSites"]);
    getting.then(handleStorage, onError);
}

function initSaveLoadEvents() {
    document.addEventListener("DOMContentLoaded", restoreOptions);
    document.querySelector("form").addEventListener("submit", saveOptions);
}
function exportTableToClipboard() {
    const rows = document.querySelectorAll("table tr");
    const data = [];

    rows.forEach(row => {
        const inputs = row.querySelectorAll("input");
        if (inputs.length >= 2) {
            const site = inputs[0].value.trim();
            const tag = inputs[1].value.trim();
            if (site || tag) {
                data.push({ site, tag });
            }
        }
    });

    const json = JSON.stringify(data, null, 2);
    navigator.clipboard.writeText(json)
        .then(() => showStatus(`Exported ${data.length} row${data.length === 1 ? "" : "s"} to clipboard`))
        .catch(err => {
            console.error("Clipboard write failed:", err);
            showStatus("Could not export to clipboard", true);
        });
}

function importTableFromJson(jsonString) {
    let data;
    try {
        data = JSON.parse(jsonString);
        if (!Array.isArray(data)) throw new Error("Invalid format");
        if (!data.every(row => row && typeof row === "object")) throw new Error("Invalid row format");
    } catch (err) {
        console.error("Failed to parse JSON:", err);
        showStatus("Import failed: invalid JSON", true);
        return;
    }

    clearTable();

    data.forEach(({ site, tag }) => createRow(site || "", tag || ""));
    showStatus(`Imported ${data.length} row${data.length === 1 ? "" : "s"}`);
}
function importFromClipboard() {
    navigator.clipboard.readText()
        .then(text => importTableFromJson(text))
        .catch(err => {
            console.error("Clipboard read failed:", err);
            showStatus("Could not read from clipboard", true);
        });
}
function clearTable() {
    const tableBody = document.querySelector("#tableBody");
    if (!tableBody) return;
    while (tableBody.firstChild) {
        tableBody.removeChild(tableBody.firstChild);
    }
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

init();

document.addEventListener("DOMContentLoaded", () => {
    document.querySelector("#addRowBtn").addEventListener("click", () => createRow());
    document.querySelector("#exportBtn").addEventListener("click", exportTableToClipboard);
    document.querySelector("#importBtn").addEventListener("click", importFromClipboard);
});
