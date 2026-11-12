'use strict';

/**
 * Behavioral coverage for the session recovery in vendor/js/jdapi.js.
 *
 * MyJDownloader answers AUTH_FAILED instead of TOKEN_INVALID for some sessions
 * it dropped (after hours, after sleep, or when another context of this
 * extension renewed the shared session first). jdapi used to take that for
 * wrong credentials, sent /my/disconnect and logged every context out.
 *
 * jdapi is loaded for real; only the HTTP layer (coreRequest) and the login
 * and reconnect calls of the request handler are replaced.
 */

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
const globalEval = eval; // indirect eval: runs in global scope like a <script>

// jQuery and CryptoJS once, as the extension pages load them.
globalEval(read('vendor', 'js', 'jquery.js'));
globalEval(read('vendor', 'crypto-js', 'components', 'core.js'));
globalEval(read('vendor', 'crypto-js', 'rollups', 'aes.js'));
globalEval(read('vendor', 'crypto-js', 'rollups', 'hmac-sha256.js'));
const jdapiSource = read('vendor', 'js', 'jdapi.js');

// chrome.storage.local with callbacks, the way jdapi calls it.
let local;
function installCallbackStorage() {
  local = {};
  const area = {
    get: jest.fn((keys, cb) => {
      const list = typeof keys === 'string' ? [keys] : (Array.isArray(keys) ? keys : Object.keys(local));
      const result = {};
      list.forEach((k) => { if (local[k] !== undefined) result[k] = local[k]; });
      setTimeout(() => cb(result), 0);
    }),
    set: jest.fn((items, cb) => {
      Object.assign(local, items);
      if (cb) setTimeout(cb, 0);
    }),
    remove: jest.fn((keys, cb) => {
      (Array.isArray(keys) ? keys : [keys]).forEach((k) => delete local[k]);
      if (cb) setTimeout(cb, 0);
    }),
    clear: jest.fn((cb) => { local = {}; if (cb) setTimeout(cb, 0); })
  };
  global.chrome.storage.local = area;
  global.chrome.runtime.lastError = null;
}

// Minimal AMD loader for jdapi's define() calls.
function loadJdapi({ sendRequest, handlerConnect, handlerReconnect, handlerDisconnect }) {
  const registry = {};
  const cache = {};
  global.define = (name, deps, factory) => { registry[name] = { deps, factory }; };
  globalEval(jdapiSource);
  delete global.define;

  const overrides = {
    coreRequest: () => {
      const FakeRequest = function (options) { this.options = options; };
      FakeRequest.prototype.send = function () { return sendRequest(this.options); };
      return FakeRequest;
    }
  };
  function req(name) {
    if (cache[name]) return cache[name];
    if (overrides[name]) return (cache[name] = overrides[name]());
    const mod = registry[name];
    cache[name] = mod.factory.apply(null, mod.deps.map(req));
    return cache[name];
  }
  const Handler = req('coreRequestHandler');
  Handler.prototype.connect = handlerConnect;
  Handler.prototype.reconnect = handlerReconnect;
  Handler.prototype.disconnect = handlerDisconnect;
  return { JDAPICore: req('coreCore'), Handler };
}

const sha = (s) => CryptoJS.SHA256(s);
function session(token) {
  return {
    email: 'user@example.org',
    sessiontoken: token,
    regaintoken: 'regain-' + token,
    serverEncryptionToken: sha('server-' + token),
    deviceEncryptionToken: sha('device-' + token),
    deviceSecret: sha('devicesecret')
  };
}
const resolved = (v) => $.Deferred().resolve(v);
const rejected = (e) => $.Deferred().reject(e);
const flush = () => new Promise((r) => setTimeout(r, 50));
const CORE_KEY = 'jdapi/src/core/core.js';
const CONNECTED = 0;
const DISCONNECTED = 3;

