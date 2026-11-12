'use strict';

/**
 * Offscreen documents only get chrome.runtime, never chrome.storage
 * (documented Chrome behavior). The service worker therefore keeps the
 * automatic-login hashes and the renewed sessions for the offscreen document,
 * and only answers the offscreen document itself.
 */

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
const OFFSCREEN_URL = 'chrome-extension://test-extension-id/offscreen.html';

function resetListeners() {
  ['onMessage', 'onInstalled', 'onStartup'].forEach((e) => { global.chrome.runtime[e]._listeners.length = 0; });
  global.chrome.tabs.onRemoved._listeners.length = 0;
  global.chrome.contextMenus.onClicked._listeners.length = 0;
  global.chrome.alarms.onAlarm._listeners.length = 0;
  global.chrome.storage.onChanged._listeners.length = 0;
  global.chrome.webRequest.onBeforeRequest._listeners.length = 0;
  global.chrome.commands.onCommand._listeners.length = 0;
}

function send(request, sender) {
  const listeners = global.chrome.runtime.onMessage._listeners;
  const handler = listeners[listeners.length - 1];
  return new Promise((resolve) => handler(request, { id: chrome.runtime.id, ...sender }, resolve));
}

describe('service worker storage for the offscreen document', () => {
  beforeEach(() => {
    global.__resetChromeStorage();
    jest.clearAllMocks();
    resetListeners();
    jest.resetModules();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    require('../../background.js');
  });
  afterEach(() => console.log.mockRestore());

  const record = { email: 'user@example.org', loginSecret: { words: [1], sigBytes: 4 }, deviceSecret: { words: [2], sigBytes: 4 } };

  it('refuses tabs and other extension pages', async () => {
    global.__getLocalStore().MYJD_RELOGIN = true;
    global.__getLocalStore().myjd_relogin = record;

    expect(await send({ action: 'myjd-relogin-store', op: 'load' }, { tab: { id: 1 }, url: 'https://evil.example/' })).toEqual({ error: 'forbidden' });
    expect(await send({ action: 'myjd-relogin-store', op: 'load' }, { url: 'chrome-extension://test-extension-id/popup.html' })).toEqual({ error: 'forbidden' });
    expect(await send({ action: 'offscreen-session-update', data: 'x' }, { tab: { id: 1 }, url: OFFSCREEN_URL })).toEqual({ error: 'forbidden' });
  });

  it('saves and loads the hashes only while the setting is on', async () => {
    const store = global.__getLocalStore();
    await send({ action: 'myjd-relogin-store', op: 'save', data: record }, { url: OFFSCREEN_URL });
    expect(store.myjd_relogin).toBeUndefined();

    store.MYJD_RELOGIN = true;
    await send({ action: 'myjd-relogin-store', op: 'save', data: record }, { url: OFFSCREEN_URL });
    expect(store.myjd_relogin).toEqual(record);
    expect(await send({ action: 'myjd-relogin-store', op: 'load' }, { url: OFFSCREEN_URL })).toEqual({ record });

    store.MYJD_RELOGIN = false;
    expect(await send({ action: 'myjd-relogin-store', op: 'load' }, { url: OFFSCREEN_URL })).toEqual({ record: null });
    expect(store.myjd_relogin).toBeUndefined();
  });

  it('clear deletes the hashes', async () => {
    const store = global.__getLocalStore();
    store.MYJD_RELOGIN = true;
    store.myjd_relogin = record;
    await send({ action: 'myjd-relogin-store', op: 'clear' }, { url: OFFSCREEN_URL });
    expect(store.myjd_relogin).toBeUndefined();
  });

  it('stores a renewed session only while logged in', async () => {
    const store = global.__getLocalStore();
    await send({ action: 'offscreen-session-update', data: 'renewed' }, { url: OFFSCREEN_URL });
    expect(store.myjd_session).toBeUndefined();

    store.myjd_session = 'old';
    await send({ action: 'offscreen-session-update', data: 'renewed' }, { url: OFFSCREEN_URL });
    expect(store.myjd_session).toBe('renewed');
  });
});

describe('offscreen document without chrome.storage', () => {
  const offscreen = read('offscreen.js');

  it('does not wait for chrome.storage or warn on every start', () => {
    expect(offscreen).not.toMatch(/chrome\.storage not available, proceeding/);
    expect(offscreen).not.toMatch(/setTimeout\(function\(\) \{ waitForChromeStorage/);
  });

  it('never writes chrome.storage itself; login hands the session to the service worker', () => {
    expect(offscreen).not.toMatch(/chrome\.storage\.local\.(set|remove)/);
    expect(offscreen).toMatch(/sendResponse\(\{ success: true, data: data, sessionData: sessionData \}\)/);
    const background = read('background.js');
    expect(background).toMatch(/result\.sessionData[\s\S]{0,120}myjd_session: result\.sessionData/);
  });

  it('jdapi uses the service worker for the hashes when chrome.storage is missing', () => {
    const jdapi = read('vendor', 'js', 'jdapi.js');
    expect(jdapi).toMatch(/action: "myjd-relogin-store"/);
    expect(jdapi).toMatch(/action: "offscreen-session-update"/);
  });
});

describe('settings page', () => {
  it('no longer sends the unhandled cnl-support message', () => {
    expect(read('scripts', 'controllers', 'SettingsController.js')).not.toMatch(/name: "cnl-support"/);
  });
});
