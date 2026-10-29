import { Services } from "resource://gre/modules/Services.sys.mjs";

const SOURCE_PREF = "live-gmail.source";

const accountButton = document.getElementById("account");
const dialog = document.getElementById("account-dialog");
const clientIdInput = document.getElementById("client-id");
const clientSecretInput = document.getElementById("client-secret");
const status = document.getElementById("status");
const connectButton = document.getElementById("connect");
const disconnectButton = document.getElementById("disconnect");

function browserWindow() {
  return window.browsingContext?.topChromeWindow ?? null;
}

function gmail() {
  return browserWindow()?.liveGmail ?? null;
}

function currentSource() {
  const value = Services.prefs.getStringPref(SOURCE_PREF, "atom");
  return value === "oauth" ? "oauth" : "atom";
}

function showAccountButton() {
  accountButton.hidden = currentSource() !== "oauth";
}

function selectSource(value) {
  const input = document.querySelector(`input[name="source"][value="${value}"]`);
  if (input) input.checked = true;
  showAccountButton();
}

function fillDialog() {
  const oauth = gmail()?.oauth;
  clientIdInput.value = oauth?.clientId() ?? "";
  clientSecretInput.value = "";
  clientSecretInput.placeholder = oauth?.clientSecret() ? "Saved" : "";
  const account = oauth?.status();
  status.textContent = account?.connected
    ? "Connected" + (account.email ? " as " + account.email : "")
    : "";
  disconnectButton.disabled = !account?.connected;
}

document.querySelectorAll('input[name="source"]').forEach((input) => {
  input.addEventListener("change", () => {
    if (!input.checked) return;
    Services.prefs.setStringPref(SOURCE_PREF, input.value === "oauth" ? "oauth" : "atom");
    showAccountButton();
  });
});

accountButton.addEventListener("click", () => {
  fillDialog();
  if (!dialog.open) dialog.showModal();
  clientIdInput.focus();
});

document.getElementById("cancel").addEventListener("click", () => dialog.close());

dialog.addEventListener("close", () => {
  connectButton.disabled = false;
});

document.querySelector("form").addEventListener("submit", async (event) => {
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
    if (dialog.open) dialog.close();
  } catch (error) {
    status.textContent = error?.message || "Could not connect";
    connectButton.disabled = false;
  }
});

disconnectButton.addEventListener("click", async () => {
  const oauth = gmail()?.oauth;
  if (!oauth) return;
  disconnectButton.disabled = true;
  await oauth.disconnect();
  status.textContent = "Disconnected";
});

const sourceObserver = {
  observe() {
    selectSource(currentSource());
  },
};

Services.prefs.addObserver(SOURCE_PREF, sourceObserver);
window.addEventListener("pagehide", () => {
  Services.prefs.removeObserver(SOURCE_PREF, sourceObserver);
}, { once: true });

selectSource(currentSource());
