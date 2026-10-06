// The Freva sign-in callback shipped with ClimateClaw: hands this page's URL (code and state) to
// the tab that opened this popup, then scrubs the address bar and closes. It never exchanges the
// code: the tab holds the login transaction and the token stays in that tab.
//
// The tab names its attempt in a record in this popup's session storage ("freva-auth:relay":
// attempt, purpose, expiry), taken once here. The answer goes out on a channel named after the
// attempt and, same origin only, to the window that opened this popup: a notebook framed by
// another site's page has its storage and channels partitioned, and only the opener's
// postMessage reaches it. The popup closes when the tab acknowledges; otherwise it says so.
// The same protocol as the portal's shared callback (`/auth/callback/`, see src/auth-relay.ts).
// Sign-ins started by an older ClimateClaw (key "freva-login-attempt", channel
// "freva-login-callback") get the answer that version expects.
(function () {
  "use strict";
  var RELAY_KEY = "freva-auth:relay";
  var CHANNEL_PREFIX = "freva-auth-callback.";
  var MESSAGE = "freva-auth-callback";
  var ACK = "freva-auth-callback-ack";
  var ACK_TIMEOUT_MS = 4000;
  var LEGACY_KEY = "freva-login-attempt";
  var LEGACY_CHANNEL = "freva-login-callback";
  var NOT_HANDED_BACK =
    "This sign-in could not be handed back to the notebook. If the notebook is shown inside " +
    "another site's page, open it in its own tab and sign in there.";
  var url = window.location.href;
  var origin = window.location.origin;
  var query = new URLSearchParams(window.location.search);
  var fragment = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  var response = ["code", "state", "error", "iss", "session_state"].some(function (key) {
    return query.has(key) || fragment.has(key);
  });
  // Scrub first, so the code does not stay in this window's history whatever happens next.
  try {
    window.history.replaceState(null, "", window.location.pathname);
  } catch {
    // Nothing else to do.
  }
  function take(key) {
    try {
      var value = window.sessionStorage.getItem(key);
      window.sessionStorage.removeItem(key);
      return value;
    } catch {
      return null;
    }
  }
  function relayRecord() {
    var raw = take(RELAY_KEY);
    if (!raw) return null;
    try {
      var record = JSON.parse(raw);
      if (
        !record ||
        record.v !== 1 ||
        typeof record.expires !== "number" ||
        !/^[0-9a-f]{32}$/.test(String(record.attempt)) ||
        (record.purpose !== "login" && record.purpose !== "logout")
      ) {
        return null;
      }
      return record;
    } catch {
      return null;
    }
  }
  function refusal() {
    var error = query.get("error");
    if (!error) return null;
    if (error === "access_denied") return "The sign-in was cancelled.";
    if (error === "login_required" || error === "interaction_required") {
      return "Freva needs you to sign in again.";
    }
    return "Freva did not accept the sign-in (" + error + ").";
  }
  function opener() {
    try {
      return window.opener && !window.opener.closed ? window.opener : null;
    } catch {
      return null;
    }
  }
  function say(text, home) {
    var status = document.getElementById("status");
    if (status) status.textContent = text;
    var link = document.getElementById("home");
    if (link) link.hidden = !home;
  }
  function closeSoon() {
    window.setTimeout(function () {
      window.close();
    }, 300);
  }
  // Hands `message` over on the attempt's channel and to the opener; with `wait`, calls `done`
  // with whether the tab acknowledged within the timeout.
  function handOver(message, wait, done) {
    var channel = null;
    if (message.attempt) {
      try {
        channel = new BroadcastChannel(CHANNEL_PREFIX + message.attempt);
      } catch {
        channel = null;
      }
    }
    var parent = opener();
    var finished = false;
    function finish(ok) {
      if (finished) return;
      finished = true;
      window.removeEventListener("message", onWindow);
      if (channel) channel.close();
      if (done) done(ok);
    }
    function isAck(data) {
      return (
        !!data &&
        data.type === ACK &&
        data.v === 1 &&
        (message.attempt ? data.attempt === message.attempt : true)
      );
    }
    function onWindow(event) {
      if (event.origin !== origin || !window.opener || event.source !== window.opener) return;
      if (isAck(event.data)) finish(true);
    }
    if (wait) {
      if (channel) {
        channel.addEventListener("message", function (event) {
          if (isAck(event.data)) finish(true);
        });
      }
      window.addEventListener("message", onWindow);
    }
    if (channel) channel.postMessage(message);
    if (parent) {
      try {
        parent.postMessage(message, origin);
      } catch {
        parent = null;
      }
    }
    if (!wait) return finish(Boolean(channel || parent));
    if (!channel && !parent) return finish(false);
    window.setTimeout(function () {
      finish(false);
    }, ACK_TIMEOUT_MS);
  }
  function post(name, data) {
    try {
      var channel = new BroadcastChannel(name);
      channel.postMessage(data);
      channel.close();
      return true;
    } catch {
      return false;
    }
  }

  function run() {
    var relay = relayRecord();
    if (relay) {
      var base = { type: MESSAGE, v: 1, attempt: relay.attempt, purpose: relay.purpose };
      if (relay.expires < Date.now()) {
        // The tab is told, so it lets go of the attempt and a new sign-in starts afresh.
        handOver(Object.assign({}, base, { outcome: "expired" }), false);
        say("This sign-in waited too long and expired. Sign in again from the notebook.", true);
        return closeSoon();
      }
      if (relay.purpose === "logout") {
        handOver(Object.assign({}, base, { outcome: "response" }), false);
        say("Signed out of Freva. You can close this window.", false);
        return closeSoon();
      }
      if (!response) {
        handOver(Object.assign({}, base, { outcome: "expired" }), false);
        say("The sign-in came back without an answer. Sign in again from the notebook.", false);
        return closeSoon();
      }
      return handOver(
        Object.assign({}, base, { outcome: "response", url: url }),
        true,
        function (ok) {
          if (!ok) return say(NOT_HANDED_BACK, true);
          say(refusal() || "Signed in. You can close this window.", false);
          closeSoon();
        },
      );
    }
    var legacy = take(LEGACY_KEY);
    if (legacy && response) {
      // A sign-in started by an older ClimateClaw, answered the way it expects.
      var sent = post(LEGACY_CHANNEL, { type: "freva-login-callback", url: url, attempt: legacy });
      say(
        sent
          ? "Signed in. You can close this window."
          : "This browser cannot hand the sign-in back to the notebook. Sign in again from the notebook.",
        false,
      );
      return closeSoon();
    }
    if (response && opener()) {
      // No record reached this popup (a frame on another site): its opener takes the response.
      var message = { type: MESSAGE, v: 1, purpose: "login", outcome: "response", url: url };
      return handOver(message, true, function (ok) {
        if (!ok) return say(NOT_HANDED_BACK, true);
        say(refusal() || "Signed in. You can close this window.", false);
        closeSoon();
      });
    }
    if (response) {
      return say(
        refusal() ||
          "This sign-in was not started here, or it already finished. If the notebook is shown " +
            "inside another site's page, open it in its own tab and sign in there.",
        true,
      );
    }
    say("There is no sign-in in progress here.", true);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", run);
  else run();
})();
