const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const midnight = Date.parse('2026-11-16T00:00:00+02:00');
const playlist = fs.readFileSync(path.join(__dirname, '..', 'harlem-playlist-1.md'), 'utf8');
const tournament = 'https://hrlm.bg/tournament/display';

function harness(filename, initialTime = midnight - 3600000) {
    const html = fs.readFileSync(path.join(__dirname, '..', filename), 'utf8');
    const source = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]).join('\n');
    const timers = new Map(), elements = new Map();
    let now = initialTime, id = 0;
    const element = () => ({ style: {}, innerHTML: '', classList: { toggle() {} }, appendChild() {} });
    class Clock extends Date { static now() { return now; } }
    const context = vm.createContext({
        Date: Clock,
        window: { location: { href: 'https://refractionx.github.io/screens-playlists/' + filename } },
        document: {
            getElementById(name) { if (!elements.has(name)) elements.set(name, element()); return elements.get(name); },
            createElement: element,
            addEventListener() {}
        },
        TVMediaPlayer: class { stop() {} open() {} },
        fetch: () => new Promise(() => {}),
        setTimeout(fn, ms) { timers.set(++id, { fn, ms }); return id; },
        clearTimeout(key) { timers.delete(key); },
        setInterval() {},
        playlist,
        midnight,
        tournament
    });
    vm.runInContext(source, context);
    return { context, timers, time(value) { now = value; }, run(code) { return vm.runInContext(code, context); } };
}

for (const filename of ['player-1.html', 'player-2.html']) {
    test(filename + ': five one-minute tournament slots today, original rotation after midnight', () => {
        const h = harness(filename);
        const before = JSON.parse(h.run('JSON.stringify(parsePlaylist(playlist).filter(item => isScheduledNow(item, midnight - 1)))'));
        const after = JSON.parse(h.run('JSON.stringify(parsePlaylist(playlist).filter(item => isScheduledNow(item, midnight)))'));
        const today = before.filter(item => item.url === tournament);
        const tomorrow = after.filter(item => item.url === tournament);
        assert.equal(today.length, 5);
        assert(today.every(item => item.duration === 60));
        assert.equal(tomorrow.length, 1);
        assert.equal(tomorrow[0].duration, 30);
        assert.deepEqual(before.filter(item => item.url !== tournament), after.filter(item => item.url !== tournament));
        assert.equal(before.filter(item => item.url !== tournament).length, 25);
        assert.equal(h.run('isScheduledNow({ until: "invalid" })'), false);
        assert.equal(h.run('isScheduledNow({ from: midnight }, midnight - 1)'), false);
    });

    test(filename + ': cached expired slots are skipped and an active slot ends at midnight', () => {
        const h = harness(filename, midnight - 15000);
        h.run('items = [{ url: tournament, duration: 60, until: midnight }, { url: "https://example.test/regular", duration: 30 }]; playItem(0)');
        assert.equal(h.run('currentIndex'), 0);
        assert.equal([...h.timers.values()].at(-1).ms, 15000);
        h.time(midnight);
        h.run('playItem(0)');
        assert.equal(h.run('currentIndex'), 1);
        assert.equal([...h.timers.values()].at(-1).ms, 30000);
        h.run('items = [{ url: tournament, until: midnight }]; playItem(0)');
        assert.equal(h.run('items.length'), 0);
        assert.equal([...h.timers.values()].at(-1).ms, 30000);
    });

    test(filename + ': unchanged playlist switches schedule on refresh', async () => {
        const h = harness(filename);
        h.context.fetch = async () => ({ ok: true, text: async () => playlist });
        await h.run('checkPlaylistUpdate()');
        assert.equal(h.run('items.filter(item => item.url === tournament).length'), 5);
        h.time(midnight);
        await h.run('checkPlaylistUpdate()');
        assert.equal(h.run('items.filter(item => item.url === tournament).length'), 1);
        assert.equal(h.run('items.find(item => item.url === tournament).duration'), 30);
    });
}
