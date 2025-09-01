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

    browser.storage.local.set(obj);
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

init();

document.addEventListener("DOMContentLoaded", () => {
    document.querySelector("#addRowBtn").addEventListener("click", () => createRow());
});
