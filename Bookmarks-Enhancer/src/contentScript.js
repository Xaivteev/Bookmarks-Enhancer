// Load settings from config
let searchPairs = [];
let tagsForSearch = [];
let searchSite = true;
let enableTopBorder = false;

let getting = browser.storage.local.get(["searchPairs", "enableTopBorder", "onlyUseSites"]);
getting.then(onGot, onError);
function onError(error) {
    console.log(`Error: ${error}`);
}

function onGot(item) {
	searchPairs = Array.isArray(item.searchPairs) ? item.searchPairs : [];
	
	if (item.onlyUseSites) {
		searchSite = false;
		// Find pair where site matches current URL
		const matchedPair = searchPairs.find(pair => window.location.href.includes(pair.site));

		if (matchedPair) {
			searchSite = true;
			tagsForSearch = matchedPair.tag.split(',').map(tag => tag.trim()).filter(Boolean);
		}

	} else {
        tagsForSearch = searchPairs.flatMap(pair => pair.tag.split(',').map(tag => tag.trim()).filter(Boolean));
		searchSite = true;
	}

    enableTopBorder = !!item.enableTopBorder;
}

// Set up communication port for initial styling

let port = browser.runtime.connect({name:"bookmark-highlighter"});

// Listen for response from background script

port.onMessage.addListener(function(m) {
	if (searchSite) {
		for (let i = 0; i < tagsForSearch.length; i++) {
			let elements = Array.from(document.getElementsByClassName(tagsForSearch[i])).filter(el => {
				const style = window.getComputedStyle(el);

				const isHidden = style.display === 'none';
				const hasUnderlineDouble = style.textDecoration.includes('underline') && style.textDecorationStyle === 'double';
				const hasUnderlineDashed = style.textDecorationLine === 'underline' && style.textDecorationStyle === 'dashed';

				return !isHidden && !hasUnderlineDouble && !hasUnderlineDashed;
			});

			if (m.seen) {
				styleSeen(m.seen, elements);
			}
			if (m.blocked) {
				styleBlocked(m.blocked, elements);
			}
			if (m.favorited) {
				styleFavorited(m.favorited, elements);
			}
		}
	}
});

// Collect list of links

let hrefs = [];

for (let i = 0; i < document.links.length; i++) {
    let item = document.links[i];
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
			for (let i = 0; i < tagsForSearch.length; i++) {
				let elements = Array.from(document.getElementsByClassName(tagsForSearch[i])).filter(el => {
					const style = window.getComputedStyle(el);

                    // filter out hidden elements and those already styled
					const isHidden = style.display === 'none';
					const hasUnderlineDouble = style.textDecoration.includes('underline') && style.textDecorationStyle === 'double';
					const hasUnderlineDashed = style.textDecorationLine === 'underline' && style.textDecorationStyle === 'dashed';

					return !isHidden && !hasUnderlineDouble && !hasUnderlineDashed;
				});

				if (m.seen) {
					styleSeen(m.seen, elements);
				}
				if (m.blocked) {
					styleBlocked(m.blocked, elements);
				}
				if (m.favorited) {
					styleFavorited(m.favorited, elements);
				}
			}
		}
	});

	let hrefs = [];

	for (let i = 0; i < document.links.length; i++) {
		let item = document.links[i];
		hrefs.push(item.href);
	}
		
	port.postMessage({hrefs: hrefs});
}

function styleBlocked(blocked, divs) {
	// hide links of blocked bookmarks
	for (let x = 0; x < divs.length; x++) {
		let div = divs[x];
		let content = div.innerHTML.trim();
		for (let y = 0; y < blocked.length; y++) {
			let currentURL = new URL(blocked[y].url).pathname;
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
	
	for (let i = 0; i < document.links.length; i++) {
		let link = document.links[i];
		for (let y = 0; y < blocked.length; y++) {
			let currentURL = new URL(blocked[y].url).pathname;
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
	for (let x = 0; x < divs.length; x++) {
		let div = divs[x];
		let content = div.innerHTML.trim();
		for (let y = 0; y < favorited.length; y++) {
			let currentURL = new URL(favorited[y].url).pathname;
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
	
	for (let i = 0; i < document.links.length; i++) {
		let link = document.links[i];
		for (let y = 0; y < favorited.length; y++) {
			let currentURL = new URL(favorited[y].url).pathname;
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
	for (let x = 0; x < divs.length; x++) {
		let div = divs[x];
		let content = div.innerHTML.trim();	
		for (let y = 0; y < seen.length; y++) {
			let currentURL = new URL(seen[y].url).pathname;
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
	
	for (let i = 0; i < document.links.length; i++) {
		let link = document.links[i];
		for (let y = 0; y < seen.length; y++) {
			let currentURL = new URL(seen[y].url).pathname;
			if (currentURL !== '/') {
				if(link.href.includes(new URL(seen[y].url).pathname)) {
					link.style.cssText += ';' + 'text-decoration: underline dashed;';
				}
			}
		}
	}
}