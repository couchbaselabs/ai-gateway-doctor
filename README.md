# AI Gateway Doctor

Checks the AI Gateway that serves Couchbase Capella Model Service inference, end to end: the gateway's cache cluster, the gateway node, and the deployed models. It also helps repair the most common failure, a full disk on the cache cluster node.

It comes as a command-line script, `aigw-doctor.sh`, and a local web UI in `ui/` that runs the script and shows its results.

> **Not an official Couchbase product.** This is a debugging aid from Couchbase Labs, provided as is and without support. It runs with your own AWS and Capella credentials and only does what those credentials allow. Read-only checks are the default; nothing changes without `--fix`, and `--fix` asks before every change.

## Requirements

- **Script:** `bash` (3.2 or later), `aws` CLI v2, `jq`, `curl` and `nc`.
- **AWS credentials:** for the account the sandbox runs in.
- **Optional:**
  - the AWS Session Manager plugin, for remote checks and terminals over SSM;
  - a Capella login, to look up the gateway endpoint;
  - Node.js 18 or later and Python 3, for the web UI.

## Quick start

```bash
git clone https://github.com/couchbaselabs/ai-gateway-doctor.git
cd ai-gateway-doctor

# Dry run: show every command, run nothing
./aigw-doctor.sh -c /path/to/gateway.config.json --region us-east-2 --tenant-id <tenant id>

# Run the checks, including model probes and cache hits with a temporary API key
./aigw-doctor.sh -c /path/to/gateway.config.json --region us-east-2 --check \
  --tenant-id <tenant id> --create-api-key --cp-user you@example.com

# Web UI
cd ui && cp .env.example .env && $EDITOR .env && npm start   # http://127.0.0.1:4545
```

The gateway config is the AI Gateway's `config.json`; a sandbox's Fleet Manager can provide it. Run `./aigw-doctor.sh --help` for every option.

## The doctor script: `aigw-doctor.sh`
Checks why the semantic cache stopped working, typically because the cache Couchbase cluster became unreachable when a volume on its EC2 node filled up. Then it confirms end to end that the deployed models answer and that repeated requests hit the cache. It runs these steps:

0. Checks that the AWS credentials are valid, and stops if they are expired.
1. Reads the gateway config: `couchbaseConnectString`, `dbCredKey`, `cacheKeyspace`, `adminKey` and the models.
2. Lists the ASGs and running instances tagged with the tenant (org) id, then picks:
   - the **cache node** from ASG `capella-ds-<deployment id>`
   - the **gateway** from ASG `capella-ai-gateway-<deployment id>`

   The deployment id is the UUID at the start of `dbCredKey`. It also checks that the gateway resolves the connect-string host to the cache node.
3. Searches the gateway log for Couchbase connection timeouts. Without `--log-file`, the script finds the log from the running `ai-gateway` process.
4. Checks, from the gateway, that the cluster's TLS ports are reachable: admin `18091` and data `11207`.
5. Fetches the admin credential (`dbCredKey`) from AWS Secrets Manager, then checks node health and the cache bucket through `https://<host>:18091`. It tries from your machine first. If the security group blocks that, it repeats the check on the gateway, where the gateway's instance role reads the secret itself.
6. Checks every real filesystem on both nodes, for space and for inodes. It also checks that `couchbase-server` is active on the cache node and the `ai-gateway` process is running on the gateway node.
7. Reads the gateway's version, build time and commit from `GET /v1/info` and reports them, for example "AI Gateway 1.42.0, built …, commit …". It warns about any model the gateway itself reports as unreachable. Then it probes every model in the config:
   - **Text-generation models:** a chat request. Then each cache type the config enables is tested. A type counts as enabled only when both `cacheConfig.isEnabled` and the type's own `isEnabled` are true: the top-level flag gives the API key its cache role, and without it the gateway skips the cache. Types turned off by the top-level flag are reported as SKIP.
     - **Test:** a newly generated question (two random topics and a reference number) is sent with `X-cb-cache: standard|semantic`. The first answer should be `X-Cache: MISS`, and the same question repeated must be a `HIT`.
     - **Retry:** if the first answer is already a HIT, because an older entry matched, the script tries a new question, up to three times.
     - **Reworded question (semantic only):** shown with `--verbose` for information. It depends on the score threshold, so it isn't counted as a pass or a failure.
   - **Embedding models:** an embeddings request. The vector length is checked against `embeddingDimensions` when the config sets it.
8. With `--fix`: for each full filesystem on either node, finds its EBS volume, grows it, then runs `growpart` and `resize2fs` or `xfs_growfs`. It restarts `couchbase-server` if the admin API is still down, then checks again. If a node is in an ASG, the script warns you to also raise the launch template's volume size.

