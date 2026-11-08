const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'tv-media.js'), 'utf8');

function harness(mode = 'allowed') {
    let now = 0, id = 0, token = 1, unlocked = false;
    const timers = new Map(), calls = [], loads = [];
    function element() {
        const handlers = {}, classes = new Set();
        return {
            style: {}, attributes: {},
            classList: { add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c) },
            addEventListener: (name, cb) => { (handlers[name] ||= []).push(cb); },
            dispatch(name, values = {}) {
                const event = { type: name, preventDefault() {}, ...values };
                if (this['on' + name]) this['on' + name](event);
                for (const fn of handlers[name] || []) fn(event);
            },
            setAttribute(name, value) { this.attributes[name] = value; },
            removeAttribute(name) { delete this.attributes[name]; if (name === 'src') this.src = ''; },
            focus() { document.activeElement = this; }
        };
    }
    const document = element(), video = element(), button = element();
    video.paused = true; video.readyState = 0; video.volume = 1;
    video.pause = () => { video.paused = true; };
    video.load = () => {
        video.readyState = video.src ? 4 : 0;
        video.ended = false;
        video.error = null;
        if (video.src) loads.push({ src: video.src, muted: video.muted, volume: video.volume, defaultMuted: video.defaultMuted });
    };
    video.play = () => {
        calls.push(['play']);
        if (mode !== 'allowed' && !unlocked) {
            if (mode === 'legacy') return undefined;
            return Promise.reject(Object.assign(new Error('Blocked'), { name: 'NotAllowedError' }));
        }
        video.paused = false;
        video.dispatch('playing');
        return mode === 'legacy' ? undefined : Promise.resolve();
    };
    const window = {};
    const context = vm.createContext({ window, document,
        setTimeout(fn, ms) { timers.set(++id, { at: now + ms, fn }); return id; },
        clearTimeout(key) { timers.delete(key); }
    });
    vm.runInContext(source, context);
    const callbacks = { isCurrent: n => n === token };
    for (const name of ['onPlaying', 'onProgress', 'onEnded', 'onBlocked', 'onError']) {
        callbacks[name] = (...args) => calls.push([name, ...args]);
    }
    const player = new window.TVMediaPlayer(video, button, callbacks);
    return { player, video, button, document, calls, loads,
        setToken(n) { token = n; },
        press(code = 13) { unlocked = true; document.dispatch('keydown', { keyCode: code }); },
        tick(ms) {
            const end = now + ms;
            while (true) {
                const next = [...timers].filter(([,t]) => t.at <= end).sort((a,b) => a[1].at-b[1].at)[0];
                if (!next) break;
                now = next[1].at; timers.delete(next[0]); next[1].fn();
            }
            now = end;
        }
    };
}

test('autoplays with both mute flags and volume zero before loading', async () => {
    const h = harness();
    h.player.open('first.mp4', 1);
    await Promise.resolve();
    assert.deepEqual(h.loads, [{ src: 'first.mp4', muted: true, volume: 0, defaultMuted: true }]);
    assert.equal(h.video.paused, false);
    assert.equal(h.button.classList.contains('show'), false);
});

test('policy block waits for a remote gesture without skipping the video', async () => {
    const h = harness('blocked');
    h.player.open('first.mp4', 1);
    await Promise.resolve();
    assert.equal(h.button.classList.contains('show'), true);
    h.tick(120000);
    assert.equal(h.calls.some(c => c[0] === 'onError' || c[0] === 'onEnded'), false);
    h.press(415);
    await Promise.resolve();
    assert.equal(h.video.paused, false);
    assert.equal(h.button.classList.contains('show'), false);
    h.player.stop();
    h.setToken(2);
    h.player.open('second.mp4', 2);
    await Promise.resolve();
    assert.equal(h.video.paused, false);
    assert.equal(h.calls.filter(c => c[0] === 'onBlocked').length, 1);
});

test('legacy play() returning undefined still exposes and recovers a silent block', () => {
    const h = harness('legacy');
    h.player.open('first.mp4', 1);
    h.tick(1200);
    assert.equal(h.button.classList.contains('show'), true);
    h.press();
    assert.equal(h.video.paused, false);
    assert.equal(h.button.classList.contains('show'), false);
});

test('a late rejection from the previous clip cannot block its replacement', async () => {
    const h = harness();
    const play = h.video.play;
    let rejectOld;
    h.video.play = () => new Promise((_, reject) => { rejectOld = reject; });
    h.player.open('old.mp4', 1);
    h.setToken(2);
    h.video.play = play;
    h.player.open('new.mp4', 2);
    rejectOld({ name: 'NotAllowedError' });
    await Promise.resolve();
    assert.equal(h.video.paused, false);
    assert.equal(h.button.classList.contains('show'), false);
    assert.equal(h.calls.some(c => c[0] === 'onBlocked'), false);
});

test('normal progress cancels a stale network-stall timer', () => {
    const h = harness();
    h.player.open('first.mp4', 1);
    h.video.dispatch('stalled');
    h.video.dispatch('timeupdate');
    h.tick(31000);
    assert.equal(h.calls.some(c => c[0] === 'onError'), false);
});

test('media errors advance only once and old handlers cannot advance another clip', () => {
    const h = harness();
    h.player.open('first.mp4', 1);
    const oldEnded = h.video.onended;
    h.video.error = { code: 4 };
    h.video.dispatch('error');
    h.video.dispatch('error');
    assert.equal(h.calls.filter(c => c[0] === 'onError').length, 1);
    h.setToken(2); h.player.open('second.mp4', 2);
    oldEnded();
    assert.equal(h.calls.some(c => c[0] === 'onEnded'), false);
});

test('a queued ended event for the previous source cannot skip the current video', () => {
    const h = harness();
    h.player.open('first.mp4', 1);
    h.video.ended = true;
    h.video.dispatch('ended');
    h.setToken(2); h.player.open('second.mp4', 2);
    h.video.dispatch('ended');
    assert.equal(h.calls.filter(c => c[0] === 'onEnded').length, 1);
});
