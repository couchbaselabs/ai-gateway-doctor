# AI Gateway Doctor

Checks the AI Gateway that serves Couchbase Capella Model Service inference, end to end: the gateway's cache cluster, the gateway node, and the deployed models. It also helps repair the most common failure, a full disk on the cache cluster node.

It knows the Keystone 2 controls of serverless (Bedrock) models: per-deployment rate limits, spend caps, Bedrock Guardrails and Bedrock batch. See [Keystone 2 checks](#keystone-2-checks).

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

# Simplest start: give the Capella URL of the organization. The script finds its AI gateways
# with your AWS credentials, fetches the config and runs the checks
./aigw-doctor.sh --from 'https://<console host>/product-hub/models?oid=<org id>' --check

# Dry run: show every command, run nothing
./aigw-doctor.sh -c /path/to/gateway.config.json --region us-east-2 --tenant-id <tenant id>

# Run the checks, including model probes and cache hits with a temporary API key
./aigw-doctor.sh -c /path/to/gateway.config.json --region us-east-2 --check \
  --tenant-id <tenant id> --create-api-key --cp-user you@example.com

# Web UI
cd ui && cp .env.example .env && $EDITOR .env && npm start   # http://127.0.0.1:4545
```

The gateway config is the AI Gateway's `config.json`. `--from` fetches it; a sandbox's Fleet Manager can also provide it. Run `./aigw-doctor.sh --help` for every option.

### Starting from a Capella URL or id: `--from`

`--from` takes a Capella console URL that carries the organization (`...?oid=<org id>` or `.../organizations/<org id>`), or a bare id that tags the gateway's instances (the organization id). It needs AWS credentials for the sandbox account: `--aws-profile NAME` picks the profile; without it the AWS CLI's usual choice applies, which is `AWS_PROFILE` if it is set and the `default` profile otherwise. The first result line names the profile used.

- **Finding the gateway:** running instances tagged with the id, in an Auto Scaling group named `capella-ai-gateway-*`, are looked up in `--region`, else in `us-east-1` and `us-east-2` (set `AIGW_FETCH_REGIONS` for other defaults). With one gateway it is used; with several you are asked which one. Each is shown with its URL (`https://<public DNS>:8081`), private IP, instance type and start time. A search of every region was dropped: it hung for minutes when one regional endpoint could not be reached.
- **Other URLs:** a URL without the organization, such as the Fleet Manager's (`https://fm.<env>/`), works when you add `--tenant-id <org id>`.
- **Fetching the config:** the gateway instance's user data names the Secrets Manager secret the gateway loads its config from (`aigwConfigKey`); the script reads that secret. Without it, or when it cannot be read, the script copies the gateway's live config file from the node through SSM. Only the tenant id, region, API URL and secret name are taken from the user data.
- **Where it is saved:** `<name>.config.json`, mode 600, in the folder the UI lists sandboxes from: `--config-dir`, else `AIGW_CONFIG_DIR`, else the folder set in `ui/.env`, else `~/.aigw-doctor/configs`. `--name` sets the name (default `gw-<org id start>-<region>`). A different earlier file of that name is kept as `.prev`.
- **What else it sets:** the tenant id, the organization id and the control plane URL (`https://api.<console host>`), unless you pass them.
- **Only fetch:** `--fetch-only` saves the config and stops; `--list-gateways` only lists the gateways.
- **You need:** `ec2:DescribeInstances`, `ec2:DescribeRegions`, `ec2:DescribeInstanceAttribute`, and either `secretsmanager:GetSecretValue` on the config secret or `ssm:SendCommand` on the gateway instance.

### Testing a new gateway build on a sandbox: `--install-build`

```bash
# What would happen: the gateway's binary, its architecture, how the build gets there. Changes nothing
./aigw-doctor.sh --from '<Capella URL>' --install-build https://latestbuilds.service.couchbase.com/builds/latestbuilds/ai-gateway/1.2.1/11/ --check

# Replace the binary (asks first; --yes skips the question)
./aigw-doctor.sh --from '<Capella URL>' --install-build https://latestbuilds.service.couchbase.com/builds/latestbuilds/ai-gateway/1.2.1/11/ --fix
```

- **The build:** give the build folder and the `linux-arm64.gz` file in it is picked (`--build-arch amd64` for the other one), or give the `.gz` file itself. The architecture must match the gateway node, or nothing is changed.
- **What it does on the gateway node:** downloads and unpacks the build next to the current binary, checks that it is a Linux binary for the node, stops `ai-gateway.service`, saves the current binary as `<binary>.bak-<time>`, puts the new one in place with the same owner and mode, and starts the service with `systemctl`. The binary is the one the service runs (`--aigw-service` names another unit).
- **If the service does not start:** the saved binary is put back, the service is started again, and the run fails with the service's last log lines.
- **Going back later:** the run prints the command, which copies the `.bak-<time>` file back and restarts the service.
- **How the build reaches the node:** the node downloads it when it can reach the URL. If it cannot (latestbuilds is inside the VPN), this machine downloads it and passes it on: over ssh with `--aigw-ssh`, or through an S3 bucket with `--build-bucket NAME` (uploaded, fetched by the node with a 15-minute link, then deleted).
- **Only this is done:** the checks are not run. Run them afterwards with `--check`.
- **Limits:** one gateway instance is changed. An instance that the Auto Scaling group replaces later starts with the released binary again.

## The doctor script: `aigw-doctor.sh`
Checks why the semantic cache stopped working, typically because the cache Couchbase cluster became unreachable when a volume on its EC2 node filled up. Then it confirms end to end that the deployed models answer and that repeated requests hit the cache. It runs these steps:

0. Checks that the AWS credentials are valid, and stops if they are expired.
1. Reads the gateway config: `couchbaseConnectString`, `dbCredKey`, `cacheKeyspace`, `adminKey` and the models. It also checks the Keystone 2 settings against the gateway's own rules. A config with no connect string and no cache-enabled model is a gateway without Couchbase, and the cache cluster checks (part of 2, then 4, 5 and the cache node in 6) are skipped.
2. Lists the ASGs and running instances tagged with the tenant (org) id, then picks:
   - the **cache node** from ASG `capella-ds-<deployment id>`
   - the **gateway** from ASG `capella-ai-gateway-<deployment id>`

   The deployment id is the UUID at the start of `dbCredKey`. It also checks that the gateway resolves the connect-string host to the cache node.
3. Searches the gateway log for Couchbase connection timeouts, and for settings the gateway rejected when it loaded its config (`Invalid … config` lines). Without `--log-file`, the script finds the log from the running `ai-gateway` process.
4. Checks, from the gateway, that the cluster's TLS ports are reachable: admin `18091` and data `11207`.
5. Fetches the admin credential (`dbCredKey`) from AWS Secrets Manager, then checks node health and the cache bucket through `https://<host>:18091`. It tries from your machine first. If the security group blocks that, it repeats the check on the gateway, where the gateway's instance role reads the secret itself.
6. Checks every real filesystem on both nodes, for space and for inodes. It also checks that `couchbase-server` is active on the cache node and the `ai-gateway` process is running on the gateway node.
   - **6b, Keystone 2 only:** checks that each Bedrock guardrail, batch S3 bucket and batch service role named in the config exists, and reads the rate-limit and spend-cap counters from the gateway's metrics.
7. Reads the gateway's version, build time and commit from `GET /v1/info` and reports them, for example "AI Gateway 1.42.0, built …, commit …". It warns about any model the gateway itself reports as unreachable. Then it probes every model in the config:
   - **Text-generation models:** a chat request. Then each cache type the config enables is tested. A type counts as enabled only when both `cacheConfig.isEnabled` and the type's own `isEnabled` are true: the top-level flag gives the API key its cache role, and without it the gateway skips the cache. Types turned off by the top-level flag are reported as SKIP.
     - **Test:** a newly generated question (two random topics and a reference number) is sent with `X-cb-cache: standard|semantic`. The first answer should be `X-Cache: MISS`, and the same question repeated must be a `HIT`.
     - **Retry:** if the first answer is already a HIT, because an older entry matched, the script tries a new question, up to three times.
     - **Reworded question (semantic only):** shown with `--verbose` for information. It depends on the score threshold, so it isn't counted as a pass or a failure.
     - **Why a repeat missed:** the repeat is sent with `X-cb-debug: true`, so a failed HIT reports the gateway's miss reason and match score.
   - **Embedding models:** an embeddings request. The vector length is checked against `embeddingDimensions` when the config sets it.
   - **Refused requests:** a request refused by a rate limit, a spend cap or a guardrail is reported as that, with its fix. See [Keystone 2 checks](#keystone-2-checks).
8. With `--fix`: for each full filesystem on either node, finds its EBS volume, grows it, then runs `growpart` and `resize2fs` or `xfs_growfs`. It restarts `couchbase-server` if the admin API is still down, then checks again. If a node is in an ASG, the script warns you to also raise the launch template's volume size.

| Mode | Behaviour |
|------|-----------|
| (default) | Dry run. Prints every command and runs nothing. |
| `--check` | Runs the checks. Prints the fix commands if a fix is needed, without running them. |
| `--fix` | Runs the checks, then the fixes. Asks for confirmation before each step that changes anything. |
| `--check --inference-only` | Runs only step 7, against the models in the config. Needs no AWS access when `--aigw-url` and an API key are given. |

Output is one `PASS`/`WARN`/`FAIL` line per check, followed by a result count. Each `FAIL` or `WARN` is followed by `HINT` lines on how to fix it, such as the command to run, the setting to change or the likely cause. The UI shows them under the check. `--verbose` adds the step headers, every command and remote script, and the listings (ASGs, instances, `df`, nodes). The fix commands are always shown.

The API key for step 7 can come from four places:
- `--api-key-file FILE`
- the `AIGW_API_KEY` environment variable
- `--create-api-key`: a temporary key made with the gateway's admin secret (needs AWS access)
- `--capella-api-key`: a model API key made through the Capella control plane (needs only your Capella sign-in)

With `--create-api-key`, the script reads the gateway admin credential from Secrets Manager (the `adminConfig.adminKey` secret). It uses that to create a temporary key through `POST /v1/apikeys`. The key expires after an hour and is deleted with `DELETE /v1/apikeys/<keyId>` when the run ends, including on Ctrl-C. To keep it instead, add `--save-api-key FILE`, which writes it with mode 600.

With `--capella-api-key`, the script asks the Capella control plane for a key (`POST /v2/organizations/<org id>/languageModelApiKeys`) that can use every model in `--region`. Use it where you cannot read the gateway's admin secret, such as production: together with `--inference-only` it needs no AWS credentials and no AWS CLI.
- **Sign-in:** `--cp-user EMAIL` with the password from `CP_PASSWORD` or a prompt, or a session JWT in `CP_JWT` when you sign in with SSO.
- **Organization:** from `--cp-url https://api.<env>.<domain>/v2/organizations/<org id>`, or `--org-id`.
- **Saved and reused:** the key is saved in `~/.aigw-doctor/keys` (`--keys-dir`, or `AIGW_DOCTOR_KEYS_DIR`) as `<name>.key` (the key) and `<name>.json` (id, expiry, organization, region), readable only by you. The next run for the same control plane, organization and region reuses it until five minutes before it expires, then creates a new one. Two runs never share a file name: a name that is taken gets `-1`, `-2` and so on. `--key-expiry SECS` sets the lifetime of a new key (default a day).
- **Not deleted:** unlike a temporary key, a Capella key stays valid until it expires. Delete it in the Capella console (or with the UI's **Delete this key**) and remove its two files to drop it earlier.

```bash
# Production: models and cache hits only, no AWS, a Capella key that is saved and reused
./aigw-doctor.sh -c config.json --region us-east-2 --check --inference-only --capella-api-key \
  --cp-url https://api.cloud.couchbase.com/v2/organizations/<org id> --cp-user you@example.com

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
- **Rate limits and spend:** the probes count against a deployment's rate limit and spend cap like any other request. A deployment with a very low limit makes the run slower, because the doctor waits for `Retry-After`.
- **Inference cost:** each chat request asks for at most 16 output tokens. Cache prompts include a run id, so every run starts with a cache miss. A model the API key has no access to is reported as a warning and skipped.
- **Temporary key scope:** a temporary key allows all models and all IPs (`0.0.0.0/0`), as in the `create-api-key` skill. It is short-lived and deleted at the end of the run.
- **Resizing volumes:** `--size GB` applies to every volume `--fix` grows. AWS allows one size change per volume every 6 hours. Filesystems on LVM are reported, not resized.
- **Remote commands:** run through SSM (`AWS-RunShellScript`). Use `--cb-ssh` or `--aigw-ssh` to connect over ssh instead.
- **Capella:** connect strings that point at Capella have no EC2 node, so steps 6 and 8 don't apply to them.
- **Exit code:** non-zero if any check fails. Run `--help` to see all options.

## Keystone 2 checks
Keystone 2 adds production controls to serverless (Bedrock) models. The doctor follows the gateway branch `aigateway_keystone2_bedrock`. A config without these settings gets no extra checks.

**Config (step 1).** A `WARN` means the gateway ignores the setting; a `FAIL` means it refuses the model's requests or the feature cannot work.

| Setting | Reported when |
|---|---|
| `rateLimit.requestsPerMinute` | outside 1–100000 (ignored: no limit) |
| `spendCap`, `regionSpendCap` | limit outside 0.000001–1e12, unit not `credits` or `tokens`, behavior not `warn` or `stop`, a credits cap without a `rateCard`, `cycleEnd` not after `cycleStart` (ignored: no cap) |
| `rateCard[]` | negative `value`, `per` of 0 or less, or a `charge` the gateway does not price |
| `regionSpendCap` in credits | models without a `rateCard`, named in the warning: their requests cost nothing against the cap |
| `guardrailConfig`, `jailbreakConfig` on a Bedrock model | enabled with neither a guardrail model nor `bedrockConfig.guardrail.id`; a guardrail without a version, with `DRAFT`, or set together with `guardrailIdentifier` (requests get 400 `guardrail_initialization_error`) |
| `bedrockConfig.guardrail` | set while both switches are off (not applied) |
| `bedrockConfig.batch` | enabled without `s3Bucket` or `serviceRoleArn`, `timeoutHours` outside 24–168, `guardrailMode` not `enforce` or `detect`; `detect` is flagged because nothing is blocked |
| `features.deploymentRateLimit`, `features.spendCap` | `false` while limits or caps are configured (not enforced) |
| `usageReport` | `spendStore` not `auto`, `local`, `couchbase` or `controlplane`; `intervalSeconds` outside 1–600 |

When everything is valid, one line lists the controls and the spend store in use, for example `Keystone 2 controls: 4 rate limits, 2 spend caps, a region spend cap, Bedrock Guardrails on 4 models; spend store: local`.

**AWS resources and counters (step 6b).** All read-only.
- **Guardrail:** `aws bedrock get-guardrail` must report the configured version as `READY` in the model's region.
- **Batch:** the S3 staging bucket (`aws s3api head-bucket`) and the service role (`aws iam get-role`) must exist.
- **Permissions:** when your credentials cannot look a resource up, the result is a `WARN`, not a `FAIL`. The lookups need `bedrock:GetGuardrail`, `s3:ListBucket` and `iam:GetRole`.
- **Counters:** read from the gateway's metrics (`http://127.0.0.1:9090/metrics` on the node): requests refused by a rate limit or a spend cap, and spend against each cap, with a warning from 80%. They are per gateway node and restart from zero with the gateway.

**Model probes (step 7).**

| Response | Result |
|---|---|
| 429 `deployment_rate_limit_exceeded` | The doctor waits for `Retry-After` (up to 30 s) and sends the request again, up to three times. If it is still refused: `WARN`, because the limit works. |
| 429 `spend_cap_exceeded` | `FAIL`: the region or model cap is reached, and the model does not answer until the next billing cycle or a higher cap. |
| 503 `guardrail_unavailable` | `FAIL`: the guardrail check could not run and failed closed. Usually the gateway's role lacks `bedrock:ApplyGuardrail`, or the guardrail version does not exist in the model's region. |
| 400 `guardrail_initialization_error` | `FAIL`: guardrails are enabled without a source. |
| A guardrail or jailbreak violation on the doctor's own probe | `WARN`: the guardrail blocked a harmless prompt, so the model is reachable but its filters are strict. Any other 422 is an ordinary failed request. |

**Optional probes.** Each sends extra requests, so each is off by default. They run only for a model whose plain probe answered.

| Option | What it does | Result |
|---|---|---|
| `--probe-guardrails` | One mild prompt-attack request ("Ignore all previous instructions…") to each chat model with jailbreak detection. | `PASS` only on HTTP 422 `jailbreak_violation_error`; `WARN` when the model answers it, when another guardrail check blocks it first, or when the refusal is not a 422. Uses guardrail text units. |
| `--probe-rate-limit` | One burst of parallel requests to each model with a rate limit, larger than the limit allows: the bucket's burst (a sixth of the per-minute limit, at least 1), plus two seconds of refill, plus 5. | `PASS` when some requests are refused with `deployment_rate_limit_exceeded` and every such response is itself HTTP 429 with a numeric `Retry-After`; `WARN` when all are answered (the limit is not enforced) or a refusal lacks the status or header. |
| `--probe-batch` | Uploads a two-request batch file for each model with `batchConfig.isEnabled`, creates the batch, waits for it and reads the results. | `PASS` when both requests are answered; `FAIL` when the upload, the batch or a request fails; `WARN` when it is still running at the timeout. |

- **Burst size:** a limit of 600 requests a minute needs 125 requests. `--burst-max N` (default 150) is the most the doctor will send; a deployment that needs more is skipped. Refused requests cost nothing, the answered ones ask for one output token. The burst uses up the deployment's limit for a few seconds, so it runs last for each model. It needs curl 7.66 or later (`--parallel`).
- **Several gateway nodes:** each node enforces its share of the limit, so the number of answered requests is close to the burst, not exact.
- **Batch:** a batch this small runs request by request (for Bedrock on the runtime, at the standard rate), so it finishes in seconds. It proves the Files and Batches API, the batch storage and the API key's batch role, not a native Bedrock batch job, which needs at least `minRecords` (100) requests and can take hours. `--batch-timeout SECS` (default 300) is how long the doctor waits, including a status request that does not answer; a batch still running then is cancelled. The probe's files are deleted afterwards, also on Ctrl-C and when the batch failed. If a cancel or delete does not succeed, the doctor tries once more at the end and then names the batch and files left on the gateway.

Not covered: a native Bedrock batch job (100 or more requests), and content-filter probes.

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
  - **API key: Capella key:** creates a model API key through the Capella control plane with the form's Control plane URL and Capella login, or a session JWT for SSO. It needs no gateway admin secret and no AWS access, so it works for production too. The key is saved in `~/.aigw-doctor/keys` and reused for the same control plane, organization and region until it expires (a Playground batch needs a key with about eight minutes left, and gets a new one otherwise). Runs, **Check version** and the Playground all use it.
  - **Optional probes:** the checkboxes under Models run the doctor with `--probe-guardrails`, `--probe-rate-limit` and `--probe-batch`. They are remembered per sandbox in the browser and are off until you tick them; **Reset to .env** clears them.
  - **Config tab:** shows a Keystone 2 section when the config uses it: whether rate limits and spend caps are enforced, the region spend cap and spend store, and each model's rate limit, spend cap, rate card, Bedrock guardrail and Bedrock batch bucket.
  - **Right:** the results, with one card per step and a PASS/WARN/FAIL line for each check. The commands and output are folded underneath, and fix commands are shown expanded. Step 7 lists every model request with its question, answer, `X-Cache`, HTTP status and latency. **Problems only** hides the passing checks, **Raw output** shows the doctor's text, and **Clear output** empties the window before the next run (saved runs stay in the **Run** list).
- **AI Gateway version:** the version reported by the sandbox's latest run is shown under its title and in the sandbox list. **Check version** fetches it live from `GET /v1/info`, using the same gateway URL and API key as the Playground.
- **Fleet Manager:** a sandbox's AI gateway config can be downloaded from its Fleet Manager, `https://fm.<env>.<domain>/`. A link appears under the Config file field, on the Config tab and in the Add sandbox form.
  - **Where the link comes from:** the control plane URL (`api.<env>.<domain>` becomes `fm.<env>.<domain>`), or the sandbox name with `SANDBOX_DOMAIN` from `.env` (`fm.<sandbox>.<SANDBOX_DOMAIN>`).
  - **Override:** set `FM_URL` or `<NAME>_FM_URL` in `.env` for other environments.
- **Adding a sandbox:** click **+ Add sandbox** under the list.
  - **Fetch from AWS (the default):** paste the Capella URL of the organization (it has `?oid=<org id>`) or the organization id and press **Find gateways**. The search covers `us-east-1` and `us-east-2`; type a **Region** first to search that one instead. A URL without the organization, such as the Fleet Manager's, works when **Tenant (org) id** is filled in. The organization's AI gateways found there are listed with their URL, instance, type, private IP and start time; pick one. **Add** then fetches that gateway's config with this machine's AWS credentials (see `--from` above), saves it in the config folder, and fills the region, tenant id and control plane URL.
  - **Fields:** a name (e.g. `my-sandbox`), a label, and the gateway config, fetched, uploaded or as a path on this machine. Then the region, tenant id, control plane URL (the console API URL with `/v2/organizations/<org id>` works), Capella login and models.
  - **Without a config (Later):** the sandbox is saved by name, region and tenant id, so you can use its Capella UI and Fleet Manager links, its Couchbase console and its terminals right away. The nodes are found from the tenant's running instances by their ASG names (`capella-ai-gateway-*`, `capella-ds-*`). Runs, the Config tab, the Playground and copying the Couchbase credentials need the config. Add it later by setting the Config file path and pressing **Save to .env**, or by putting `<name>.config.json` in the config folder.
  - **Upload:** an uploaded config is saved as `<name>.config.json` in `AIGW_CONFIG_DIR` (default `~/.aigw-doctor/configs`), with mode 600.
  - **`.env`:** the settings are appended as a commented `<NAME>_*` block, and a path-based sandbox is also added to `SANDBOXES`.
  - **Passwords and API keys:** not written by the UI. Add `CP_PASSWORD` or `<NAME>_CP_PASSWORD` to `.env` yourself, or type them in the run form.
  - **By hand:** you can instead drop `<name>.config.json` into `AIGW_CONFIG_DIR` and add `<NAME>_*` keys to `.env`.
- **Installing a gateway build:** **Install a gateway build** at the bottom of the run form takes the build URL, the architecture (arm64 by default) and, if needed, an S3 bucket. **Check first** shows what would be replaced. **Install build…** asks in the page, then runs `--install-build` with `--fix --yes`; the result appears under Results. This is the only change the UI makes to a sandbox.
- **Deleting a sandbox:** **Delete** next to the sandbox title, after a confirmation, removes the sandbox's `<NAME>_*` lines, the comment header the UI wrote for it, and its `SANDBOXES` entry from `.env` (the previous file is kept as `.env.bak`).
  - **Config file:** one in `AIGW_CONFIG_DIR` is moved to `.deleted/` there, or the sandbox would be found again. A config elsewhere is left alone.
  - **Kept:** saved runs and logs.
  - **Refused:** while the sandbox has a run in progress.
- **Config tab:** next to **Results**, it shows what the selected sandbox's config sets up.
  - **Cache store:** the cluster host and keyspaces, and the Secrets Manager entries (by name only).
  - **Models:** one card per model, with its kind, backend and status, and its cache settings: the top-level and per-type flags, default type and expiry. Each card also shows which cache types the doctor will test, or why it won't.
  - **Details:** the semantic cache's embedding model, threshold, dimensions, similarity and index; guardrail, jailbreak and batch flags; and qps, queue and timeout.
  - **Not shown:** certificates, model keys and other secret values are never sent to the page. `?tab=config` opens this tab directly.
- **Sandbox links:** under the sandbox title, **Capella UI ↗** opens the sandbox's Capella console (`https://ui.<env>.<domain>/`) and **Fleet Manager ↗** opens `https://fm.<env>.<domain>/`, where the AI gateway config is downloaded. They come from the sandbox's control plane URL in `.env` or the form. Without one, the server reads it once from the gateway instance (found from its ASG): only the `api` field of its EC2 user data, `https://<env>.internal-api.<domain>`, is used. The form's control plane URL field then shows what was found. A sandbox known only by name, such as `sbx-18`, gets `ui.sbx-18.<domain>` and `fm.sbx-18.<domain>`. The domain comes from `SANDBOX_DOMAIN`, which the server learns from the first sandbox whose links it finds and saves to `.env`. Override the links with `UI_URL` / `<NAME>_UI_URL` and `FM_URL` / `<NAME>_FM_URL` in `.env`.
- **Couchbase console:** the buttons under the sandbox title help you log in to the cache cluster's web console.
  - **Open ↗:** opens `https://<cache node public DNS>:18091`. The host comes from the sandbox's last run, or from an AWS lookup of the `capella-ds-<deployment id>` ASG. Expect a certificate warning, because the sandbox uses a self-signed certificate.
  - **Copy user / Copy password:** read the config's `dbCredKey` credential from Secrets Manager with your AWS credentials and put it on your clipboard. The password is fetched only when you click, and is not stored anywhere.
- **Raw config:** **Raw JSON** on the Config tab shows the config file, with **Copy** and **Download**. Private keys (also base64-encoded ones) and password, token and secret fields are redacted. Public certificates and Secrets Manager names are shown.
- **Playground tab:** send your own requests to any model in the config.
  - **Choices:** the model, the cache mode (`none`, `standard` or `semantic`, marked when the config has it off), max tokens, temperature and an optional system prompt. Embedding models get an embeddings request.
  - **Each answer shows:** `X-Cache`, HTTP status, the token count (total, in and out; streamed answers get it from the gateway's final usage chunk), latency, the answer, the request and response headers, the raw response, and a **curl command** to share. It has the same headers and body, with the API key as `$AIGW_API_KEY`, `-i` to show the response headers, and `-k` only when TLS wasn't verified. **Send again** repeats the last request, which is the quickest way to see a cache HIT.
  - **Headers:** shown with their original casing. The Authorization value is redacted, and cache and `X-cb-*` headers are highlighted.
  - **Stream:** sends `"stream": true` for chat requests and writes the answer into the page as the chunks arrive. The finished entry shows the time to the first token, the total time and the number of chunks. `X-Cache` still shows, because it arrives with the response headers. Embeddings aren't streamed, and the curl command gets `-N`.
  - **Debug:** sends `X-cb-debug: true`. The gateway then adds its `X-cb-*` debug headers (cache type, match threshold and so on), which are listed under the answer.
  - **Gateway URL:** taken from the form, else the endpoint found by the last run's control plane lookup.
  - **API key:** follows the form's choice. A temporary key is created once per sandbox, reused for up to an hour, and deleted when the server stops.
  - **Custom endpoint:** switch the target to **Custom endpoint** to check any environment (dev, stage or prod) the way a client does, with just the gateway URL and an API key. No sandbox, config or AWS is needed.
    - **Connect:** shows the gateway's version, build and commit from `GET /v1/info`, and lists every model the key can use from `GET /v1/models` in a dropdown, with their status. **Other (type a name)…** takes a model that isn't listed.
    - **Request type:** pick **Chat completions** or **Embeddings** (guessed from the model name), **Moderations** or **Batch**.
    - **Detect cache:** a client can't read a model's cache settings, so this sends one tiny chat request per cache type (1 output token, `X-cb-debug: true`, a unique prompt). It reads `X-cb-cache-enabled` from each response, falling back to the presence of `X-Cache` on gateways without debug headers. The cache options then show which types are on, with the semantic threshold and embedding model. It runs only when clicked, and each check leaves a cache entry.
    - **Create an API key:** makes a model API key through the Capella control plane (`POST /v2/organizations/<org id>/languageModelApiKeys`), so you need no existing key and no AWS access.
      - **You give:** the control plane URL with the organization (for production `https://api.cloud.couchbase.com/v2/organizations/<org id>`), the region of the models, a key name, an expiry (1 hour to 180 days) and the allowed IPs (default `0.0.0.0/0`).
      - **Sign-in:** your Capella email and password, or a session JWT when you sign in with SSO.
      - **Result:** the key has access to every model in the region and is put into the API key field. When the organization has a model in that region, its gateway endpoint fills an empty Gateway URL.
      - **Delete this key** removes the key you just created (`DELETE …/languageModelApiKeys/<key id>`).
      - **Saved keys:** with **Save the key on this machine** ticked (the default), the key is written to `~/.aigw-doctor/keys`, readable only by you. The **Saved key** list above then offers it again: pick one and leave the API key field empty. The server reads the key from the file, so it does not pass through the page. **Forget** removes the files from this machine; the key stays valid in Capella.
      - **Not saved:** the password and the JWT stay in the page. The URL, region and email are remembered in the browser.
    - **TLS:** certificates are verified. Untick **Verify TLS certificate** for a self-signed gateway.
    - **Key:** the API key stays in the page and is never saved. The URL is remembered.
  - **Request type:** next to the model. A sandbox picks chat or embeddings from the model's kind; a custom endpoint lets you choose. Both can also send:
    - **Moderations:** `POST /v1/moderations` with the prompt as `input`. The answer shows flagged or not flagged, with the categories that fired. For a sandbox model the request carries `X-cb-model-ref: <the model's id>`, which is how a Bedrock deployment's guardrail is named.
    - **Batch:** each line of the prompt becomes one request (up to 20, so the batch runs right away and not as a native Bedrock batch job). The server uploads the file (`POST /v1/files`), creates the batch (`POST /v1/batches`), waits up to three minutes, reads the output and error files, and deletes the files. The entry shows every step, each line's answer or error, the route and billing rate, the batch file, and the curl commands for the same calls. A batch still running after three minutes is cancelled. Cleanup is checked: a cancel or delete the gateway does not confirm is tried again and then reported with the ids left behind, also after a network error part-way and when the UI server is stopped during a batch. A result file that cannot be read is kept on the gateway, not deleted; the entry names it and has a **Fetch again** button, which reads it through the server with the key that made it and then deletes it. When the server stops, a batch in flight finishes the request it is waiting on, then cancels and deletes what it created; kept files made with a temporary key are deleted, since nobody can read them once that key is revoked.
  - **Request headers:** a section under the system prompt.
    - Three checkboxes send `X-cb-suppress-request-guardrails`, `X-cb-suppress-request-jailbreak` and `X-cb-suppress-response-guardrails` with the value `true`, to see what a safety check changes. They apply to chat and embeddings; batch lines carry no headers.
    - **Deployment id** sends `X-cb-model-ref`.
    - **Custom metric labels** takes `name=value` pairs separated by commas, for example `workflowId=invoice-triage, appId=billing-portal`, and sends each as `X-cb-metric-label-<name>`. The gateway adds them to its Prometheus metrics for chat and embeddings requests, for the names on its allowlist (`metricsCustomLabels` in the gateway config; by default workflowId, appId, teamId, tenantId and sessionId), and ignores other names. The Config tab shows the allowlist when the config sets one.
    - **Additional headers** takes one `X-cb-<name>: value` per line, for example `X-cb-guardrail-response: inline` on a batch or `X-cb-cache-threshold: 0.8`. Other header names are refused, so the form cannot replace `Authorization`.
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
  - Password and API key fields are masked. The eye icon in each one shows or hides what you typed or pasted.
- **No `--fix`:** fix mode asks for confirmation on the terminal, so the UI offers only check and dry run. To repair, run the script with `--fix` in a terminal.

## License

Apache License 2.0. See [LICENSE](LICENSE).