| Mode | Behaviour |
|------|-----------|
| (default) | Dry run. Prints every command and runs nothing. |
| `--check` | Runs the checks. Prints the fix commands if a fix is needed, without running them. |
| `--fix` | Runs the checks, then the fixes. Asks for confirmation before each step that changes anything. |
| `--check --inference-only` | Runs only step 7, against the models in the config. Needs no AWS access when `--aigw-url` and an API key are given. |

Output is one `PASS`/`WARN`/`FAIL` line per check, followed by a result count. `--verbose` adds the step headers, every command and remote script, and the listings (ASGs, instances, `df`, nodes). The fix commands are always shown.

The API key for step 7 can come from three places:
- `--api-key-file FILE`
- the `AIGW_API_KEY` environment variable
- `--create-api-key`

With `--create-api-key`, the script reads the gateway admin credential from Secrets Manager (the `adminConfig.adminKey` secret). It uses that to create a temporary key through `POST /v1/apikeys`. The key expires after an hour and is deleted with `DELETE /v1/apikeys/<keyId>` when the run ends, including on Ctrl-C. To keep it instead, add `--save-api-key FILE`, which writes it with mode 600.

```bash
# Show what would run
./aigw-doctor.sh -c config.json --region us-east-2 --tenant-id <org-id> --create-api-key

# Full check, including model probes and cache hits with a temporary API key. The gateway
# endpoint is looked up in the control plane; the password is prompted for (or set CP_PASSWORD).
./aigw-doctor.sh -c config.json --region us-east-2 --check --tenant-id <org-id> \
  --create-api-key --cp-user you@couchbase.com

# Model probes and cache hits only, for one model, with all the details
./aigw-doctor.sh -c config.json --check --inference-only \
  --aigw-url https://<gateway>:8081 --api-key-file ~/.aigw-key --models amazon.nova-lite-v1:0 --verbose

# Repair: snapshot each full volume, then double its size
./aigw-doctor.sh -c config.json --region us-east-2 --fix --tenant-id <org-id> --snapshot
```

Notes:

- **Tools and permissions:** needs `aws`, `jq`, `curl` and `nc`, plus AWS credentials that can call `sts:GetCallerIdentity`, `secretsmanager:GetSecretValue`, `ec2:Describe*`, `autoscaling:Describe*`, `ec2:ModifyVolume`, `ec2:CreateSnapshot` and `ssm:SendCommand`. Works with the macOS default bash 3.2.
- **Finding the nodes:** if you have no tenant id, `--aigw-instance` reads it from the gateway's EC2 user data (only the `tenantId` field). `--cb-instance` names the cache node directly. The ASG prefixes can be changed with `--ds-asg-prefix` and `--aigw-asg-prefix`.
- **Inference endpoint:** with `--cp-user EMAIL` (or `CP_USER`), the script finds the gateway endpoint for you. It logs in to the Capella control plane (`POST /sessions`), lists the org's language models (`GET /v2/organizations/{orgId}/languagemodels`), and takes the `network.endpoint` of the models in `--region`. That endpoint is the gateway's load balancer, `https://<fqdn>` on port 443. One gateway serves a tenant's region, so every model there shares it.
  - **Password:** comes from `CP_PASSWORD`, or a hidden prompt when run from a terminal.
  - **Control plane URL:** derived from the gateway instance's user data. Its `api` field is the internal API, `https://<env>.internal-api.<domain>`, which becomes the public `https://api.<env>.<domain>`. You can also set it with `--cp-url`, including a console URL such as `https://api.<env>.<domain>/v2/organizations/<org id>`, which also sets the org id.
  - **Org id:** defaults to the tenant id; override with `--org-id`.
  - **Override:** `--aigw-url` still takes precedence when you already know the endpoint.
  - **Fallback:** without either option, the script tries the instance directly at `https://<gateway public DNS>:8081`, which its security group usually blocks.
- **Secrets:** API keys and passwords reach curl through a file descriptor, so they never appear on a command line or in an SSM command. That is also why step 7 always runs from your machine.
- **Inference cost:** each chat request asks for at most 8 output tokens. Cache prompts include a run id, so every run starts with a cache miss. A model the API key has no access to is reported as a warning and skipped.
- **Temporary key scope:** a temporary key allows all models and all IPs (`0.0.0.0/0`), as in the `create-api-key` skill. It is short-lived and deleted at the end of the run.
- **Resizing volumes:** `--size GB` applies to every volume `--fix` grows. AWS allows one size change per volume every 6 hours. Filesystems on LVM are reported, not resized.
- **Remote commands:** run through SSM (`AWS-RunShellScript`). Use `--cb-ssh` or `--aigw-ssh` to connect over ssh instead.
- **Capella:** connect strings that point at Capella have no EC2 node, so steps 6 and 8 don't apply to them.
- **Exit code:** non-zero if any check fails. Run `--help` to see all options.

