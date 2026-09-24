# Health Politics — License to Publish

Online License to Publish form for *Health Politics* (eISSN 3092-5517). The form also collects the article metadata needed for DOI registration with Crossref.

- **Front end:** `index.html` and `config.js`, served by GitHub Pages at `https://hpolitics.github.io/ltp/`.
- **Back end:** `apps-script/Code.gs`, a Google Apps Script web app bound to the *HP LTP Register* Google Sheet. It serves each author's pre-filled details by private link (`?t=TOKEN`). On submission it saves the signed PDF and the metadata JSON to Drive, updates the Register, and emails the Editorial Office and the corresponding author.

No manuscript data is stored in this repository. Pre-fill data lives only in the Register sheet.

## Maintenance

- **Agreement wording:** it appears in two places, section 8 of `index.html` and the `AGREEMENT` constant in `Code.gs`. Change both together and bump `AGREEMENT_VERSION` in both.
- **Notification recipients:** in the Apps Script editor, *Project Settings → Script Properties*, add `NOTIFY` with the addresses separated by commas (e.g. `a@x.org,journal@hpolitics.org`). Do not put personal addresses in the repository. If `NOTIFY` is unset, notifications go to `journal@hpolitics.org` only.
- **Canonical source:** `apps-script/Code.gs` in this repository is the only authoritative version. When updating the Apps Script project, copy it from here, not from a zip or e-mail attachment.
- **New articles:** add a row to the Register with `label` and `prefill_json` (or leave `prefill_json` empty), then run **LTP → Generate tokens and links**.
- **Web app URL:** after deploying a new version of the Apps Script, the URL does not change if you use *Manage deployments → Edit → New version*.