async function setup(overrides = {}) {
  const calls = { requests: [], connect: [], reconnect: 0, disconnect: 0 };
  const responses = overrides.responses || [];
  const deps = {
    sendRequest: (options) => {
      calls.requests.push(options.sessiontoken);
      const next = responses.shift();
      return next ? next(options) : resolved({ data: 'ok:' + options.sessiontoken });
    },
    handlerConnect: function (options) {
      calls.connect.push(options);
      if (calls.connect.length === 1) return resolved(session('s1'));
      return overrides.relogin ? overrides.relogin(options) : rejected({ type: 'AUTH_FAILED' });
    },
    handlerReconnect: function (options) {
      calls.reconnect++;
      if (overrides.reconnect) return overrides.reconnect(options);
      return rejected({ type: 'AUTH_FAILED' });
    },
    handlerDisconnect: function () {
      calls.disconnect++;
      return resolved();
    }
  };
  const { JDAPICore, Handler } = loadJdapi(deps);
  const core = new JDAPICore({}, null, 'test-app');
  await flush();
  return { core, calls, Handler };
}

beforeEach(() => {
  installCallbackStorage();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => console.warn.mockRestore());

const authFailed = () => rejected({ type: 'AUTH_FAILED' });

describe('jdapi session recovery', () => {
  it('takes over a newer session another context stored, without reconnect or logout', async () => {
    const { core, calls } = await setup({ responses: [authFailed] });
    local[CORE_KEY] = JSON.stringify(session('s2'));

    const result = await core.serverCall('/my/listdevices');

    expect(result).toEqual({ data: 'ok:s2' });
    expect(calls.requests).toEqual(['s1', 's2']);
    expect(calls.reconnect).toBe(0);
    expect(calls.disconnect).toBe(0);
    expect(core.getAPIState()).toBe(CONNECTED);
    expect(JSON.parse(local.myjd_session).sessiontoken).toBe('s2');
  });

  it('renews the session with the regain token when nothing newer is stored', async () => {
    const { core, calls } = await setup({
      responses: [authFailed],
      reconnect: (options) => { options.sessiontoken = 's3'; return resolved(); }
    });

    const result = await core.serverCall('/my/listdevices');

    expect(result).toEqual({ data: 'ok:s3' });
    expect(calls.reconnect).toBe(1);
    expect(calls.disconnect).toBe(0);
    expect(core.getAPIState()).toBe(CONNECTED);
  });

  it('ends the session locally, without /my/disconnect, when renewal fails and automatic login is off', async () => {
    const { core, calls } = await setup({ responses: [authFailed] });

    await expect(core.serverCall('/my/listdevices')).rejects.toEqual({ type: 'AUTH_FAILED' });

    expect(calls.disconnect).toBe(0);
    expect(calls.connect).toHaveLength(1); // only the initial login
    expect(core.getAPIState()).toBe(DISCONNECTED);
  });

  it('logs in again with the stored hashes when the setting is on', async () => {
    const { core, calls } = await setup({
      responses: [authFailed],
      relogin: () => resolved(session('s4'))
    });
    local.MYJD_RELOGIN = true;
    local.myjd_relogin = {
      email: 'user@example.org',
      loginSecret: { words: sha('login').words, sigBytes: 32 },
      deviceSecret: { words: sha('devicesecret').words, sigBytes: 32 }
    };

    const result = await core.serverCall('/my/listdevices');

    expect(result).toEqual({ data: 'ok:s4' });
    const relogin = calls.connect[1];
    expect(relogin.email).toBe('user@example.org');
    expect(relogin.pass).toBeUndefined();
    expect(relogin.loginSecret.words).toEqual(sha('login').words);
    expect(core.getAPIState()).toBe(CONNECTED);
  });

  it('ignores stored hashes while the setting is off and deletes them', async () => {
    const { core, calls } = await setup({ responses: [authFailed], relogin: () => resolved(session('s5')) });
    local.myjd_relogin = { email: 'x', loginSecret: { words: [1], sigBytes: 4 }, deviceSecret: { words: [1], sigBytes: 4 } };

    await expect(core.serverCall('/my/listdevices')).rejects.toBeDefined();

    expect(calls.connect).toHaveLength(1);
    expect(local.myjd_relogin).toBeUndefined();
  });

  it('drops the stored hashes when the automatic login itself is rejected', async () => {
    const { core } = await setup({ responses: [authFailed], relogin: () => rejected({ type: 'AUTH_FAILED' }) });
    local.MYJD_RELOGIN = true;
    local.myjd_relogin = { email: 'x', loginSecret: { words: [1], sigBytes: 4 }, deviceSecret: { words: [1], sigBytes: 4 } };

    await expect(core.serverCall('/my/listdevices')).rejects.toEqual({ type: 'AUTH_FAILED' });
    await flush();

    expect(local.myjd_relogin).toBeUndefined();
    expect(core.getAPIState()).toBe(DISCONNECTED);
  });

  it('keeps the session on a network error during renewal', async () => {
    const { core, calls } = await setup({
      responses: [authFailed],
      reconnect: () => rejected({ status: 0, statusText: 'error' })
    });

    await expect(core.serverCall('/my/listdevices')).rejects.toEqual({ type: 'CONNECTION_REFUSED' });

    expect(calls.disconnect).toBe(0);
    expect(core.getAPIState()).toBe(CONNECTED);
    expect(core.getSessionToken()).toBe('s1');
  });

  it('recovers once for parallel requests and settles each of them', async () => {
    // Both requests are in flight before the first rejection arrives.
    const authFailedLater = () => {
      const def = $.Deferred();
      setTimeout(() => def.reject({ type: 'AUTH_FAILED' }), 10);
      return def;
    };
    const { core, calls } = await setup({
      responses: [authFailedLater, authFailedLater],
      reconnect: (options) => { options.sessiontoken = 's6'; return resolved(); }
    });

    const results = await Promise.all([
      core.serverCall('/a'),
      core.serverCall('/b')
    ]);

    expect(results).toEqual([{ data: 'ok:s6' }, { data: 'ok:s6' }]);
    expect(calls.reconnect).toBe(1);
    expect(calls.requests.filter((t) => t === 's6')).toHaveLength(2);
  });

  it('does not loop when the renewed session is rejected again', async () => {
    const { core, calls } = await setup({
      responses: [authFailed, authFailed],
      reconnect: (options) => { options.sessiontoken = 's7'; return resolved(); }
    });

    await expect(core.serverCall('/a')).rejects.toEqual({ type: 'AUTH_FAILED' });

    expect(calls.reconnect).toBe(1);
    expect(calls.disconnect).toBe(0);
    expect(core.getAPIState()).toBe(CONNECTED);
  });

  it('an explicit logout deletes the stored hashes', async () => {
    const { core } = await setup();
    local.myjd_relogin = { email: 'x' };

    core.disconnect();
    await flush();

    expect(local.myjd_relogin).toBeUndefined();
  });
});

describe('jdapi login with stored hashes (real request handler)', () => {
  function loadRealHandler() {
    const registry = {};
    const cache = {};
    global.define = (name, deps, factory) => { registry[name] = { deps, factory }; };
    globalEval(jdapiSource);
    delete global.define;
    const req = (name) => cache[name] || (cache[name] = registry[name].factory.apply(null, registry[name].deps.map(req)));
    return req('coreRequestHandler');
  }

  let ajax;
  beforeEach(() => {
    ajax = jest.spyOn($, 'ajax').mockImplementation(() => $.Deferred());
  });
  afterEach(() => ajax.mockRestore());

  it('signs /my/connect with the stored login hash and never needs the password', () => {
    const Handler = loadRealHandler();
    const handler = new Handler('app', CryptoJS.enc.Hex, CORE_KEY, 'https://api.example');
    const loginSecret = sha('login');

    handler.connect({ email: 'user@example.org', loginSecret: loginSecret, deviceSecret: sha('devicesecret') });

    expect(ajax).toHaveBeenCalledTimes(1);
    const url = ajax.mock.calls[0][0].url;
    expect(url).toMatch(/^https:\/\/api\.example\/my\/connect\?email=user%40example\.org&appkey=app&rid=0&signature=/);
    const query = url.replace('https://api.example', '').replace(/&signature=.*$/, '');
    const expected = CryptoJS.HmacSHA256(CryptoJS.enc.Utf8.parse(query), loginSecret).toString(CryptoJS.enc.Hex);
    expect(url.endsWith('&signature=' + expected)).toBe(true);
  });

  it('a password login keeps the hashes only while the setting is on', async () => {
    const Handler = loadRealHandler();
    const handler = new Handler('app', CryptoJS.enc.Hex, CORE_KEY, 'https://api.example');
    const responses = [];
    ajax.mockImplementation((opts) => {
      const def = $.Deferred();
      responses.push(() => def.resolve({ rid: 0, sessiontoken: 'aa', regaintoken: 'bb' }));
      return def;
    });

    local.MYJD_RELOGIN = true;
    handler.connect({ email: 'User@Example.org', pass: 'secret' });
    responses.shift()();
    await flush();
    const record = local.myjd_relogin;
    expect(record.email).toBe('User@Example.org');
    expect(record.loginSecret.words).toEqual(sha('user@example.orgsecretserver').words);
    expect(JSON.stringify(record)).not.toContain('secret"');

    local.MYJD_RELOGIN = false;
    handler.connect({ email: 'User@Example.org', pass: 'secret' });
    responses.shift()();
    await flush();
    expect(local.myjd_relogin).toBeUndefined();
  });

  it('a waiting context takes over the session another context renewed', async () => {
    const Handler = loadRealHandler();
    const handler = new Handler('app', CryptoJS.enc.Hex, CORE_KEY, 'https://api.example');
    local['jdapi/src/core/coreRequestHandler.js'] = JSON.stringify({ time: Date.now() });
    const options = session('old');
    options.API_ROOT = 'https://api.example';

    const handshake = handler.reconnect(options, 1);
    setTimeout(() => { local[CORE_KEY] = JSON.stringify(session('renewed')); }, 100);
    await new Promise((resolve, reject) => handshake.then(resolve, reject));

    expect(options.sessiontoken).toBe('renewed');
    expect(ajax).not.toHaveBeenCalled();
  });
});

describe('Automatic login setting', () => {
  const storage = read('scripts', 'services', 'StorageService.js');
  const settings = read('scripts', 'controllers', 'SettingsController.js');
  const templates = read('partials', 'templateCache.js');

  it('defaults to off', () => {
    expect(storage).toMatch(/SETTINGS_MYJD_RELOGIN\s*=\s*"MYJD_RELOGIN"/);
    expect(storage).toMatch(/MYJD_RELOGIN:\s*\{\s*key:\s*StorageService\.SETTINGS_MYJD_RELOGIN,\s*defaultValue:\s*false\s*\}/);
  });

  it('is seeded, watched, persisted, and switching it off deletes the hashes', () => {
    expect(settings).toMatch(/"settings\."\s*\+\s*\$scope\.settingsKeys\.MYJD_RELOGIN\.key/);
    expect(settings).toMatch(/key:\s*\$scope\.settingsKeys\.MYJD_RELOGIN\.key,\s*value:\s*reloginEnabled/);
    expect(settings).toMatch(/if \(!reloginEnabled\)\s*\{\s*chrome\.storage\.local\.remove\(storageService\.MYJD_RELOGIN_STORAGE_KEY\)/);
  });

  it('has a checkbox and texts in every locale', () => {
    expect(templates).toMatch(/ng-model=\\"settings\[settingsKeys\.MYJD_RELOGIN\.key\]\\"/);
    ['en', 'de', 'es'].forEach((lang) => {
      const locale = JSON.parse(read('_locales', lang, 'messages.json'));
      expect(locale.ui_settings_myjd_relogin.message).toBeTruthy();
      expect(locale.ui_settings_myjd_relogin_description.message).toBeTruthy();
    });
  });

  it('StorageService writes only the keys it is given', () => {
    const set = storage.slice(storage.indexOf('this.set = function'), storage.indexOf('this.clear = function'));
    const setCollection = storage.slice(storage.indexOf('this.setCollection = function'), storage.indexOf('this.getCollection = function'));
    expect(set).not.toMatch(/getAll/);
    expect(setCollection).not.toMatch(/getAll/);
  });
});