## Run logs
Every run saves its full log to its own file: `~/.aigw-doctor/logs/aigw-doctor-<sandbox>-<mode>-<timestamp>-<pid>.log`, with mode 600. It is meant as evidence for tickets and reviews.
- **Contents:** the log always holds the `--verbose` detail, even when the console shows only the PASS/WARN/FAIL lines. That covers every command, remote script and listing, each model request with its answer (`[exchange]` lines), the summary, and the exit status (`exit 130 (interrupted)` after Ctrl-C).
- **Format:** a header records when, who, and the exact command line. Color codes are stripped.
- **No secrets:** passwords and API keys are never written to it.
- **Options:** the console's last line shows the path. Use `--log-dir DIR` (or `AIGW_DOCTOR_LOG_DIR`) to change the directory, or `--no-log` to skip the log.

## Web UI: `ui/`
A small local web page for running the doctor against your sandboxes and reading the results. It needs Node 18 or later and has no dependencies.

```bash
cd ui
cp .env.example .env && $EDITOR .env      # sandboxes and defaults; .env is git-ignored
npm start                                 # http://127.0.0.1:4545 (set PORT to change it)
```

If the port is in use (for example by another copy of the UI), the server tries the next ones, up to 20, and prints the address it ended up on. It then opens that address in your default browser; set `NO_OPEN=1` to skip that.

On the first start without a `.env`, the server creates one from `.env.example` (mode 600); edit it to add your sandboxes.

- **`.env`:** lists the sandboxes and fills the form, and is re-read on every request.
  - **Sandboxes:** every `<name>.config.json` in `AIGW_CONFIG_DIR` becomes a sandbox. Names in `SANDBOXES` are added too.
  - **Defaults:** bare keys (`REGION`, `CP_USER`, `SCOPE`, `MODE`, `API_KEY_SOURCE`, `MODELS`, …) apply to every sandbox. `<NAME>_<KEY>` sets one sandbox, for example `MY_SANDBOX_TENANT_ID` or `MY_SANDBOX_CP_URL`. See `.env.example`.
  - **Secrets:** `CP_PASSWORD` and `AIGW_API_KEY`, or their `<NAME>_` forms, stay on the server. The page shows only that they are set, and the doctor receives them through its environment.
- **Layout:** three panes, each scrolling on its own.
  - **Left:** the sandboxes, with the status and counts of each one's last run.
  - **Middle:** the run form. It is filled from `.env`, then your edits, which are kept per sandbox in the browser. **Reset to .env** discards your edits.
  - **Save to .env:** writes your changes back as that sandbox's `<NAME>_*` keys, including a password or API key you typed. Existing lines are updated in place, a cleared field removes its line, and the previous file is kept as `.env.bak`. Values are checked like run options, so a save can't add other lines.
  - **Right:** the results, with one card per step and a PASS/WARN/FAIL line for each check. The commands and output are folded underneath, and fix commands are shown expanded. Step 7 lists every model request with its question, answer, `X-Cache`, HTTP status and latency. **Problems only** hides the passing checks, **Raw output** shows the doctor's text, and **Clear output** empties the window before the next run (saved runs stay in the **Run** list).
- **AI Gateway version:** the version reported by the sandbox's latest run is shown under its title and in the sandbox list. **Check version** fetches it live from `GET /v1/info`, using the same gateway URL and API key as the Playground.
- **Fleet Manager:** a sandbox's AI gateway config can be downloaded from its Fleet Manager, `https://fm.<env>.<domain>/`. A link appears under the Config file field, on the Config tab and in the Add sandbox form.
  - **Where the link comes from:** the control plane URL (`api.<env>.<domain>` becomes `fm.<env>.<domain>`), or the sandbox name with `SANDBOX_DOMAIN` from `.env` (`fm.<sandbox>.<SANDBOX_DOMAIN>`).
  - **Override:** set `FM_URL` or `<NAME>_FM_URL` in `.env` for other environments.
- **Adding a sandbox:** click **+ Add sandbox** under the list.
  - **Fields:** a name (e.g. `my-sandbox`), a label, and the gateway config, either uploaded or as a path on this machine. Then the region, tenant id, control plane URL (the console API URL with `/v2/organizations/<org id>` works), Capella login and models.
  - **Upload:** an uploaded config is saved as `<name>.config.json` in `AIGW_CONFIG_DIR` (default `~/.aigw-doctor/configs`), with mode 600.
  - **`.env`:** the settings are appended as a commented `<NAME>_*` block, and a path-based sandbox is also added to `SANDBOXES`.
  - **Passwords and API keys:** not written by the UI. Add `CP_PASSWORD` or `<NAME>_CP_PASSWORD` to `.env` yourself, or type them in the run form.
  - **By hand:** you can instead drop `<name>.config.json` into `AIGW_CONFIG_DIR` and add `<NAME>_*` keys to `.env`. To change or remove a sandbox, edit `.env`.
