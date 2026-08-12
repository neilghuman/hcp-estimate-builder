# HCP Estimate Builder

A small web portal: upload an Excel/CSV of **multi-option, multi-line** estimates,
pick a Housecall Pro customer, and create the estimate in HCP.

Built to run on the internal box (e.g. `10.0.10.102`) on a non-obvious port,
firewalled from the public internet.

## Spreadsheet format

One row per line item. The `option` column groups rows into HCP **options**
(e.g. Good / Better / Best — the choices the customer sees).

| column | required | notes |
|---|---|---|
| `option` | recommended | Groups rows into one option. Omit = a single "Option #1". |
| `option_message` | optional | Pitch text for that option (first non-empty row wins). |
| `line_name` | **yes** | The line item name. |
| `description` | optional | Line item detail. |
| `unit_of_measure` | optional | e.g. `visit`, `job`, `sq ft`, `ft`, `each`. Drives the quantity label. |
| `quantity` | optional | Defaults to 1. |
| `frequency` | optional | `single` (default), `weekly`, `bi-weekly`, `twice-monthly`, `monthly`, `quarterly`, `every-6-months`, `annually`. Non-single rows are flagged recurring. |
| `unit_price` | **yes** | In **dollars** (e.g. `1500.00`). Converted for the API. |
| `pricing_mode` | optional | `calculated` (default = qty × unit price) or `flat` (use `flat_amount`). |
| `flat_amount` | optional | Flat-rate override in **dollars**, used when `pricing_mode` is `flat`. Default 0. |
| `kind` | optional | e.g. `labor`, `materials`, `discount`. Default from `DEFAULT_LINE_KIND`. |
| `taxable` | optional | `yes`/`no`. Default no. |

Headers are matched case/space/punctuation-insensitively with synonyms
(`price`→`unit_price`, `qty`→`quantity`, `item`→`line_name`, `freq`→`frequency`,
`flat`→`flat_amount`, …), so you can tweak column names without touching code.
See `sample/estimate-template.csv`.

## Quick Start

### Local Development (Windows)

```powershell
cd C:\Projects\hcp-estimate-builder
copy .env.example .env       # then fill in HCP_API_KEY
npm install
npm start
```

Open http://127.0.0.1:8123/ . Flow: upload → preview → pick customer →
choose address → **Dry run** (preview the exact API calls) → **Create**.

**OR** use the automated Docker build script for local testing:

```powershell
.\deploy.ps1 -Mode docker    # Builds image, starts containers, verifies health
```

### Production Deployment (Docker)

**Option A: Automated Deployment (Recommended)**

```bash
# On production server (10.0.10.102)
wget https://github.com/neilghuman/projects-backup.git/raw/main/hcp-estimate-builder/deploy.sh
chmod +x deploy.sh
./deploy.sh --fresh          # Fresh install: clone repo, build, start
./deploy.sh --pull --build   # Update: pull latest, rebuild, restart
```

**Option B: Manual Deployment**

```bash
# On production server (10.0.10.102)
cd /opt
git clone https://github.com/neilghuman/projects-backup.git hcp-estimate-builder
cd hcp-estimate-builder/hcp-estimate-builder
cp .env.production .env
nano .env                    # Update DB_PASSWORD and HCP_API_KEY
docker-compose up -d --build
```

See **[DOCKER_DEPLOYMENT.md](DOCKER_DEPLOYMENT.md)** for detailed deployment instructions,
troubleshooting, and maintenance.
```

`docker-compose.yml` publishes the port bound to `10.0.10.102` only (not
`0.0.0.0`), so it is reachable on the LAN but not the public internet. Keep a
host firewall rule blocking the port from outside as defense in depth. For
remote access without exposing anything, use an SSH tunnel or Tailscale and set
`HOST=127.0.0.1`.

## Security notes

- The HCP API key lives only in `.env` (gitignored), never in the browser.
- Optional HTTP Basic Auth: set `PORTAL_USER` / `PORTAL_PASS` in `.env`.
- **Dry run first.** It returns the exact sequence of HCP API calls without
  sending anything.

## Status / TODO

- The HCP create-estimate payload (`src/hcp.js`) follows the verified nested
  structure (Estimate → Options → Line Items) but the **create** calls have not
  yet been confirmed against the live API. Verify with a throwaway customer and
  delete the test estimate before real use. Confirm money units
  (`HCP_MONEY_IN_CENTS`) and valid `kind` values on that first test.
