/**
 * The OAuth consent page (GET/POST /oauth/authorize): one small server-rendered HTML document, no
 * script, styled after docs/DESIGN_V2.md (soft near-black canvas, one surface step, Geist when the
 * system has it, the blue accent on the single primary action, light theme via prefers-color-scheme).
 * Every interpolated value goes through `esc`.
 */

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}

const CSS = `
:root{--hue:252;color-scheme:dark;
--canvas:oklch(.165 .006 var(--hue));--surface-1:oklch(.195 .006 var(--hue));--surface-2:oklch(.225 .006 var(--hue));
--fg-1:oklch(.93 .004 var(--hue));--fg-2:oklch(.78 .006 var(--hue));--fg-3:oklch(.66 .006 var(--hue));
--line-2:rgb(255 255 255/.10);--line-3:rgb(255 255 255/.16);
--accent:oklch(.72 .12 252);--accent-hover:oklch(.77 .11 252);--on-accent:oklch(.20 .012 252)}
@media (prefers-color-scheme:light){:root{color-scheme:light;
--canvas:oklch(.974 .004 var(--hue));--surface-1:oklch(1 0 0);--surface-2:oklch(.952 .006 var(--hue));
--fg-1:oklch(.22 .009 var(--hue));--fg-2:oklch(.43 .009 var(--hue));--fg-3:oklch(.52 .009 var(--hue));
--line-2:rgb(0 0 0/.11);--line-3:rgb(0 0 0/.17);
--accent:oklch(.53 .14 252);--accent-hover:oklch(.49 .135 252);--on-accent:oklch(1 0 0)}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px 16px;
background:var(--canvas);color:var(--fg-1);font:400 14px/1.5 Geist,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
font-variant-numeric:tabular-nums;-webkit-font-smoothing:antialiased}
main{width:100%;max-width:420px}
.mark{font-weight:600;font-size:16px;letter-spacing:-.01em;margin:0 0 24px;color:var(--fg-1)}
.card{background:var(--surface-1);border-radius:14px;padding:24px}
h1{font-size:20px;font-weight:600;line-height:1.3;margin:0 0 8px}
p{margin:0 0 16px;color:var(--fg-2)}
dl{margin:0 0 24px;display:grid;grid-template-columns:auto 1fr;gap:8px 16px}
dt{color:var(--fg-3);font-size:12px;font-weight:500;line-height:20px}
dd{margin:0;min-width:0;overflow-wrap:anywhere}
code{font-family:"Geist Mono",ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px}
label{display:block;font-size:12px;font-weight:500;color:var(--fg-3);margin:0 0 6px}
input[type=password]{width:100%;height:40px;padding:0 12px;border-radius:10px;border:1px solid var(--line-2);
background:var(--canvas);color:var(--fg-1);font:inherit;font-size:16px;outline:none}
input[type=password]:hover{border-color:var(--line-3)}
input[type=password]:focus-visible{border-color:var(--line-3);box-shadow:0 0 0 2px var(--accent)}
.error{color:var(--fg-1);font-weight:500;margin:8px 0 0}
.actions{display:flex;gap:8px;justify-content:flex-end;margin-top:24px}
button{height:36px;padding:0 16px;border-radius:10px;border:0;font:inherit;font-weight:500;cursor:pointer}
button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.primary{background:var(--accent);color:var(--on-accent)}
.primary:hover{background:var(--accent-hover)}
.secondary{background:var(--surface-2);color:var(--fg-1)}
.note{font-size:12px;color:var(--fg-3);margin:16px 0 0}
`;

function document(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)} · hermes</title>
<link rel="icon" href="/favicon.png">
<style>${CSS}</style>
</head>
<body><main><p class="mark">hermes</p><div class="card">${body}</div></main></body>
</html>`;
}

export interface ConsentView {
  clientName: string;
  /** where the browser goes back to: host[:port] for http(s), the scheme for app links */
  redirectTarget: string;
  /** signed authorization request (hidden field) */
  request: string;
  error?: string;
}

export function consentPage(v: ConsentView): string {
  const name = esc(v.clientName);
  return document(
    `Connect ${v.clientName}`,
    `<h1>Connect “${name}” to Hermes</h1>
<p>It will be able to read your training and manage your plan through the Hermes MCP server. The connection lasts 30 days; it shows up in Settings → Agents, where you can revoke it.</p>
<dl><dt>App</dt><dd>${name}</dd><dt>Returns to</dt><dd><code>${esc(v.redirectTarget)}</code></dd></dl>
<form method="post" action="/oauth/authorize">
<input type="hidden" name="request" value="${esc(v.request)}">
<label for="passphrase">Your Hermes passphrase</label>
<input id="passphrase" name="passphrase" type="password" autocomplete="current-password" autofocus${v.error ? ' aria-invalid="true" aria-describedby="err"' : ''}>
${v.error ? `<p class="error" id="err" role="alert">${esc(v.error)}</p>` : ''}
<div class="actions">
<button class="secondary" type="submit" name="decision" value="deny" formnovalidate>Cancel</button>
<button class="primary" type="submit" name="decision" value="approve">Allow access</button>
</div>
</form>
<p class="note">Only continue if you started this from that app. The name is chosen by the app; the address it returns to is not.</p>`,
  );
}

export function errorPage(title: string, message: string): string {
  return document(title, `<h1>${esc(title)}</h1><p>${esc(message)}</p><p class="note">You can close this tab and start again from your app.</p>`);
}
