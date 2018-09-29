'use strict';
const path = require('path');
const electron = require('electron');
const unusedFilename = require('unused-filename');
const pupa = require('pupa');
const extName = require('ext-name');

const {app, shell} = electron;

function getFilenameFromMime(name, mime) {
	const exts = extName.mime(mime);

	if (exts.length !== 1) {
		return name;
	}

	return `${name}.${exts[0].ext}`;
}

const sessionListenerMap = new Map();
const handlerMap = new Map();
const downloadItems = new Set();
let receivedBytes = 0;
let completedBytes = 0;
let totalBytes = 0;
const activeDownloadItems = () => downloadItems.size;
const progressDownloadItems = function (item) {
	if (item) {
		return item.getReceivedBytes() / item.getTotalBytes();
	}
	return receivedBytes / totalBytes;
};

function registerListener(session) {
	const listener = (e, item, webContents) => {
		const urlChains = item.getURLChain();
		const originUrl = urlChains[0];
		const key = decodeURIComponent(originUrl);
		const defaultHanlder = {
			options: {},
			resolve: () => { },
			reject: () => { }
		};
		const {options, resolve, reject} = handlerMap.get(key) || defaultHanlder;

		downloadItems.add(item);
		totalBytes += item.getTotalBytes();

		let hostWebContents = webContents;
		if (webContents.getType() === 'webview') {
			({hostWebContents} = webContents);
		}
		const win = electron.BrowserWindow.fromWebContents(hostWebContents);

		const dir = options.directory || app.getPath('downloads');
		let filePath;
		if (options.filename) {
			filePath = path.join(dir, options.filename);
		} else {
			const filename = item.getFilename();
			const name = path.extname(filename) ? filename : getFilenameFromMime(filename, item.getMimeType());

			filePath = unusedFilename.sync(path.join(dir, name));
		}

		const errorMessage = options.errorMessage || 'The download of {filename} was interrupted';
		const errorTitle = options.errorTitle || 'Download Error';

		if (!options.saveAs) {
			item.setSavePath(filePath);
		}

		item.on('updated', () => {
			receivedBytes = [...downloadItems].reduce((receivedBytes, item) => {
				receivedBytes += item.getReceivedBytes();
				return receivedBytes;
			}, completedBytes);

			if (!win.isDestroyed()) {
				win.setProgressBar(progressDownloadItems());
			}

			if (typeof options.onProgress === 'function') {
				options.onProgress(progressDownloadItems(item));
			}
		});

		item.once('done', (e, state) => {
			completedBytes += item.getTotalBytes();
			downloadItems.delete(item);

			if (!win.isDestroyed() && !activeDownloadItems()) {
				win.setProgressBar(-1);
				receivedBytes = 0;
				completedBytes = 0;
				totalBytes = 0;
			}

			if (state === 'interrupted') {
				const message = pupa(errorMessage, {filename: item.getFilename()});
				electron.dialog.showErrorBox(errorTitle, message);
				reject(new Error(message));
			} else if (state === 'cancelled') {
				reject(new Error('The download has been cancelled'));
			} else if (state === 'completed') {
				if (process.platform === 'darwin') {
					app.dock.downloadFinished(filePath);
				}

				if (options.openFolderWhenDone) {
					shell.showItemInFolder(filePath);
				}

				resolve(item);
			}
			if (handlerMap.has(key)) {
				handlerMap.delete(key);
			}
		});
	};

	if (!sessionListenerMap.get(session)) {
		sessionListenerMap.set(session, true);
		session.on('will-download', listener);
	}
}

function unregisterListener (session) {
	if (sessionListenerMap.has(session)) {
		sessionListenerMap.delete(session);
	}
}

module.exports = (options = {}) => {
	app.on('session-created', session => {
		registerListener(session, options);
		app.on('close', () => unregisterListener(session));
	});
};

module.exports.download = (win, url, options) => new Promise((resolve, reject) => {
	options = Object.assign({}, options, {unregisterWhenDone: true});

	const key = decodeURIComponent(url);
	handlerMap.set(key, {options, resolve, reject});
	registerListener(win.webContents.session);
	win.on('close', () => unregisterListener(win.webContents.session));

	win.webContents.downloadURL(url);
});
