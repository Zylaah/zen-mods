# Live Gmail Panel Userscript

A userscript for Zen browser that displays Gmail inbox emails in a floating panel when hovering over Gmail essential tabs.

## Features

- Displays the last 20 emails from your Gmail inbox
- Appears as a floating panel when hovering over Gmail essential tabs
- Polls Gmail API every 5 minutes (configurable)
- Styled to match Zen browser's native UI
- Click on emails to open them in the Gmail tab

## Installation

### Using fx-autoconfig (Recommended)

If you're already using [fx-autoconfig](https://github.com/MrOtherGuy/fx-autoconfig), installation is simple:

1. **Copy files to your Zen profile chrome directory:**
   - Copy `chrome/live-gmail.uc.js` to `<profile>/chrome/JS/live-gmail.uc.js`
   - Copy `chrome/live-gmail.css` to `<profile>/chrome/modules/live-gmail.css`

2. **Find your profile directory:**
   - Windows: `%APPDATA%\Zen\Profiles\<profile-name>\`
   - Linux: `~/.zen/<profile-name>/`
   - macOS: `~/Library/Application Support/Zen/Profiles/<profile-name>/`

3. **Restart Zen browser** - fx-autoconfig will automatically load the `.uc.js` file

That's it! The script will load automatically on browser startup.

## Configuration

#### Prerequisits

1. Create a Google Cloud Project
2. Add an OAuth 2.0 Client to it

#### Step 1: Add Redirect URI

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Select your project (the one with the OAuth client ID used in the script)
3. Go to **APIs & Services** → **Credentials**
4. Click on your OAuth 2.0 Client ID
5. Under **Authorized redirect URIs**, click **+ ADD URI**
6. Add: `http://localhost` (exactly this, no trailing slash)
7. Click **Save**

#### Step 2: Add Test Users (Required for Testing Mode)

Since the app is in "Testing" mode, you need to add users who can access it:

1. In Google Cloud Console, go to **APIs & Services** → **OAuth consent screen**
2. Scroll down to **Test users** section
3. Click **+ ADD USERS**
4. Add the email addresses of users who will use the script (up to 100 test users)
5. Click **Add**

**Note:** You can add up to 100 test users. For production use with unlimited users, you'll need to publish the app, which requires Google verification (not required for personal use scripts).

Once configured, all added test users can use the script without any additional setup!

### Connecting Your Gmail Account (For End Users)

The userscript has a **built-in OAuth flow** - end users don't need any setup!

#### First Time Setup

1. Make sure the userscript is loaded (restart Zen if needed)
2. Hover over a Gmail essential tab (need to be opened once for it to work)
3. Click the **"Connect Gmail"** button in the panel
4. A new tab will open for Google sign-in
5. Sign in with your Google account
6. Click "Allow" to grant access

That's it! The userscript will:
- Automatically exchange the code for access and refresh tokens
- Store tokens securely in browser preferences
- Automatically refresh tokens when they expire

#### Disconnecting

To disconnect your Gmail account:
- Click the disconnect button in the panel header
- Confirm the disconnection

#### Troubleshooting OAuth

**Error: redirect_uri_mismatch**
- This means the developer hasn't added `http://localhost` to the OAuth client's authorized redirect URIs
- Contact the script developer to configure this (one-time setup)

**Error: access_denied / "has not completed the Google verification process"**
- This means your email address hasn't been added as a test user
- Contact the script developer to add your email to the test users list
- The developer needs to go to **OAuth consent screen** → **Test users** and add your email

**"This app isn't verified" warning**
- This is normal for development apps
- Click "Advanced" → "Go to [app name] (unsafe)" to continue

**Manual Setup (Alternative)**

If the built-in OAuth doesn't work, you can set tokens manually:

```javascript
// In browser console (F12)
Services.prefs.setStringPref('live-gmail.api-key', 'YOUR_ACCESS_TOKEN_HERE');
Services.prefs.setStringPref('live-gmail.refresh-token', 'YOUR_REFRESH_TOKEN_HERE');
```

### Setting Preferences

You can set preferences using the browser console (F12) or by creating a preferences file:

**Via Browser Console:**
```javascript
Services.prefs.setStringPref('live-gmail.api-key', 'YOUR_OAUTH_TOKEN_OR_API_KEY');
Services.prefs.setIntPref('live-gmail.poll-interval', 300000); // 5 minutes in milliseconds
Services.prefs.setStringPref('live-gmail.url', 'mail.google.com'); // Gmail URL pattern
```

**Or via about:config:**
- `live-gmail.api-key` (string): Your Gmail API OAuth token or API key
- `live-gmail.poll-interval` (integer): Polling interval in milliseconds (default: 300000 = 5 minutes)
- `live-gmail.url` (string): Gmail URL pattern to match (default: 'mail.google.com')

## Usage

1. Make sure you have at least one essential tab pointing to Gmail (mail.google.com)
2. Hover over the Gmail essential tab
3. The floating panel will appear showing your last 20 emails
4. Click on any email to open it in the Gmail tab
5. The panel will automatically update every 5 minutes (or your configured interval)

## Troubleshooting

### Panel doesn't appear
- Check browser console (F12) for errors
- Verify the script is loading: Look for `[Live Gmail] Initializing...` in console
- Ensure you have an essential tab with Gmail URL
- Check that the CSS file is loaded

### API errors
- Verify your API key/token is set correctly
- Check that Gmail API is enabled in Google Cloud Console
- Ensure your OAuth token has the necessary scopes: `https://www.googleapis.com/auth/gmail.readonly`
- Check browser console for detailed error messages

### Styling issues
- Ensure `live-gmail.css` is in the `JS` folder
- Check that userChrome.css is enabled in Zen
- Verify CSS variables are available (Zen theme system)

### Script not loading
- Verify fx-autoconfig is properly installed and working
- Check that `live-gmail.uc.js` is in the `chrome` folder
- Verify file permissions
- Check browser console for loading errors (look for `[Live Gmail] Initializing...`)
- Ensure the file has `.uc.js` extension (required by fx-autoconfig)

## Notes

- The script requires Gmail API access with proper authentication
- OAuth 2.0 tokens expire and may need to be refreshed
- The panel respects Zen's theme and dark mode
- Email data is cached between polls for better performance
- The script monitors tab changes and updates automatically

## License

This userscript is provided as-is for use with Zen browser.

