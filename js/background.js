
//This is the background script. It is responsible for actually redirecting requests,
//as well as monitoring changes in the redirects and the disabled status and reacting to them.
function log(msg, force) {
	if (log.enabled || force) {
		console.log('REDIRECTOR: ' + msg);
	}
}
log.enabled = false;
var enableNotifications = false;

function isDarkMode() {
	return window.matchMedia('(prefers-color-scheme: dark)').matches;
}
var isFirefox = !!navigator.userAgent.match(/Firefox/i);

var storageArea = chrome.storage.local;
//Redirects partitioned by request type, so we have to run through
//the minimum number of redirects for each request.
var partitionedRedirects = {};

//Cache of urls that have just been redirected to. They will not be redirected again, to
//stop recursive redirects, and endless redirect chains.
//Key is url, value is timestamp of redirect.
var ignoreNextRequest = {

};

//url => { timestamp:ms, count:1...n};
var justRedirected = {

};
var redirectThreshold = 3;

function setIcon(image) {
	var data = {
		path: {}
	};

	for (let nr of [16, 19, 32, 38, 48, 64, 128]) {
		data.path[nr] = `images/${image}-${nr}.png`;
	}

	chrome.browserAction.setIcon(data, function () {
		var err = chrome.runtime.lastError;
		if (err) {
			//If not checked we will get unchecked errors in the background page console...
			log('Error in SetIcon: ' + err.message);
		}
	});
}

//This is the actual function that gets called for each request and must
//decide whether or not we want to redirect.
function checkRedirects(details) {

	//We only allow GET request to be redirected, don't want to accidentally redirect
	//sensitive POST parameters
	if (details.method != 'GET') {
		return {};
	}
	log('Checking: ' + details.type + ': ' + details.url);

	var list = partitionedRedirects[details.type];
	if (!list) {
		log('No list for type: ' + details.type);
		return {};
	}

	var timestamp = ignoreNextRequest[details.url];
	if (timestamp) {
		log('Ignoring ' + details.url + ', was just redirected ' + (new Date().getTime() - timestamp) + 'ms ago');
		delete ignoreNextRequest[details.url];
		return {};
	}


	for (var i = 0; i < list.length; i++) {
		var r = list[i];
		var result = r.getMatch(details.url);

		if (result.isMatch) {

			//Check if we're stuck in a loop where we keep redirecting this, in that
			//case ignore!
			var data = justRedirected[details.url];

			var threshold = 3000;
			if (!data || ((new Date().getTime() - data.timestamp) > threshold)) { //Obsolete after 3 seconds
				justRedirected[details.url] = { timestamp: new Date().getTime(), count: 1 };
			} else {
				data.count++;
				justRedirected[details.url] = data;
				if (data.count >= redirectThreshold) {
					log('Ignoring ' + details.url + ' because we have redirected it ' + data.count + ' times in the last ' + threshold + 'ms');
					return {};
				}
			}


			log('Redirecting ' + details.url + ' ===> ' + result.redirectTo + ', type: ' + details.type + ', pattern: ' + r.includePattern + ' which is in Rule : ' + r.description);
			if (enableNotifications) {
				sendNotifications(r, details.url, result.redirectTo);
			}
			ignoreNextRequest[result.redirectTo] = new Date().getTime();

			return { redirectUrl: result.redirectTo };
		}
	}

	return {};
}

//Monitor changes in data, and setup everything again.
//This could probably be optimized to not do everything on every change
//but why bother?
function monitorChanges(changes, namespace) {
	if (changes.disabled) {
		updateIcon();

		if (changes.disabled.newValue == true) {
			log('Disabling Redirector, removing listener');
			chrome.webRequest.onBeforeRequest.removeListener(checkRedirects);
			chrome.webNavigation.onHistoryStateUpdated.removeListener(checkHistoryStateRedirects);
		} else {
			log('Enabling Redirector, setting up listener');
			setUpRedirectListener();
		}
	}
	if (changes.logging) {
		log.enabled = changes.logging.newValue;
		log('Logging settings have changed to ' + changes.logging.newValue, true); //Always want this to be logged...
	}
	if (changes.enableNotifications) {
		log('notifications setting changed to ' + changes.enableNotifications.newValue);
		enableNotifications = changes.enableNotifications.newValue;
	}
}
chrome.storage.onChanged.addListener(monitorChanges);

