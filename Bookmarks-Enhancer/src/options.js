function init() {
    try {
        initSaveLoadEvents();
    }
    catch (err) {
        console.error(err);
    }
}

function saveOptions(e) {
    var obj = {
		sitesForSearch: document.querySelector("#sitesForSearch").value,
        tagsForSearch: document.querySelector("#tagsForSearch").value,
		enableTopBorder: document.querySelector("#enableTopBorder").checked,
		onlyUseSites: document.querySelector("#onlyUseSites").checked
    };

    browser.storage.local.set(obj);
}

function restoreOptions() {
    function handleStorage(result) {
		document.querySelector("#sitesForSearch").value = result.sitesForSearch || "";
        document.querySelector("#tagsForSearch").value = result.tagsForSearch || "";
		document.querySelector("#enableTopBorder").checked = !!result.enableTopBorder;
		document.querySelector("#onlyUseSites").checked = !!result.onlyUseSites;
    }

    function onError(error) {
        console.error(`Error: ${error}`);
    }

    var getting = browser.storage.local.get(["sitesForSearch", "tagsForSearch", "enableTopBorder", "onlyUseSites"]);
    getting.then(handleStorage, onError);
}

function initSaveLoadEvents() {
    document.addEventListener("DOMContentLoaded", restoreOptions);
    document.querySelector("form").addEventListener("submit", saveOptions);
}

init();