- **Config tab:** next to **Results**, it shows what the selected sandbox's config sets up.
  - **Cache store:** the cluster host and keyspaces, and the Secrets Manager entries (by name only).
  - **Models:** one card per model, with its kind, backend and status, and its cache settings: the top-level and per-type flags, default type and expiry. Each card also shows which cache types the doctor will test, or why it won't.
  - **Details:** the semantic cache's embedding model, threshold, dimensions, similarity and index; guardrail, jailbreak and batch flags; and qps, queue and timeout.
  - **Not shown:** certificates, model keys and other secret values are never sent to the page. `?tab=config` opens this tab directly.
- **Couchbase console:** the buttons under the sandbox title help you log in to the cache cluster's web console.
  - **Open ↗:** opens `https://<cache node public DNS>:18091`. The host comes from the sandbox's last run, or from an AWS lookup of the `capella-ds-<deployment id>` ASG. Expect a certificate warning, because the sandbox uses a self-signed certificate.
  - **Copy user / Copy password:** read the config's `dbCredKey` credential from Secrets Manager with your AWS credentials and put it on your clipboard. The password is fetched only when you click, and is not stored anywhere.
- **Raw config:** **Raw JSON** on the Config tab shows the config file, with **Copy** and **Download**. Private keys (also base64-encoded ones) and password, token and secret fields are redacted. Public certificates and Secrets Manager names are shown.
- **Playground tab:** send your own requests to any model in the config.
  - **Choices:** the model, the cache mode (`none`, `standard` or `semantic`, marked when the config has it off), max tokens, temperature and an optional system prompt. Embedding models get an embeddings request.
  - **Each answer shows:** `X-Cache`, HTTP status, token usage, latency, the answer, the request and response headers, and the raw response. **Send again** repeats the last request, which is the quickest way to see a cache HIT.
  - **Headers:** shown with their original casing. The Authorization value is redacted, and cache and `X-cb-*` headers are highlighted.
  - **Debug:** sends `X-cb-debug: true`. The gateway then adds its `X-cb-*` debug headers (cache type, match threshold and so on), which are listed under the answer.
  - **Gateway URL:** taken from the form, else the endpoint found by the last run's control plane lookup.
  - **API key:** follows the form's choice. A temporary key is created once per sandbox, reused for up to an hour, and deleted when the server stops.
  - **Shortcuts:** `?tab=playground` opens the tab directly, and Cmd/Ctrl+Enter sends.
- **Terminals tab:** opens a shell on the sandbox's AI Gateway or Couchbase node inside the page, for checking disks and logs or restarting services by hand. Several sessions can be open at once, each with its own tab; up to 6 are allowed. They survive a page reload, and all of them close when the server stops.
  - **How it connects:** with `aws ssm start-session` and your AWS credentials, so no SSH keys are needed (it requires the Session Manager plugin). It uses SSH instead when `.env` sets `<NAME>_AIGW_SSH` / `<NAME>_CB_SSH` for that node, with `SSH_KEY` if set. The tab title shows which one is in use.
  - **User:** both open a login shell as `ec2-user`. An SSM session starts as `ssm-user`, so it runs `sudo su - ec2-user` through the `AWS-StartInteractiveCommand` session document; SSH does the same when it logs in as another user. Set `TERMINAL_USER` in `.env` to switch to a different user, or `TERMINAL_USER=none` to keep the login shell.
  - **Which instance:** the node is found from its ASG (`capella-ai-gateway-<id>` or `capella-ds-<id>`), unless the form names its instance id.
  - **How it works:** only these two commands can be started. They run in a pseudo-terminal (`pty-bridge.py`, using Python's standard library), and the page uses xterm.js from a CDN, so no npm dependencies are added.
- **Run history:** each run is saved under `~/.aigw-doctor/ui-history/<sandbox>/` (set `UI_HISTORY_DIR` to change it). The last 50 runs per sandbox are kept, including across server restarts. Pick a run from the **Run** list above the results. **Latest (live)** follows the run in progress. The full log path of each run is shown with its results.
- **Running:** each sandbox can run on its own. **Cancel** interrupts a run like Ctrl-C, so a temporary API key is still deleted. The URL remembers the selected sandbox (`#my-sandbox`), so you can bookmark it.
- **Security:**
  - The server runs the doctor with your shell's AWS credentials and listens only on `127.0.0.1`.
  - It rejects requests with another Host header, accepts only JSON posts, and checks every field against a pattern before it becomes a doctor argument.
  - Passwords and API keys reach the doctor only through its environment, and are never stored in the browser.
- **No `--fix`:** fix mode asks for confirmation on the terminal, so the UI offers only check and dry run. To repair, run the script with `--fix` in a terminal.

## License

Apache License 2.0. See [LICENSE](LICENSE).