//Creates a filter to pass to the listener so we don't have to run through
//all the redirects for all the request types we don't have any redirects for anyway.
function createFilter(redirects) {
	var types = [];
	for (var i = 0; i < redirects.length; i++) {
		redirects[i].appliesTo.forEach(function (type) {
			// Added this condition below as part of fix for issue 115 https://github.com/einaregilsson/Redirector/issues/115
			// Firefox considers responsive web images request as imageset. Chrome doesn't.
			// Chrome throws an error for imageset type, so let's add to 'types' only for the values that chrome or firefox supports
			if (chrome.webRequest.ResourceType[type.toUpperCase()] !== undefined) {
				if (types.indexOf(type) == -1) {
					types.push(type);
				}
			}
		});
	}
	types.sort();

	return {
		urls: ["https://*/*", "http://*/*"],
		types: types
	};
}

function createPartitionedRedirects(redirects) {
	var partitioned = {};

	for (var i = 0; i < redirects.length; i++) {
		var redirect = new Redirect(redirects[i]);
		redirect.compile();
		for (var j = 0; j < redirect.appliesTo.length; j++) {
			var requestType = redirect.appliesTo[j];
			if (partitioned[requestType]) {
				partitioned[requestType].push(redirect);
			} else {
				partitioned[requestType] = [redirect];
			}
		}
	}
	return partitioned;
}

//Sets up the listener, partitions the redirects, creates the appropriate filters etc.
function setUpRedirectListener() {
	chrome.webRequest.onBeforeRequest.removeListener(checkRedirects); //Unsubscribe first, in case there are changes...
	chrome.webNavigation.onHistoryStateUpdated.removeListener(checkHistoryStateRedirects);

	loadRedirects().then(redirects => {
		if (redirects.length == 0) {
			log('No redirects defined, not setting up listener');
			return;
		}

		partitionedRedirects = createPartitionedRedirects(redirects);
		var filter = createFilter(redirects);

		log('Setting filter for listener: ' + JSON.stringify(filter));
		chrome.webRequest.onBeforeRequest.addListener(checkRedirects, filter, ["blocking"]);

		if (partitionedRedirects.history) {
			log('Adding HistoryState Listener');

			let filter = { url: [] };
			for (let r of partitionedRedirects.history) {
				filter.url.push({ urlMatches: r._preparePattern(r.includePattern) });
			}
			chrome.webNavigation.onHistoryStateUpdated.addListener(checkHistoryStateRedirects, filter);
		}
	});
}

//Redirect urls on places like Facebook and Twitter who don't do real reloads, only do ajax updates and push a new url to the address bar...
function checkHistoryStateRedirects(ev) {
	ev.type = 'history';
	ev.method = 'GET';
	let result = checkRedirects(ev);
	if (result.redirectUrl) {
		chrome.tabs.update(ev.tabId, { url: result.redirectUrl });
	}
}

//Sets on/off badge, and for Chrome updates dark/light mode icon
function updateIcon() {
	chrome.storage.local.get({ disabled: false }, function (obj) {

		//Do this here so even in Chrome we get the icon not too long after an dark/light mode switch...
		if (!isFirefox) {
			if (isDarkMode()) {
				setIcon('icon-dark-theme');
			} else {
				setIcon('icon-light-theme');
			}
		}

		if (obj.disabled) {
			chrome.browserAction.setBadgeText({ text: 'off' });
			chrome.browserAction.setBadgeBackgroundColor({ color: '#fc5953' });
			if (chrome.browserAction.setBadgeTextColor) { //Not supported in Chrome
				chrome.browserAction.setBadgeTextColor({ color: '#fafafa' });
			}
		} else {
			chrome.browserAction.setBadgeText({ text: 'on' });
			chrome.browserAction.setBadgeBackgroundColor({ color: '#35b44a' });
			if (chrome.browserAction.setBadgeTextColor) { //Not supported in Chrome
				chrome.browserAction.setBadgeTextColor({ color: '#fafafa' });
			}
		}
	});
}

