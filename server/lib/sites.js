// Sites blocked on the Mac at all times, in every Chrome window (incognito too)
// and through the hosts file for every other browser. mac/maclockoutd.sh does
// the blocking; the server only hands out the list (blocked_sites=… in the
// Mac's text answer), so taking a site off needs a merge to this repo.
//
// A domain blocks itself and all its subdomains in Chrome (www.x.com,
// m.uber.com, …). The hosts file only lists the domain and its www.
// Lowercase domains only: the Mac drops anything else.

export const BLOCKED_SITES = [
  "x.com", "twitter.com",            // X
  "ifood.com.br", "ifood.com",       // iFood
  "rappi.com.br", "rappi.com",       // Rappi
  "uber.com", "ubereats.com",        // Uber (iFood orders inside it)
];

// The only apps that may run on the Mac while registered as a web browser (they
// open http/https links). The daemon quits any other browser as soon as it
// starts: one installed later, Tor, Opera's VPN, Chrome Canary. Bundle IDs.
export const ALLOWED_BROWSERS = [
  "com.google.Chrome",   // Chrome (the blocks above are a Chrome policy)
  "com.apple.Safari",    // Safari (hosts file + Screen Time)
  "com.openai.codex",    // the ChatGPT app, which also registers as a browser
  "com.anthropic.claudefordesktop", "com.anthropic.claude-code",   // Claude (doesn't register today; kept safe if it ever does)
];

const DOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
export const isDomain = d => typeof d === "string" && DOMAIN.test(d);
const BUNDLE_ID = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
export const isBundleId = b => typeof b === "string" && BUNDLE_ID.test(b);
