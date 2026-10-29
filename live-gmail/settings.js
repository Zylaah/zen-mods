import { Services } from "resource://gre/modules/Services.sys.mjs";

const SOURCE_PREF = "live-gmail.source";

const account = document.getElementById("account");
const connected = document.getElementById("connected");
const email = document.getElementById("email");
const form = document.getElementById("connect-form");
const clientIdInput = document.getElementById("client-id");
const clientSecretInput = document.getElementById("client-secret");
const status = document.getElementById("status");
const connectButton = document.getElementById("connect");
const disconnectButton = document.getElementById("disconnect");

function chromeWindow() {
  return window.browsingContext?.topChromeWindow ?? null;
}

function gmail() {
  return chromeWindow()?.liveGmail ?? null;
}

function currentSource() {
  try {
    return Services.prefs.getStringPref(SOURCE_PREF, "atom") === "oauth" ? "oauth" : "atom";
  } catch (e) {
    return "atom";
  }
}

function render() {
  const source = currentSource();
  const selected = document.querySelector(`input[name="source"][value="${source}"]`);
  if (selected) selected.checked = true;

  const oauth = gmail()?.oauth;
  const isConnected = !!oauth?.isConnected();
  account.hidden = source !== "oauth";
  connected.hidden = !isConnected;
  form.hidden = isConnected;
  disconnectButton.disabled = !isConnected;

  if (isConnected) {
    const accountStatus = oauth.status();
    email.textContent = accountStatus.email || "Google account";
    return;
  }

  if (!clientIdInput.value) clientIdInput.value = oauth?.clientId() || "";
  if (!clientSecretInput.value) {
    clientSecretInput.placeholder = oauth?.clientSecret() ? "Saved" : "";
  }
}

document.querySelectorAll('input[name="source"]').forEach((input) => {
  input.addEventListener("change", () => {
    if (!input.checked) return;
    Services.prefs.setStringPref(SOURCE_PREF, input.value === "oauth" ? "oauth" : "atom");
    status.textContent = "";
    render();
  });
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const oauth = gmail()?.oauth;
  if (!oauth) {
    status.textContent = "Live Gmail is not running in this window";
    return;
  }
  const clientId = clientIdInput.value.trim();
  if (!clientId) {
    status.textContent = "Enter the client ID";
    clientIdInput.focus();
    return;
  }
  connectButton.disabled = true;
  status.textContent = "Opening Google…";
  try {
    await oauth.authorize(clientId, clientSecretInput.value.trim());
    status.textContent = "";
    clientSecretInput.value = "";
    render();
  } catch (error) {
    status.textContent = error?.message || "Could not connect";
  } finally {
    connectButton.disabled = false;
  }
});

disconnectButton.addEventListener("click", async () => {
  const app = gmail();
  const oauth = app?.oauth;
  if (!oauth) return;
  disconnectButton.disabled = true;
  await oauth.disconnect();
  app.currentEmails = [];
  app.cachedEmails = [];
  app.atomMemCache = {};
  app.panel.updateDisplay();
  status.textContent = "";
  render();
});

const sourceObserver = { observe: render };
Services.prefs.addObserver(SOURCE_PREF, sourceObserver);
window.addEventListener("pagehide", () => {
  Services.prefs.removeObserver(SOURCE_PREF, sourceObserver);
}, { once: true });

render();