const clearRedirects = (storage, start = 0) => new Promise(resolve => storage.remove(
	Array.from(
		{ length: Math.ceil(storage.QUOTA_BYTES_PER_ITEM ? storage.QUOTA_BYTES / storage.QUOTA_BYTES_PER_ITEM : 0) - start + 1 },
		(_, i) => `r_${(i + start).toString(16)}`
	), resolve)
);

/**
 * @returns {Promise<any[]>}
 */
const loadRedirects = () => new Promise(resolve => storageArea.get(null, obj => resolve(
	Object.entries(obj)
		.filter(([k]) => k.startsWith('r_'))
		.map(([, v]) => v)
		.flat()
)));

async function saveRedirects(redirects) {
	console.log('Saving redirects, count=' + redirects.length);

	const chunked = {}, max_item_size = storageArea.QUOTA_BYTES_PER_ITEM ?? storageArea.QUOTA_BYTES;

	let idx = 0;
	let current_chunk = [], chunk_size = 5; // 'r_X' + '[]'
	for (const r of redirects) {
		const size = JSON.stringify(r).length + 1; // +1 for comma

		if (chunk_size + size > max_item_size) {
			chunked[`r_${(idx++).toString(16)}`] = current_chunk;
			chunk_size = 5;
			current_chunk = [];
		}

		chunk_size += size;
		current_chunk.push(r);
	}
	if (idx * max_item_size + chunk_size > storageArea.QUOTA_BYTES) {
		throw 'Redirects failed to save, storage quota exceeded!';
	}

	if (current_chunk.length) {
		chunked[`r_${(idx++).toString(16)}`] = current_chunk;
	}

	await clearRedirects(storageArea, idx);

	return new Promise((resolve, reject) => storageArea.set(chunked, () => {
		if (chrome.runtime.lastError) {
			if (chrome.runtime.lastError.message.indexOf("quota exceeded") > -1) {
				log("Redirects failed to save as size of redirects larger than allowed limit per item by Sync");
				reject("Redirects failed to save as size of redirects larger than what's allowed by Sync");
			} else {
				log('Redirects failed to save: ' + chrome.runtime.lastError.message);
				reject(chrome.runtime.lastError.message);
			}
		} else {
			log('Finished saving redirects to storage');
			resolve();
		}
	})).then(() => setUpRedirectListener());
}

//Firefox doesn't allow the "content script" which is actually privileged
//to access the objects it gets from chrome.storage directly, so we
//proxy it through here.
chrome.runtime.onMessage.addListener((request, _, sendResponse) => {
	log('Received background message: ' + JSON.stringify(request));
	if (request.type == 'get-redirects') {
		log('Getting redirects from storage');
		loadRedirects().then(redirects => {
			sendResponse({ redirects });
			log('Sent redirects to content page');
		});
	} else if (request.type == 'save-redirects') {
		saveRedirects(request.redirects).then(() => {
			sendResponse({ message: "Redirects saved" });
		}).catch((e) => {
			sendResponse({ message: e });
		});
	} else if (request.type == 'update-icon') {
		updateIcon();
	} else if (request.type == 'toggle-sync') {
		// Notes on Toggle Sync feature here https://github.com/einaregilsson/Redirector/issues/86#issuecomment-389943854
		// This provides for feature request - issue 86
		log('toggling sync to ' + request.isSyncEnabled);

		// Setting for Sync enabled or not, resides in Local.
		chrome.storage.local.set({ isSyncEnabled: request.isSyncEnabled }, async () => {
			const redirects = await loadRedirects();

			storageArea = request.isSyncEnabled ? chrome.storage.sync : chrome.storage.local;
			log('storageArea size is ' + storageArea.QUOTA_BYTES + ', ' + Math.floor(storageArea.QUOTA_BYTES_PER_ITEM ? storageArea.QUOTA_BYTES / storageArea.QUOTA_BYTES_PER_ITEM : 1) + ' partition(s)');

			if (redirects.length > 0) {
				await saveRedirects(redirects);

				log('redirects saved to new storage');
				setUpRedirectListener();
			} else {
				log('No redirects are setup currently in Local, just enabling Sync');
			}

			if (request.isSyncEnabled) {
				await clearRedirects(chrome.storage.local);
				sendResponse({ message: "sync-enabled" });
			} else {
				await clearRedirects(chrome.storage.sync);
				sendResponse({ message: "sync-disabled" });
			}
		});
	} else {
		log('Unexpected message: ' + JSON.stringify(request));
		return false;
	}

	return true; //This tells the browser to keep sendResponse alive because
	//we're sending the response asynchronously.
});


