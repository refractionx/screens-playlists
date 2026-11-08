/* One persistent video surface for TVs that grant playback per media element.
 * Autoplay policies still require a real remote/button gesture on some browsers.
 * Use ES5 syntax here for older Samsung Internet engines.
 */
(function (root) {
    'use strict';

    function TVMediaPlayer(video, button, callbacks) {
        var active = null;
        var waitingTimer = null;
        var legacyTimer = null;
        var events = ['loadeddata', 'canplay', 'playing', 'timeupdate', 'ended', 'error', 'stalled'];

        function current(state) {
            return active === state && !state.done && callbacks.isCurrent(state.token);
        }

        function clearTimers() {
            clearTimeout(waitingTimer);
            clearTimeout(legacyTimer);
            waitingTimer = legacyTimer = null;
        }

        function hidePrompt() {
            button.classList.remove('show');
            if (document.activeElement === button) video.focus();
        }

        function blocked(state) {
            if (!current(state)) return;
            state.blocked = true;
            state.pending = false;
            clearTimers();
            callbacks.onBlocked(state.token);
            button.classList.add('show');
            button.focus();
        }

        function failed(state, message) {
            if (!current(state)) return;
            state.done = true;
            clearTimers();
            hidePrompt();
            callbacks.onError(state.token, message);
        }

        function waitForMedia(state, seconds) {
            clearTimeout(waitingTimer);
            waitingTimer = setTimeout(function () {
                if (!current(state) || state.blocked) return;
                if (video.paused && video.readyState >= 2) blocked(state);
                else failed(state, 'Video loading timed out');
            }, seconds * 1000);
        }

        function play(state, fromRemote) {
            if (!current(state) || (state.pending && !fromRemote) || (state.blocked && !fromRemote)) return;
            if (fromRemote) {
                state.blocked = false;
                waitForMedia(state, 45);
            }
            video.muted = true;
            video.volume = 0;
            state.pending = true;
            var attempt;
            function rejected(error) {
                if (!current(state)) return;
                state.pending = false;
                if (error && (error.name === 'NotAllowedError' || error.name === 'SecurityError')) {
                    blocked(state);
                } else if (!error || error.name !== 'AbortError') {
                    failed(state, 'Video could not start' + (error && error.name ? ': ' + error.name : ''));
                }
                // AbortError can come from a source change; readiness events retry it.
            }
            try {
                // Keep this synchronous inside a trusted key/click handler.
                attempt = video.play();
            } catch (error) {
                rejected(error);
                return;
            }
            if (attempt && typeof attempt.then === 'function') {
                attempt.then(function () {
                    if (current(state)) state.pending = false;
                }, rejected);
            } else {
                // Older TV implementations return undefined and silently stay paused.
                state.pending = false;
                clearTimeout(legacyTimer);
                legacyTimer = setTimeout(function () {
                    if (current(state) && video.paused && video.readyState >= 2) blocked(state);
                }, 1200);
            }
        }

        function remoteStart(event) {
            if (!active || !current(active) || !video.paused) return;
            if (event.type === 'keydown') {
                var code = event.keyCode || event.which;
                var key = event.key;
                if ([13, 32, 415, 10252].indexOf(code) === -1 &&
                    ['Enter', ' ', 'Spacebar', 'MediaPlay', 'MediaPlayPause'].indexOf(key) === -1) return;
                event.preventDefault();
            }
            play(active, true);
        }

        document.addEventListener('keydown', remoteStart, true);
        button.addEventListener('click', remoteStart);
        video.addEventListener('click', remoteStart);

        this.stop = function () {
            active = null;
            clearTimers();
            events.forEach(function (name) { video['on' + name] = null; });
            hidePrompt();
            video.pause();
            video.style.display = 'none';
            video.removeAttribute('src');
            video.load();
        };

        this.open = function (url, token) {
            this.stop();
            var state = { token: token, pending: false, blocked: false, done: false };
            active = state;
            video.setAttribute('autoplay', '');
            video.setAttribute('muted', '');
            video.setAttribute('playsinline', '');
            video.setAttribute('webkit-playsinline', '');
            video.autoplay = true;
            video.defaultMuted = video.muted = true;
            video.volume = 0;
            video.preload = 'auto';
            video.style.display = 'block';
            video.onloadeddata = video.oncanplay = function () {
                if (current(state) && video.paused) play(state, false);
            };
            video.onplaying = function () {
                if (!current(state) || video.paused) return;
                state.blocked = state.pending = false;
                clearTimers();
                hidePrompt();
                callbacks.onPlaying(token);
            };
            video.ontimeupdate = function () {
                if (current(state) && !video.paused) {
                    clearTimers();
                    callbacks.onProgress(token);
                }
            };
            video.onended = function () {
                // A queued event from the previous source can reach the reused node.
                if (!current(state) || !video.ended) return;
                state.done = true;
                clearTimers();
                hidePrompt();
                callbacks.onEnded(token);
            };
            video.onerror = function () {
                if (video.error) failed(state, 'Video load error (' + video.error.code + ')');
            };
            video.onstalled = function () {
                if (current(state) && !state.blocked) waitForMedia(state, 30);
            };
            waitForMedia(state, 45);
            video.src = url;
            video.load();
            play(state, false);
        };
    }

    root.TVMediaPlayer = TVMediaPlayer;
}(window));
