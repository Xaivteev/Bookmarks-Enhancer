// Load settings from config
var tagsForSearch = [];
var searchSite = true;
var enableTopBorder = false;

function onError(error) {
    console.log(`Error: ${error}`);
}

function onGot(item) {
    if (item.tagsForSearch) {
        tagsForSearch = item.tagsForSearch.split(',');
		for(var i = 0; i < tagsForSearch.length; i++) {
			tagsForSearch[i] = tagsForSearch[i].trim();
		}
    }
	
	if (!!item.onlyUseSites) {
		searchSite = false;
		if (item.sitesForSearch) {
			sitesForSearch = item.sitesForSearch.split(',');
			for(var i = 0; i < sitesForSearch.length; i++) {
				sitesForSearch[i] = sitesForSearch[i].trim();
			}
			for (var i = 0; i < sitesForSearch.length; i++) {
				if (window.location.href.includes(sitesForSearch[i])) {
					searchSite = true;
				}
			}
		}
	} else {
		searchSite = true;
	}
	
	if (!!item.enableTopBorder) {
		enableTopBorder = item.enableTopBorder;
	}
}

var getting = browser.storage.local.get(["sitesForSearch", "tagsForSearch", "enableTopBorder", "onlyUseSites"]);
getting.then(onGot, onError);

// Set up communication port for initial styling

var port = browser.runtime.connect({name:"bookmark-highlighter"});

// Listen for response from background script

port.onMessage.addListener(function(m) {
	if (searchSite) {
		for (var i = 0; i < tagsForSearch.length; i++) {
			var divs = document.getElementsByClassName(tagsForSearch[i]);
			if (m.seen) {
				styleSeen(m.seen, divs);
			}
			if (m.blocked) {
				styleBlocked(m.blocked, divs);
			}
			if (m.favorited) {
				styleFavorited(m.favorited, divs);
			}
		}
	}
});

// Collect list of links

var hrefs = [];

for (var i = 0; i < document.links.length; i++) {
    var item = document.links[i];
    hrefs.push(item.href);
}

// Ask background script to check for bookmarks

port.postMessage({hrefs: hrefs});

// Connection from backgroundScript if update button is pressed
browser.runtime.onConnect.addListener(connected);
function connected(p) {
	port = p;
	port.onMessage.addListener(function(m) {
		if (searchSite) {
			for (var i = 0; i < tagsForSearch.length; i++) {
				var divs = document.getElementsByClassName(tagsForSearch[i]);
				if (m.seen) {
					styleSeen(m.seen, divs);
				}
				if (m.blocked) {
					styleBlocked(m.blocked, divs);
				}
				if (m.favorited) {
					styleFavorited(m.favorited, divs);
				}
			}
		}
	});

	var hrefs = [];

	for (var i = 0; i < document.links.length; i++) {
		var item = document.links[i];
		hrefs.push(item.href);
	}
		
	port.postMessage({hrefs: hrefs});
}

function styleBlocked(blocked, divs) {
	// hide links of blocked bookmarks
	for (var x = 0; x < divs.length; x++) {
		var div = divs[x];
		var content = div.innerHTML.trim();
		for (var y = 0; y < blocked.length; y++) {
			var currentURL = new URL(blocked[y].url).pathname;
			if (currentURL !== '/') {
				if (content.includes(new URL(blocked[y].url).pathname)) {
					div.style.display = 'none';
				}
				// add top border to blocked bookmarks
				if (window.location.href.includes(blocked[y].url) && enableTopBorder) {
					document.body.style.borderTop = "dashed red";
				}
			}
		}
	}
	
	for (var i = 0; i < document.links.length; i++) {
		var link = document.links[i];
		for (var y = 0; y < blocked.length; y++) {
			var currentURL = new URL(blocked[y].url).pathname;
			if (currentURL !== '/') {
				if(link.href.includes(new URL(blocked[y].url).pathname)) {
					link.style.cssText += ';' + 'display: none;';
				}
			}
		}
	}
}

function styleFavorited(favorited, divs) {
	// underline links of favorited bookmarks
	for (var x = 0; x < divs.length; x++) {
		var div = divs[x];
		var content = div.innerHTML.trim();
		for (var y = 0; y < favorited.length; y++) {
			var currentURL = new URL(favorited[y].url).pathname;
			if (currentURL !== '/') {
				if (content.includes(new URL(favorited[y].url).pathname)) {
					div.style.textDecoration = "underline";
					div.style.textDecorationStyle = "double";
				}
				//add top border to favorited bookmarks
				if (window.location.href.includes(favorited[y].url) && enableTopBorder) {
					document.body.style.borderTop = "double white";
				}
			}
		}
	}
	
	for (var i = 0; i < document.links.length; i++) {
		var link = document.links[i];
		for (var y = 0; y < favorited.length; y++) {
			var currentURL = new URL(favorited[y].url).pathname;
			if (currentURL !== '/') {
				if(link.href.includes(new URL(favorited[y].url).pathname)) {
					link.style.cssText += ';' + 'text-decoration: underline double;';
				}
			}
		}
	}
}

function styleSeen(seen, divs) {
	// dashed underline links of seen bookmarks
	for (var x = 0; x < divs.length; x++) {
		var div = divs[x];
		var content = div.innerHTML.trim();	
		for (var y = 0; y < seen.length; y++) {
			var currentURL = new URL(seen[y].url).pathname;
			if (currentURL !== '/') {
				if (content.includes(new URL(seen[y].url).pathname)) {
					div.style.textDecorationLine = "underline";
					div.style.textDecorationStyle = "dashed";
				}
				// add top border to seen bookmarks
				if (window.location.href.includes(seen[y].url) && enableTopBorder) {
					document.body.style.borderTop = "dashed white";
				}
			}
		}
	}
	
	for (var i = 0; i < document.links.length; i++) {
		var link = document.links[i];
		for (var y = 0; y < seen.length; y++) {
			var currentURL = new URL(seen[y].url).pathname;
			if (currentURL !== '/') {
				if(link.href.includes(new URL(seen[y].url).pathname)) {
					link.style.cssText += ';' + 'text-decoration: underline dashed;';
				}
			}
		}
	}
}