//First time setup
updateIcon();

chrome.storage.local.get({
	logging: false,
	isSyncEnabled: false,
	enableNotifications: false,
	disabled: false,
}, (obj) => {
	log.enabled = obj.logging;
	storageArea = obj.isSyncEnabled ? chrome.storage.sync : chrome.storage.local;
	enableNotifications = obj.enableNotifications;

	if (!obj.disabled) {
		setUpRedirectListener();
	} else {
		log('Redirector is disabled');
	}
});

log('Redirector starting up...');


// Below is a feature request by an user who wished to see visual indication for an Redirect rule being applied on URL
// https://github.com/einaregilsson/Redirector/issues/72
// By default, we will have it as false. If user wishes to enable it from settings page, we can make it true until user disables it (or browser is restarted)

// Upon browser startup, just set enableNotifications to false.
// Listen to a message from Settings page to change this to true.
function sendNotifications(redirect, originalUrl, redirectedUrl) {
	//var message = "Applied rule : " + redirect.description + " and redirected original page " + originalUrl + " to " + redirectedUrl;
	log("Showing redirect success notification");
	//Firefox and other browsers does not yet support "list" type notification like in Chrome.
	// Console.log(JSON.stringify(chrome.notifications)); -- This will still show "list" as one option but it just won't work as it's not implemented by Firefox yet
	// Can't check if "chrome" typeof either, as Firefox supports both chrome and browser namespace.
	// So let's use useragent.
	// Opera UA has both chrome and OPR. So check against that ( Only chrome which supports list) - other browsers to get BASIC type notifications.

	let icon = isDarkMode() ? "images/icon-dark-theme-48.png" : "images/icon-light-theme-48.png";

	if (navigator.userAgent.toLowerCase().indexOf("chrome") > -1 && navigator.userAgent.toLowerCase().indexOf("opr") < 0) {

		var items = [{ title: "Original page: ", message: originalUrl }, { title: "Redirected to: ", message: redirectedUrl }];
		var head = "Redirector - Applied rule : " + redirect.description;
		chrome.notifications.create({
			type: "list",
			items: items,
			title: head,
			message: head,
			iconUrl: icon
		});
	}
	else {
		var message = "Applied rule : " + redirect.description + " and redirected original page " + originalUrl + " to " + redirectedUrl;

		chrome.notifications.create({
			type: "basic",
			title: "Redirector",
			message: message,
			iconUrl: icon
		});
	}
}

chrome.runtime.onStartup.addListener(handleStartup);
function handleStartup() {
	enableNotifications = false;
	chrome.storage.local.set({
		enableNotifications: false
	});

	updateIcon(); //To set dark/light icon...

	//This doesn't work yet in Chrome, but we'll put it here anyway, in case it starts working...
	let darkModeMql = window.matchMedia('(prefers-color-scheme: dark)');
	darkModeMql.onchange = updateIcon;
}