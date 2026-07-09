// SuperProfile embeddable widget loader — vanilla JS, no dependencies.
(function () {
  var script = document.currentScript;
  var widgetKey = script && script.getAttribute("data-widget-key");
  if (!widgetKey) {
    console.warn("[SuperProfile] widget.js: missing data-widget-key attribute");
    return;
  }

  var origin = new URL(script.src, window.location.href).origin;
  var iframe = null;
  var open = false;
  var unreadCount = 0;

  function isMobile() {
    return window.innerWidth < 480;
  }

  var button = document.createElement("button");
  button.setAttribute("aria-label", "Open chat");
  button.style.cssText =
    "position:fixed;bottom:20px;right:20px;width:56px;height:56px;border-radius:50%;" +
    "background:#4f46e5;border:none;cursor:pointer;box-shadow:0 4px 12px rgba(0,0,0,.18);" +
    "z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:0";
  button.innerHTML =
    '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 ' +
    '8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 ' +
    '8.48 0 0 1 8 8v.5z"/></svg>';

  var badge = document.createElement("span");
  badge.style.cssText =
    "position:absolute;top:-2px;right:-2px;min-width:18px;height:18px;border-radius:9px;" +
    "background:#ef4444;color:#fff;font:600 11px/18px system-ui,sans-serif;text-align:center;" +
    "padding:0 4px;display:none;pointer-events:none";
  button.appendChild(badge);

  function ensureIframe() {
    if (iframe) return iframe;
    iframe = document.createElement("iframe");
    iframe.src = origin + "/widget-app?key=" + encodeURIComponent(widgetKey);
    iframe.title = "Chat widget";
    var sizeStyle = isMobile()
      ? "width:100vw;height:100vh;bottom:0;right:0;border-radius:0"
      : "width:380px;height:580px;bottom:88px;right:20px;border-radius:12px";
    iframe.style.cssText =
      "position:fixed;border:none;box-shadow:0 8px 30px rgba(0,0,0,.2);" +
      "z-index:2147483000;display:none;" +
      sizeStyle;
    document.body.appendChild(iframe);
    return iframe;
  }

  function updateBadge() {
    if (unreadCount > 0 && !open) {
      badge.textContent = unreadCount > 9 ? "9+" : String(unreadCount);
      badge.style.display = "block";
    } else {
      badge.style.display = "none";
    }
  }

  function setOpen(next) {
    open = next;
    var f = ensureIframe();
    f.style.display = open ? "block" : "none";
    if (open) {
      unreadCount = 0;
      updateBadge();
    }
  }

  button.addEventListener("click", function () {
    setOpen(!open);
  });

  window.addEventListener("message", function (event) {
    if (event.origin !== origin) return;
    var data = event.data;
    if (data && data.type === "sp:unread") {
      unreadCount = data.count || 0;
      updateBadge();
    }
  });

  document.body.appendChild(button);
})();
