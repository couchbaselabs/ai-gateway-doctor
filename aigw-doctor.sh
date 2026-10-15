#!/usr/bin/env bash
# AI Gateway Doctor: diagnose (and optionally repair) a semantic cache that
# stopped working because the cache Couchbase cluster became unreachable, and
# confirm end to end that the deployed models answer and hit the cache.
#
# Follows the steps used to debug a sandbox whose semantic cache stopped working:
#   1. read the gateway config (connect string, dbCredKey, cache keyspace, models)
#   2. find the Couchbase node (ASG capella-ds-<id>) and the gateway (ASG
#      capella-ai-gateway-<id>) from the tenant's tagged resources, the node's
#      public DNS/IP, and check the gateway resolves the connect-string host to it
#   3. scan the gateway log for Couchbase connection timeouts
#   4. check TLS reachability (18091/11207) of the cache cluster from the ai-gateway
#   5. fetch the Couchbase admin credential from AWS Secrets Manager (dbCredKey)
#      and check the admin REST API (https://<host>:18091), node health and the
#      cache bucket; from this machine first, then from the ai-gateway
#   6. check every filesystem (space and inodes) on the cache node and the ai-gateway
#   7. send every model in the config a probe (chat or embeddings), then send each
#      cache-enabled chat model the same prompt twice per cache type (standard,
#      semantic) and expect X-Cache: HIT on the repeat; needs an API key
#   8. --fix: grow the EBS volume behind each full filesystem (growpart +
#      resize2fs/xfs_growfs) on either node, and restart couchbase-server if the
#      admin API is still down, then re-check
#
# Modes:
#   (default)         dry run: print every command, execute nothing
#   --check           run the checks; print fix commands without running them
#   --fix             run the checks, then run fixes, confirming each mutating step
#   --inference-only  run only step 7 (with --check): model probes and cache hits
#
# Output is one line per check plus a result count. --verbose adds step headers,
# every command, remote scripts and listings (ASGs, instances, df). A dry run is
# always verbose.
#
# Remote commands run through AWS SSM (AWS-RunShellScript) unless an ssh target
# is given. Passwords and API keys are never printed, never put on a command line
# and never sent in an SSM command.
#
# Usage:
#   ./aigw-doctor.sh -c config.json [--check|--fix] [options]
#
# Options:
#   -c, --config FILE      gateway config.json (required)
#   -v, --verbose          show commands, remote scripts and listings
#   --inference-only       skip the infrastructure checks; only probe the models
#   --region REGION        AWS region of the deployment (default: $AWS_REGION or us-east-2)
#   --sm-region REGION     Secrets Manager region (default: --region)
#   --tenant-id ID         tenant (org) id; finds the cache node in ASG <ds prefix><deployment id>
#                          and the gateway in ASG <aigw prefix><deployment id>, where the
#                          deployment id is the UUID prefix of dbCredKey
#                          (default: read from the --aigw-instance user data)
#   --ds-asg-prefix P      cache cluster ASG name prefix (default: capella-ds-)
#   --aigw-asg-prefix P    gateway ASG name prefix (default: capella-ai-gateway-)
#   --cb-instance ID       Couchbase EC2 instance id (default: the instance in the cache ASG)
#   --cb-host HOST         public DNS/IP to reach the Couchbase node from this machine
#                          (default: the instance's PublicDnsName, then PublicIpAddress)
#   --cb-ssh USER@HOST     reach the Couchbase node over ssh instead of SSM
#   --aigw-instance ID     gateway EC2 instance id, to scan its log and test reachability from it
#                          (default: the instance in the gateway ASG, when --tenant-id is given)
#   --aigw-ssh USER@HOST   reach the gateway over ssh instead of SSM
#   --log-file PATH        gateway log path (default: found from the running ai-gateway
#                          process's SERVER_LOG_DIR and working directory)
#   --admin-url URL        Couchbase admin URL (default: https://<public host>:18091)
#   --aigw-url URL         gateway base URL for step 7 (default: looked up in the Capella control
#                          plane when --cp-user is given, else https://<gateway public DNS>:8081)
#   --cp-user EMAIL        Capella console login (or set CP_USER); with it the gateway endpoint is
#                          read from the control plane (network.endpoint of the org's language
#                          models in --region). The password comes from CP_PASSWORD or a prompt.
#   --cp-url URL           control plane API, e.g. https://api.<env>.<domain>;
#                          a URL with /v2/organizations/<org id> also sets --org-id
#                          (default: derived from the "api" field of the gateway instance's user
#                          data, which is the internal API: <env>.internal-api.<domain> -> api.<env>.<domain>)
#   --org-id ID            Capella organization id (default: --tenant-id)
#   --api-key-file FILE    gateway API key for step 7 (or set AIGW_API_KEY)
#   --create-api-key       create a temporary API key for step 7 with the gateway admin
#                          credential (adminConfig.adminKey in Secrets Manager); it expires
#                          in an hour and is deleted when the run ends
#   --save-api-key FILE    with --create-api-key: write the key to FILE (mode 600) and keep it
#   --models LIST          comma-separated modelName or id values to test (default: all)
#   --skip-inference       do not send inference requests
#   --size GB              new size for every volume --fix grows (default: double its size)
#   --threshold PCT        filesystem use (space or inodes) that counts as full (default: 85)
#   --snapshot             snapshot each volume before resizing it
#   --log-dir DIR          where each run's full log is saved (default: $AIGW_DOCTOR_LOG_DIR or
#                          ~/.aigw-doctor/logs); the log always holds the --verbose detail
#   --no-log               do not save a run log
set -uo pipefail

MODE=dry-run
VERBOSE=false
INFRA=true
CONFIG=""
REGION="${AWS_REGION:-us-east-2}"
SM_REGION=""
TENANT_ID=""
DS_ASG_PREFIX="capella-ds-"
AIGW_ASG_PREFIX="capella-ai-gateway-"
CB_INSTANCE=""
CB_HOST_OVERRIDE=""
CB_SSH=""
AIGW_INSTANCE=""
AIGW_SSH=""
LOG_FILE="${SERVER_LOG_DIR:-.}/server-aigateway.log"
LOG_FILE_SET=false
ADMIN_URL=""
AIGW_URL=""
CP_USER="${CP_USER:-}"
CP_URL=""
ORG_ID=""
API_KEY_FILE=""
CREATE_KEY=false
SAVE_KEY_FILE=""
MODELS_FILTER=""
SKIP_INFERENCE=false
NEW_SIZE=""
THRESHOLD=85
SNAPSHOT=false
RUN_LOG_DIR="${AIGW_DOCTOR_LOG_DIR:-$HOME/.aigw-doctor/logs}"
RUN_LOG_ENABLED=true
ORIG_ARGS=("$@")

usage() { sed -n '2,/^set -uo/p' "$0" | sed '$d; s/^# \{0,1\}//'; exit "${1:-0}"; }

while [[ $# -gt 0 ]]; do
	case "$1" in
	-c | --config) CONFIG="$2"; shift ;;
	-v | --verbose) VERBOSE=true ;;
	--check) MODE=check ;;
	--fix) MODE=fix ;;
	--dry-run) MODE=dry-run ;;
	--inference-only) INFRA=false ;;
	--region) REGION="$2"; shift ;;
	--sm-region) SM_REGION="$2"; shift ;;
	--tenant-id) TENANT_ID="$2"; shift ;;
	--ds-asg-prefix) DS_ASG_PREFIX="$2"; shift ;;
	--aigw-asg-prefix) AIGW_ASG_PREFIX="$2"; shift ;;
	--cb-instance) CB_INSTANCE="$2"; shift ;;
	--cb-host) CB_HOST_OVERRIDE="$2"; shift ;;
	--cb-ssh) CB_SSH="$2"; shift ;;
	--aigw-instance) AIGW_INSTANCE="$2"; shift ;;
	--aigw-ssh) AIGW_SSH="$2"; shift ;;
	--log-file) LOG_FILE="$2"; LOG_FILE_SET=true; shift ;;
	--admin-url) ADMIN_URL="$2"; shift ;;
	--aigw-url) AIGW_URL="${2%/}"; shift ;;
	--cp-user) CP_USER="$2"; shift ;;
	--cp-url) CP_URL="${2%/}"; shift ;;
	--org-id) ORG_ID="$2"; shift ;;
	--api-key-file) API_KEY_FILE="$2"; shift ;;
	--create-api-key) CREATE_KEY=true ;;
	--save-api-key) SAVE_KEY_FILE="$2"; shift ;;
	--models) MODELS_FILTER="$2"; shift ;;
	--skip-inference) SKIP_INFERENCE=true ;;
	--size) NEW_SIZE="$2"; shift ;;
	--threshold) THRESHOLD="$2"; shift ;;
	--snapshot) SNAPSHOT=true ;;
	--log-dir) RUN_LOG_DIR="$2"; shift ;;
	--no-log) RUN_LOG_ENABLED=false ;;
	-h | --help) usage 0 ;;
	*) echo "unknown option: $1" >&2; usage 1 ;;
	esac
	shift
done
die() { echo "error: $*" >&2; exit 1; }
[[ -n "$CONFIG" ]] || { echo "error: -c/--config is required" >&2; usage 1; }
[[ -f "$CONFIG" ]] || die "config not found: $CONFIG"
[[ -z "$API_KEY_FILE" || -f "$API_KEY_FILE" ]] || die "API key file not found: $API_KEY_FILE"
[[ -z "$SAVE_KEY_FILE" ]] || $CREATE_KEY || die "--save-api-key needs --create-api-key"
[[ -z "$API_KEY_FILE" ]] || ! $CREATE_KEY || die "use either --api-key-file or --create-api-key"
! $INFRA && $SKIP_INFERENCE && die "--inference-only and --skip-inference leave nothing to run"
! $INFRA && [[ "$MODE" == fix ]] && die "--inference-only has nothing to fix; use --check"
SM_REGION="${SM_REGION:-$REGION}"
[[ "$MODE" == dry-run ]] && VERBOSE=true

# --cp-url may be a console API URL such as https://api.<env>.<domain>/v2/organizations/<org id>:
# keep the base and take the org id from the path.
if [[ "$CP_URL" =~ ^(https?://[^/]+)(/.*)?$ ]]; then
	cp_path="${BASH_REMATCH[2]}"
	CP_URL="${BASH_REMATCH[1]}"
	if [[ "$cp_path" =~ ^/v[0-9]+/organizations/([0-9a-fA-F-]+) ]]; then
		ORG_ID="${ORG_ID:-${BASH_REMATCH[1]}}"
	fi
elif [[ -n "$CP_URL" ]]; then
	die "--cp-url must start with https://"
fi

# ---------- output helpers ----------

if [[ -t 1 ]]; then
	B=$'\e[1m' DIM=$'\e[2m' RED=$'\e[31m' GRN=$'\e[32m' YEL=$'\e[33m' RST=$'\e[0m'
else
	B="" DIM="" RED="" GRN="" YEL="" RST=""
fi
SUMMARY=()
N_PASS=0 N_WARN=0 N_FAIL=0
FAILED=0

# Verbose-only lines are tagged with MARK: the logger writes them to the run log but not
# to the console, so the log always has the full detail.
MARK=$'\037'
detail() { if $VERBOSE; then cat; else sed "s/^/$MARK/"; fi; }  # stdin as verbose-only lines

step() { printf '\n%s== %s ==%s\n' "$B" "$*" "$RST" | detail; }
info() { if $VERBOSE; then printf '   %s\n' "$*"; else printf '%s   %s\n' "$MARK" "$*"; fi; }  # detail
note() { printf '   %s\n' "$*"; }                          # always shown
pass() { printf '   %sPASS%s %s\n' "$GRN" "$RST" "$*"; SUMMARY+=("PASS  $*"); N_PASS=$((N_PASS + 1)); }
warn() { printf '   %sWARN%s %s\n' "$YEL" "$RST" "$*"; SUMMARY+=("WARN  $*"); N_WARN=$((N_WARN + 1)); }
fail() {
	printf '   %sFAIL%s %s\n' "$RED" "$RST" "$*"
	SUMMARY+=("FAIL  $*")
	N_FAIL=$((N_FAIL + 1))
	FAILED=1
}
skip() { printf '   %sSKIP%s %s\n' "$DIM" "$RST" "$*"; }
# hint TEXT: how to fix the FAIL/WARN printed just before it (always shown, and in the log).
hint() { printf '   %sHINT%s %s\n' "$YEL" "$RST" "$*"; }
indent() { sed 's/^/      /'; }
vindent() { indent | detail; }  # listing, --verbose only

# shellquote ARGS...: print args the way you would type them
shellquote() {
	local a out="" sq="'\\''"
	for a in "$@"; do
		if [[ "$a" =~ ^[A-Za-z0-9_./:=,@%+-]+$ ]]; then out+="$a "; else out+="'${a//\'/$sq}' "; fi
	done
	printf '%s' "${out% }"
}

# allowed KIND: should a command of this kind (check|fix) execute in the current mode?
allowed() { [[ "$MODE" == fix || ("$MODE" == check && "$1" == check) ]]; }

# echoed KIND: print commands of this kind? Fix commands are always shown.
echoed() { $VERBOSE || [[ "$1" == fix ]]; }

# show KIND: stdin (an echoed command) to stderr; check commands are verbose-only.
show() { if echoed "$1"; then cat >&2; else sed "s/^/$MARK/" >&2; fi; }

# run KIND CMD...: print the command, execute it if the mode allows. Output goes to stdout.
run() {
	local kind="$1"; shift
	printf '   %s[%s] $ %s%s\n' "$DIM" "$kind" "$(shellquote "$@")" "$RST" | show "$kind"
	allowed "$kind" || return 0
	if $VERBOSE; then
		"$@"
	else
		# stdout stays the result; stderr goes to the run log only.
		{ "$@" 2>&1 1>&5 | sed "s/^/$MARK/" >&2; } 5>&1
	fi
}

# remote KIND TARGET SCRIPT: print SCRIPT, run it on TARGET ("ssh:user@host", "ssm:i-xxx" or "local").
remote() {
	local kind="$1" target="$2" script="$3"
	{
		printf '   %s[%s] on %s:%s\n' "$DIM" "$kind" "$(target_label "$target")" "$RST"
		printf '%s\n' "$script" | sed "s/^/      $DIM| /; s/\$/$RST/"
	} | show "$kind"
	allowed "$kind" || return 0
	case "$target" in
	ssh:*) ssh -o BatchMode=yes -o ConnectTimeout=10 "${target#ssh:}" 'bash -s' <<<"$script" ;;
	ssm:*) ssm_exec "${target#ssm:}" "$script" ;;
	local) bash -c "$script" ;;
	*) echo "no remote target" >&2; return 1 ;;
	esac
}

ssm_exec() {
	local inst="$1" script="$2" cid status="" i
	cid=$(aws ssm send-command --region "$REGION" --instance-ids "$inst" \
		--document-name AWS-RunShellScript \
		--parameters "$(jq -n --arg c "$script" '{commands: [$c]}')" \
		--query Command.CommandId --output text) || return 1
	for i in $(seq 1 90); do
		status=$(aws ssm get-command-invocation --region "$REGION" --command-id "$cid" \
			--instance-id "$inst" --query Status --output text 2>/dev/null || echo Pending)
		case "$status" in Success | Failed | Cancelled | TimedOut) break ;; esac
		sleep 2
	done
	aws ssm get-command-invocation --region "$REGION" --command-id "$cid" --instance-id "$inst" \
		--query '[StandardOutputContent, StandardErrorContent]' --output text
	[[ "$status" == Success ]]
}

confirm() {
	local reply
	[[ "$MODE" == fix ]] || return 1
	printf '   %s?%s %s [y/N] ' "$YEL" "$RST" "$*" >/dev/tty
	read -r reply </dev/tty || return 1
	info "confirm: $* -> ${reply:-N}"
	[[ "$reply" =~ ^[Yy]$ ]]
}

# target_label TARGET: a target named by its role and ASG, e.g. "ai-gateway i-0... (capella-ai-gateway-...)"
target_label() {
	local t="$1"
	if [[ "$t" == local ]]; then
		echo "this machine"
	elif [[ -n "${AIGW_INSTANCE:-}${AIGW_SSH:-}" && ("$t" == "ssm:${AIGW_INSTANCE:-}" || "$t" == "ssh:${AIGW_SSH:-}") ]]; then
		echo "ai-gateway ${AIGW_INSTANCE:-$AIGW_SSH}${AIGW_ASG:+ ($AIGW_ASG)}"
	elif [[ -n "${CB_INSTANCE:-}${CB_SSH:-}" && ("$t" == "ssm:${CB_INSTANCE:-}" || "$t" == "ssh:${CB_SSH:-}") ]]; then
		echo "cache node ${CB_INSTANCE:-$CB_SSH}${CB_ASG:+ ($CB_ASG)}"
	else
		echo "${t#*:}"
	fi
}

target_for() { # target_for INSTANCE SSH [FALLBACK]
	if [[ -n "$2" ]]; then echo "ssh:$2"; elif [[ -n "$1" ]]; then echo "ssm:$1"; else echo "${3:-}"; fi
}

# basic_config USER_PASS / bearer_config KEY: a curl config that sets the Authorization
# header, read through a file descriptor so the secret never appears in argv.
curl_escape() { local v="${1//\\/\\\\}"; printf '%s' "${v//\"/\\\"}"; }
basic_config() { printf 'header = "Authorization: Basic %s"\n' "$(printf '%s' "$1" | base64 | tr -d '\n')"; }
bearer_config() { printf 'header = "Authorization: Bearer %s"\n' "$(curl_escape "$1")"; }

for tool in jq aws curl nc; do
	command -v "$tool" >/dev/null || die "'$tool' is required"
done

# ---------- 0. AWS credentials ----------

step_aws() {
	step "0. AWS credentials"
	if ! CALLER=$(run check aws sts get-caller-identity --region "$REGION" --query Arn --output text); then
		fail "AWS credentials missing or expired; refresh them (e.g. aws sso login, or re-export the session) and re-run"
		hint "check with: aws sts get-caller-identity --region $REGION"
		exit 1
	fi
	allowed check && pass "AWS credentials: ${CALLER##*/}"
}

# ---------- 1. gateway config ----------

step_config() {
	step "1. Gateway config ($CONFIG)"
	CONNECT=$(jq -r '.modelServiceStoreConfig.couchbaseConnectString // empty' "$CONFIG")
	CRED_KEY=$(jq -r '.modelServiceStoreConfig.defaults.dbCredKey // empty' "$CONFIG")
	CACHE_KS=$(jq -r '.modelServiceStoreConfig.defaults.cacheKeyspace // empty' "$CONFIG")
	ADMIN_KEY_NAME=$(jq -r '.adminConfig.adminKey // empty' "$CONFIG")
	N_MODELS=$(jq '[.modelConfig.models[]?] | length' "$CONFIG")
	info "couchbaseConnectString = ${CONNECT:-<missing>}"
	info "dbCredKey              = ${CRED_KEY:-<missing>}"
	info "cacheKeyspace          = ${CACHE_KS:-<missing>}"
	info "adminKey               = ${ADMIN_KEY_NAME:-<missing>}"
	info "models                 = $N_MODELS"

	# couchbases://host1,host2?opts -> host1. The gateway always prefixes "couchbases://"
	# (pkg/config/configurator.go), so it talks TLS: admin 18091, data 11207.
	CB_HOST=$(sed -E 's#^[a-z]+://##; s#[,/?].*$##; s#:[0-9]+$##' <<<"$CONNECT")
	ADMIN_PORT=18091 KV_PORT=11207 SCHEME=https
	CACHE_BUCKET="${CACHE_KS%%:*}"

	# ASGs are named <prefix><deployment id>; dbCredKey is "<deployment id>_..." in the config.
	DEPLOY_ID=""
	[[ "$CRED_KEY" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}_ ]] &&
		DEPLOY_ID="${CRED_KEY%%_*}"

	if ! $INFRA; then
		pass "config: $N_MODELS model(s)"
	elif [[ -z "$CONNECT" ]]; then
		fail "config: modelServiceStoreConfig.couchbaseConnectString is missing"
		hint "download the sandbox's AI gateway config from its Fleet Manager; it must include modelServiceStoreConfig"
	elif [[ -z "$CRED_KEY" ]]; then
		fail "config: modelServiceStoreConfig.defaults.dbCredKey is missing"
		hint "download the sandbox's AI gateway config from its Fleet Manager; it must include modelServiceStoreConfig.defaults.dbCredKey"
	else
		pass "config: cache cluster $CB_HOST, $N_MODELS model(s)"
	fi
}

# ---------- 2. locate the Couchbase node and the gateway ----------

# pick_one IDS: print the id if IDS holds exactly one instance id
pick_one() { [[ $(grep -c '^i-' <<<"$1") -eq 1 ]] && grep '^i-' <<<"$1"; }

# in_asg PREFIX [ID]: tenant instances whose ASG name starts with PREFIX (and ends with ID)
in_asg() {
	jq -r --arg p "$1" --arg id "${2:-}" '.[] |
		((.Tags // []) | from_entries | .["aws:autoscaling:groupName"] // "") as $g |
		select(($g | startswith($p)) and ($id == "" or ($g | endswith($id)))) | .InstanceId' \
		<<<"$TENANT_JSON"
}

# asg_of ID: the ASG name tag of a tenant instance
asg_of() {
	jq -r --arg i "$1" '.[] | select(.InstanceId == $i) |
		((.Tags // []) | from_entries | .["aws:autoscaling:groupName"] // empty)' <<<"$TENANT_JSON"
}

# public_dns_of ID: the public DNS name of a tenant instance
public_dns_of() {
	jq -r --arg i "$1" '.[] | select(.InstanceId == $i) | .PublicDnsName // empty' <<<"$TENANT_JSON"
}

# asg_pick PREFIX: the one instance in PREFIX<deployment id>, else the one with PREFIX
asg_pick() {
	local id=""
	[[ -n "$DEPLOY_ID" ]] && id=$(pick_one "$(in_asg "$1" "$DEPLOY_ID")")
	[[ -n "$id" ]] && { echo "$id"; return; }
	pick_one "$(in_asg "$1")"
}

TENANT_JSON="[]"
CB_ASG="" AIGW_ASG="" AIGW_PUBLIC=""
AIGW_TARGET=$(target_for "$AIGW_INSTANCE" "$AIGW_SSH" local)

# step_locate_tenant: list the tenant's ASGs and instances and pick the gateway (and,
# for the infrastructure checks, the cache node) by ASG name.
step_locate_tenant() {
	step "2. Locate the Couchbase node and the gateway"

	# The tenant (org) id tags every resource of the deployment. The gateway reads it
	# from its EC2 user data (UserMetadata.tenantId); only that field is extracted.
	if [[ -z "$TENANT_ID" && -n "$AIGW_INSTANCE" ]]; then
		info "reading tenantId from the gateway's user data"
		TENANT_ID=$(run check aws ec2 describe-instance-attribute --region "$REGION" \
			--instance-id "$AIGW_INSTANCE" --attribute userData --query UserData.Value --output text |
			{ base64 --decode 2>/dev/null || base64 -D; } | jq -r '.tenantId // empty' 2>/dev/null)
	fi
	allowed check || TENANT_ID="${TENANT_ID:-<tenant-id>}"
	info "tenant id: ${TENANT_ID:-<none>}, deployment id: ${DEPLOY_ID:-<none>}"
	info "cache node ASG: ${DS_ASG_PREFIX}${DEPLOY_ID:-*}, gateway ASG: ${AIGW_ASG_PREFIX}${DEPLOY_ID:-*}"

	if [[ -n "$TENANT_ID" ]]; then
		info "auto scaling groups tagged with the tenant id:"
		ASGS=$(run check aws autoscaling describe-auto-scaling-groups --region "$REGION" \
			--filters "Name=tag-value,Values=$TENANT_ID" \
			--query 'AutoScalingGroups[].[AutoScalingGroupName,MinSize,DesiredCapacity,MaxSize,length(Instances)]' \
			--output text)
		if allowed check && [[ -n "$ASGS" ]]; then
			awk -F'\t' -v ds="$DS_ASG_PREFIX" -v gw="$AIGW_ASG_PREFIX" '{
				role = index($1, ds) == 1 ? "  <- cache cluster" : index($1, gw) == 1 ? "  <- ai gateway" : ""
				printf "%s  min=%s desired=%s max=%s instances=%s%s\n", $1, $2, $3, $4, $5, role
			}' <<<"$ASGS" | vindent
		fi
		info "running instances tagged with the tenant id:"
		TENANT_JSON=$(run check aws ec2 describe-instances --region "$REGION" \
			--filters "Name=tag-value,Values=$TENANT_ID" "Name=instance-state-name,Values=running" \
			--query 'Reservations[].Instances[]' --output json)
		TENANT_JSON="${TENANT_JSON:-[]}"
		if allowed check; then
			jq -r '.[] | ((.Tags // []) | from_entries) as $t |
				"\(.InstanceId)  asg=\($t["aws:autoscaling:groupName"] // "-")  private=\(.PrivateIpAddress // "-")  public=\(.PublicDnsName // "" | if . == "" then "-" else . end)"' \
				<<<"$TENANT_JSON" | vindent

			if $INFRA && [[ -z "$CB_INSTANCE" && -z "$CB_SSH" ]]; then
				CB_INSTANCE=$(asg_pick "$DS_ASG_PREFIX")
				if [[ -z "$CB_INSTANCE" && -n "$(in_asg "$DS_ASG_PREFIX")" ]]; then
					warn "several ${DS_ASG_PREFIX}* instances; re-run with --cb-instance:"
					hint "re-run with --cb-instance <one of the ids below>"
					in_asg "$DS_ASG_PREFIX" | indent
				fi
			fi
			if [[ -z "$AIGW_INSTANCE" && -z "$AIGW_SSH" ]]; then
				AIGW_INSTANCE=$(asg_pick "$AIGW_ASG_PREFIX")
				[[ -n "$AIGW_INSTANCE" ]] && AIGW_TARGET=$(target_for "$AIGW_INSTANCE" "$AIGW_SSH" local)
			fi
			[[ -n "$CB_INSTANCE" ]] && CB_ASG=$(asg_of "$CB_INSTANCE")
			if [[ -n "$AIGW_INSTANCE" ]]; then
				AIGW_ASG=$(asg_of "$AIGW_INSTANCE")
				AIGW_PUBLIC=$(public_dns_of "$AIGW_INSTANCE")
			fi
		fi
	else
		info "no tenant id (pass --tenant-id or --aigw-instance); falling back to an IP lookup"
	fi

	# The gateway was named on the command line without a tenant id: look up its public DNS.
	if allowed check && [[ -n "$AIGW_INSTANCE" && -z "$AIGW_PUBLIC" ]]; then
		AIGW_PUBLIC=$(run check aws ec2 describe-instances --region "$REGION" --instance-ids "$AIGW_INSTANCE" \
			--query 'Reservations[0].Instances[0].PublicDnsName' --output text)
		[[ "$AIGW_PUBLIC" == None ]] && AIGW_PUBLIC=""
	fi

	if allowed check; then
		if [[ -n "$AIGW_INSTANCE" ]]; then
			pass "ai-gateway: $AIGW_INSTANCE${AIGW_ASG:+ ($AIGW_ASG)}"
		elif $INFRA && [[ -z "$AIGW_SSH" ]]; then
			warn "ai-gateway not identified; log, reachability and gateway disk checks run from here or are skipped"
			hint "pass --tenant-id <org id> (or --aigw-instance <id>) so the gateway can be found"
		fi
	fi
}

# step_locate_cache_node: find the cache node, its public host, and check the gateway
# resolves the connect-string host to it.
step_locate_cache_node() {
	# No tenant id or no capella-ds ASG: find the node by the connect-string host's IP.
	if allowed check && [[ -z "$CB_INSTANCE" && -z "$CB_SSH" && -n "$CB_HOST" ]]; then
		CB_IP=$(python3 -c 'import socket,sys
try: print(socket.gethostbyname(sys.argv[1]))
except OSError: pass' "$CB_HOST")
		if [[ -z "$CB_IP" && "$AIGW_TARGET" != local ]]; then
			CB_IP=$(remote check "$AIGW_TARGET" "getent hosts '$CB_HOST' | awk 'NR==1 {print \$1}'" 2>/dev/null |
				grep -E '^[0-9.]+$' | head -n1)
		fi
		if [[ -n "$CB_IP" ]]; then
			info "$CB_HOST -> $CB_IP; looking up the instance with that IP"
			CB_INSTANCE=$(pick_one "$(aws ec2 describe-instances --region "$REGION" \
				--filters "Name=private-ip-address,Values=$CB_IP" "Name=instance-state-name,Values=running" \
				--query 'Reservations[].Instances[].InstanceId' --output text | tr '\t' '\n')")
		fi
	fi
	allowed check || CB_INSTANCE="${CB_INSTANCE:-<cb-instance-id>}"

	PUBLIC_HOST="$CB_HOST_OVERRIDE"
	priv_ip="" pub_ip=""
	if [[ "$CB_INSTANCE" == i-* || "$MODE" == dry-run ]] && [[ -z "$CB_SSH" ]]; then
		NODE=$(run check aws ec2 describe-instances --region "$REGION" --instance-ids "$CB_INSTANCE" \
			--query 'Reservations[0].Instances[0].[PublicDnsName,PublicIpAddress,PrivateIpAddress,State.Name]' \
			--output text)
		if allowed check && [[ -n "$NODE" ]]; then
			read -r pub_dns pub_ip priv_ip state <<<"$NODE"
			info "instance $CB_INSTANCE: state=$state private=$priv_ip public=$pub_dns $pub_ip"
			[[ "$pub_dns" == None ]] && pub_dns=""
			[[ "$pub_ip" == None ]] && pub_ip=""
			PUBLIC_HOST="${PUBLIC_HOST:-${pub_dns:-$pub_ip}}"
			pass "cache node: $CB_INSTANCE${CB_ASG:+ ($CB_ASG)}, $state"
		fi
	fi
	if allowed check && [[ "$CB_INSTANCE" != i-* && -z "$CB_SSH" ]]; then
		fail "cache node not identified for $CB_HOST (pick one with --cb-instance; --verbose lists the tenant's instances)"
		hint "check --tenant-id and --region, or name the node with --cb-instance <id> (--verbose lists the tenant instances)"
		CB_INSTANCE=""
	fi

	# The gateway must resolve the connect-string host to the cache node.
	if [[ "$AIGW_TARGET" != local ]]; then
		GW_IP=$(remote check "$AIGW_TARGET" "getent hosts '$CB_HOST' | awk 'NR==1 {print \$1}'" |
			grep -E '^[0-9.]+$' | head -n1)
		if ! allowed check; then
			:
		elif [[ -z "$GW_IP" ]]; then
			fail "ai-gateway cannot resolve $CB_HOST"
			hint "on the gateway (Terminals tab, or aws ssm start-session): getent hosts $CB_HOST"
			hint "check the cache cluster's DNS record (Route 53); a replaced cache node may have a new address"
		elif [[ -z "$priv_ip$pub_ip" ]]; then
			pass "ai-gateway resolves $CB_HOST to $GW_IP"
		elif [[ "$GW_IP" == "$priv_ip" || "$GW_IP" == "$pub_ip" ]]; then
			pass "ai-gateway resolves $CB_HOST to the cache node ($GW_IP)"
		else
			fail "ai-gateway resolves $CB_HOST to $GW_IP, but the cache node is ${priv_ip:-?}/${pub_ip:-?}"
			hint "the DNS record for $CB_HOST points at another node: update the record, or the config's couchbaseConnectString"
		fi
	fi
	allowed check || PUBLIC_HOST="${PUBLIC_HOST:-<public-dns>}"

	# This machine connects through the public host; the gateway uses the configured name.
	LOCAL_HOST="${PUBLIC_HOST:-$CB_HOST}"
	if allowed check && [[ -z "$PUBLIC_HOST" ]]; then
		warn "no public DNS/IP for the cache node; using $CB_HOST from this machine (override with --cb-host)"
		hint "admin checks then run from the gateway; or pass --cb-host <host reachable from here>"
	fi
	ADMIN_URL="${ADMIN_URL:-$SCHEME://$LOCAL_HOST:$ADMIN_PORT}"
	info "from this machine: host $LOCAL_HOST, admin $ADMIN_URL"
}

# ---------- 3. gateway log ----------

step_log() {
	step "3. Gateway log: Couchbase connection errors"
	local pattern='timeout|WaitUntilReady|unambiguous|ambiguous|cluster.*not ready|failed to connect|connection refused'
	# Without --log-file, find the log from the running gateway's SERVER_LOG_DIR and cwd.
	local script="f='$LOG_FILE'
if [ ! -f \"\$f\" ] && [ '$LOG_FILE_SET' = false ]; then
  pid=\$(pgrep -o -x ai-gateway || pgrep -o -f 'bin/ai-gateway')
  if [ -n \"\$pid\" ]; then
    d=\$(sudo cat /proc/\$pid/environ 2>/dev/null | tr '\\0' '\\n' | sed -n 's/^SERVER_LOG_DIR=//p')
    d=\${d%/}
    cwd=\$(sudo readlink /proc/\$pid/cwd)
    for c in \"\$d/server-aigateway.log\" \"\$cwd/\$d/server-aigateway.log\" \"\$cwd/server-aigateway.log\"; do
      [ -f \"\$c\" ] && { f=\$c; break; }
    done
  fi
fi
[ -f \"\$f\" ] || { echo \"MISSING \$f\"; exit 0; }
echo \"LOG \$f\"
echo \"MATCHES \$(grep -Eic '$pattern' \"\$f\")\"
grep -Ei '$pattern' \"\$f\" | tail -n 10"
	local out n
	out=$(remote check "$AIGW_TARGET" "$script")
	allowed check || return 0
	if grep -q '^MISSING' <<<"$out"; then
		skip "gateway log not found at $LOG_FILE (use --log-file / --aigw-instance)"
		return 0
	fi
	info "log: $(sed -n 's/^LOG //p' <<<"$out")"
	n=$(sed -n 's/^MATCHES //p' <<<"$out")
	if [[ "${n:-0}" -gt 0 ]]; then
		warn "gateway log: $n Couchbase connection error lines (latest below)"
		hint "connection errors usually mean the cache cluster is down or its disk is full: see the reachability, admin and disk checks"
		grep -Ev '^(MATCHES|LOG) ' <<<"$out" | tail -n "$($VERBOSE && echo 10 || echo 3)" |
			cut -c1-200 | indent
	else
		pass "gateway log: no Couchbase connection errors"
	fi
}

# ---------- 4. reachability ----------

step_reachability() {
	local host from out closed="" p
	if [[ "$AIGW_TARGET" == local ]]; then host="$LOCAL_HOST"; else host="$CB_HOST"; fi
	from=$(target_label "$AIGW_TARGET")
	step "4. Reachability: $from -> cache cluster $host (admin $ADMIN_PORT, data $KV_PORT)"
	out=$(remote check "$AIGW_TARGET" \
		"for p in $ADMIN_PORT $KV_PORT; do nc -z -w 5 '$host' \$p && echo \"OPEN \$p\" || echo \"CLOSED \$p\"; done" \
		2>/dev/null)
	allowed check || return 0
	for p in $ADMIN_PORT $KV_PORT; do grep -q "OPEN $p" <<<"$out" || closed+=" $p"; done
	if [[ -z "$closed" ]]; then
		pass "reachability: ${from%% (*} -> $host, ports $ADMIN_PORT and $KV_PORT open"
	else
		fail "reachability: ${from%% (*} -> $host, port(s)$closed not reachable"
		hint "on the cache node: sudo systemctl status couchbase-server (a full disk stops it: see the disk check)"
		hint "check that the cache node's security group allows ports $ADMIN_PORT and $KV_PORT from the gateway"
	fi
}

# ---------- 5. admin credential + REST ----------

CB_USER="" CB_PASS="" ADMIN_OK=false

fetch_creds() {
	local secret
	secret=$(run check aws secretsmanager get-secret-value --region "$SM_REGION" \
		--secret-id "$CRED_KEY" --query SecretString --output text) || return 1
	allowed check || return 0
	CB_USER="${secret%%:*}" CB_PASS="${secret#*:}"
	[[ -n "$CB_USER" && -n "$CB_PASS" && "$secret" == *:* ]]
}

# cb_get PATH: admin REST GET; the password goes to curl on stdin, never argv
cb_get() {
	printf '   %s[check] $ curl -sSk -u %s:<redacted> %s%s\n' "$DIM" "${CB_USER:-<user>}" \
		"$ADMIN_URL$1" "$RST" | show check
	allowed check || return 0
	if $VERBOSE; then
		printf 'user = "%s:%s"\n' "$CB_USER" "$(curl_escape "$CB_PASS")" |
			curl -sSk --max-time 10 --fail -K - "$ADMIN_URL$1"
	else
		printf 'user = "%s:%s"\n' "$CB_USER" "$(curl_escape "$CB_PASS")" |
			curl -sk --max-time 10 --fail -K - "$ADMIN_URL$1" 2>/dev/null
	fi
}

# report_nodes LINES WHERE: pass/fail on node health from "host status=... membership=..." lines
report_nodes() {
	local nodes="$1" where="$2"
	if grep -q 'status=' <<<"$nodes" && ! grep -v 'status=healthy' <<<"$nodes" | grep -q .; then
		pass "admin REST $where: $(grep -c . <<<"$nodes") node(s), all healthy"
		vindent <<<"$nodes"
	else
		fail "admin REST $where: unhealthy Couchbase node(s)"
		hint "open the Couchbase console (port 18091) and check Servers; on the node: sudo systemctl restart couchbase-server"
		indent <<<"$nodes"
	fi
}

# check_admin_local: admin REST from this machine. A failure is only reported here
# when it cannot be retried from the ai-gateway.
check_admin_local() {
	local pools bucket
	if ! pools=$(cb_get /pools/default); then
		if [[ "$AIGW_TARGET" != local ]]; then
			info "admin REST $ADMIN_URL not reachable from this machine; retrying from the ai-gateway"
		else
			fail "admin REST $ADMIN_URL not responding"
			hint "on the cache node: sudo systemctl status couchbase-server; a full root volume is the usual cause (--fix grows it)"
		fi
		return 1
	fi
	allowed check || return 0
	ADMIN_OK=true
	report_nodes "$(jq -r '.nodes[] | "\(.hostname)  status=\(.status)  membership=\(.clusterMembership)"' \
		<<<"$pools")" "$ADMIN_URL"
	[[ -n "$CACHE_BUCKET" ]] || return 0
	if bucket=$(cb_get "/pools/default/buckets/$CACHE_BUCKET"); then
		pass "cache bucket '$CACHE_BUCKET' exists"
		jq -r '"quota used \(.basicStats.quotaPercentUsed | floor)%, disk used \(.basicStats.diskUsed / 1048576 | floor) MiB, items \(.basicStats.itemCount)"' \
			<<<"$bucket" | vindent
	else
		fail "cache bucket '$CACHE_BUCKET' not found"
		hint "check cacheKeyspace in the config and the bucket list in the Couchbase console; the gateway creates the cache bucket on first use"
	fi
}

# check_admin_on_gateway: the same check run on the ai-gateway against the configured
# host. The gateway's instance role reads the secret there, so the password never
# leaves that host and is not part of the SSM command.
check_admin_on_gateway() {
	local url="https://$CB_HOST:$ADMIN_PORT" out code
	out=$(remote check "$AIGW_TARGET" "s=\$(aws secretsmanager get-secret-value --region '$SM_REGION' --secret-id '$CRED_KEY' --query SecretString --output text 2>&1) || { echo \"SECRET_ERR \$s\" | head -c 300; exit 0; }
u=\${s%%:*}; p=\$(printf '%s' \"\${s#*:}\" | sed 's/\\\\/\\\\\\\\/g; s/\"/\\\\\"/g')
t=\$(mktemp)
for path in /pools/default ${CACHE_BUCKET:+/pools/default/buckets/$CACHE_BUCKET}; do
  code=\$(printf 'user = \"%s:%s\"\\n' \"\$u\" \"\$p\" | curl -sk --max-time 10 -K - -o \"\$t\" -w '%{http_code}' \"$url\$path\")
  echo \"HTTP \$code \$path\"
  [ \"\$path\" = /pools/default ] && grep -o '\"hostname\":\"[^\"]*\"\\|\"status\":\"[^\"]*\"\\|\"clusterMembership\":\"[^\"]*\"' \"\$t\"
done
rm -f \"\$t\"")
	allowed check || return 0
	if grep -q '^SECRET_ERR' <<<"$out"; then
		fail "admin REST: ai-gateway could not read secret '$CRED_KEY': $(sed -n 's/^SECRET_ERR //p' <<<"$out" | head -n1)"
		hint "the gateway's instance role needs secretsmanager:GetSecretValue on $CRED_KEY, and the gateway needs the AWS CLI"
		return 1
	fi
	code=$(awk '$1 == "HTTP" && $3 == "/pools/default" {print $2}' <<<"$out")
	if [[ "$code" != 200 ]]; then
		fail "admin REST $url (from the ai-gateway): HTTP ${code:-none}"
		hint "HTTP 401: the dbCredKey password differs from the cluster; HTTP 000: couchbase-server is down (sudo systemctl status couchbase-server)"
		return 1
	fi
	ADMIN_OK=true
	report_nodes "$(grep '^"' <<<"$out" | tr -d '"' | paste - - - |
		awk -F'\t' '{sub("hostname:", "", $1); sub(":", "=", $2); sub("clusterMembership:", "membership=", $3); print $1 "  " $2 "  " $3}')" \
		"$url (from the ai-gateway)"
	if [[ -n "$CACHE_BUCKET" ]]; then
		code=$(awk '$1 == "HTTP" && $3 ~ /buckets/ {print $2}' <<<"$out")
		if [[ "$code" == 200 ]]; then
			pass "cache bucket '$CACHE_BUCKET' exists"
		else
			fail "cache bucket '$CACHE_BUCKET' not found (HTTP ${code:-none})"
			hint "check cacheKeyspace in the config and the bucket list in the Couchbase console"
		fi
	fi
}

check_admin() {
	check_admin_local || { [[ "$AIGW_TARGET" != local ]] && check_admin_on_gateway; }
}

step_admin() {
	step "5. Couchbase admin access (credential from Secrets Manager: $CRED_KEY)"
	if [[ -z "$CRED_KEY" ]]; then
		skip "admin REST: no dbCredKey in config"
	elif ! fetch_creds; then
		fail "admin REST: could not read secret '$CRED_KEY' in $SM_REGION (expected 'user:password')"
		hint "check with: aws secretsmanager describe-secret --secret-id $CRED_KEY --region $SM_REGION (use --sm-region if it lives in another region)"
	else
		info "credential fetched for user '$CB_USER'"
		check_admin
	fi
}

# ---------- 6. filesystems on the cache node and the ai-gateway ----------

# Real filesystems only: skip memory-backed and read-only image mounts.
DF_EXCLUDE="-x tmpfs -x devtmpfs -x squashfs -x overlay -x efivarfs"
FULL_MOUNTS="" SVC_STATE=""

# check_disk TARGET SERVICE_CHECK: space and inode use of every filesystem on TARGET.
# Sets FULL_MOUNTS (mounts at or over the threshold) and SVC_STATE (from SERVICE_CHECK,
# which prints "SERVICE <name>=<state>").
check_disk() {
	local target="$1" svc="$2" out label tag mount use summary="" bad=false
	FULL_MOUNTS="" SVC_STATE=""
	label=$(target_label "$target")
	label="${label%% (*}"
	out=$(remote check "$target" "df -P $DF_EXCLUDE 2>/dev/null | awk 'NR>1 && !seen[\$1]++ {print \"FS \" \$6 \" \" \$5}'
df -Pi $DF_EXCLUDE 2>/dev/null | awk 'NR>1 && !seen[\$1]++ {print \"INODE \" \$6 \" \" \$5}'
df -h $DF_EXCLUDE 2>/dev/null | awk '!seen[\$1]++'
for m in \$(df -P $DF_EXCLUDE 2>/dev/null | awk 'NR>1 && !seen[\$1]++ {u=\$5; sub(\"%\", \"\", u); if (u + 0 >= $THRESHOLD) print \$6}'); do
  echo \"--- largest dirs on \$m\"
  sudo du -xh \"\$m\" --max-depth=2 2>/dev/null | sort -h | tail -n 6
done
$svc")
	allowed check || return 0
	SVC_STATE=$(sed -n 's/^SERVICE //p' <<<"$out")
	if ! grep -q '^FS ' <<<"$out"; then
		fail "disk: could not read filesystem usage on $label"
		hint "SSM must be able to run commands on the node: check its SSM agent and your ssm:SendCommand permission, or use --cb-ssh / --aigw-ssh"
		return 1
	fi
	while read -r tag mount use; do
		use="${use%\%}"
		[[ "$use" =~ ^[0-9]+$ ]] || continue
		if [[ "$tag" == FS ]]; then
			summary+="$mount ${use}%, "
			if ((use >= THRESHOLD)); then
				FULL_MOUNTS+="$mount "
				fail "disk: $label $mount ${use}% used (threshold ${THRESHOLD}%)"
				hint "grow it: re-run with --fix (asks before each change)"
				hint "or free space: sudo du -xh $mount --max-depth=2 | sort -h | tail (old logs are often under /opt/couchbase/var/lib/couchbase/logs and /var/log)"
				bad=true
			fi
		elif ((use >= THRESHOLD)); then
			fail "disk: $label $mount inodes ${use}% used (threshold ${THRESHOLD}%): too many files"
			hint "find the directories with the most files: sudo find $mount -xdev -type f | cut -d/ -f2-4 | sort | uniq -c | sort -n | tail"
			hint "delete old logs or temp files there; growing an ext4 volume (--fix) also adds inodes"
			bad=true
		fi
	done < <(grep -E '^(FS|INODE) ' <<<"$out")
	if $bad; then
		grep -Ev '^(FS|INODE|SERVICE) ' <<<"$out" | indent
	else
		pass "disk: $label all filesystems below ${THRESHOLD}% (${summary%, })"
		grep -Ev '^(FS|INODE|SERVICE) ' <<<"$out" | vindent
	fi
}

CB_FULL_MOUNTS="" AIGW_FULL_MOUNTS=""

step_disk() {
	step "6. Filesystems and services"
	CB_TARGET=$(target_for "$CB_INSTANCE" "$CB_SSH")
	if [[ -z "$CB_TARGET" ]]; then
		skip "disk: no cache node to check (see step 2)"
	else
		check_disk "$CB_TARGET" "echo SERVICE couchbase-server=\$(systemctl is-active couchbase-server)"
		CB_FULL_MOUNTS="$FULL_MOUNTS"
		if allowed check && [[ -n "$SVC_STATE" ]]; then
			if [[ "$SVC_STATE" == couchbase-server=active ]]; then
				pass "service: couchbase-server active"
			else
				fail "service: couchbase-server ${SVC_STATE#*=}"
				hint "start it: sudo systemctl start couchbase-server; see why it stopped: sudo journalctl -u couchbase-server -n 50"
				hint "if a disk is full, grow it first (--fix)"
			fi
		fi
	fi

	if [[ "$AIGW_TARGET" == local ]]; then
		skip "disk: no ai-gateway instance (pass --tenant-id or --aigw-instance)"
	else
		check_disk "$AIGW_TARGET" "pgrep -x ai-gateway >/dev/null || pgrep -f 'bin/ai-gateway' >/dev/null && echo SERVICE ai-gateway=running || echo SERVICE ai-gateway=stopped"
		AIGW_FULL_MOUNTS="$FULL_MOUNTS"
		if allowed check && [[ -n "$SVC_STATE" ]]; then
			if [[ "$SVC_STATE" == ai-gateway=running ]]; then
				pass "service: ai-gateway process running"
			else
				fail "service: ai-gateway process not running"
				hint "see why it stopped in the gateway log (step 3), then restart the AI Gateway service on the node"
			fi
		fi
	fi
}

# ---------- 7a. gateway endpoint from the Capella control plane ----------

# userdata_field NAME: one field of the gateway instance's EC2 user data (JSON). The user
# data also holds key names and certificates, so only the named field is extracted.
userdata_field() {
	run check aws ec2 describe-instance-attribute --region "$REGION" --instance-id "$AIGW_INSTANCE" \
		--attribute userData --query UserData.Value --output text |
		{ base64 --decode 2>/dev/null || base64 -D; } | jq -r --arg f "$1" '.[$f] // empty' 2>/dev/null
}

# public_cp_url URL: the public API for an internal API URL. The gateway's user data holds
# the internal API (https://<env>.internal-api.<domain>), which has no /sessions route;
# console logins go to the public API (https://api.<env>.<domain>).
public_cp_url() {
	local host="${1#https://}"
	host="${host%%/*}"
	if [[ "$host" =~ ^([^.]+)\.internal-api\.(.+)$ ]]; then
		echo "https://api.${BASH_REMATCH[1]}.${BASH_REMATCH[2]}"
	elif [[ "$host" =~ ^internal-api\.(.+)$ ]]; then
		echo "https://api.${BASH_REMATCH[1]}"
	else
		echo "${1%/}"
	fi
}

# step_cp_endpoint: log in to the control plane and read the gateway endpoint that the
# org's language models in this region are served from. One gateway serves a tenant's
# region, so every model there carries the same network.endpoint (https://<fqdn>, port 443).
step_cp_endpoint() {
	[[ -z "$AIGW_URL" && -n "$CP_USER" ]] || return 0
	$SKIP_INFERENCE && return 0
	step "7a. Gateway endpoint from the Capella control plane"
	local org="${ORG_ID:-$TENANT_ID}" jwt code page last all="[]" endpoints n
	if [[ -z "$CP_URL" && -n "$AIGW_INSTANCE" ]]; then
		info "reading the control plane URL (api) from the gateway's user data"
		CP_URL=$(userdata_field api)
		[[ -n "$CP_URL" ]] && CP_URL=$(public_cp_url "$CP_URL")
		info "control plane API: ${CP_URL:-<not found>}"
	fi
	allowed check || { CP_URL="${CP_URL:-<cp-url>}"; org="${org:-<org-id>}"; }
	if [[ -z "$CP_URL" ]]; then
		fail "control plane: no API URL (pass --cp-url, or --tenant-id to read it from the gateway)"
		hint "pass --cp-url https://api.<env>.<domain>/v2/organizations/<org id> (the Capella console API URL)"
		return 0
	elif [[ -z "$org" ]]; then
		fail "control plane: no organization id (pass --org-id or --tenant-id)"
		hint "pass --org-id <org id> (the UUID after /organizations/ in the console URL)"
		return 0
	fi
	if allowed check && [[ -z "${CP_PASSWORD:-}" ]]; then
		if { : </dev/tty; } 2>/dev/null; then
			printf '   Capella password for %s: ' "$CP_USER" >/dev/tty
			read -rs CP_PASSWORD </dev/tty
			printf '\n' >/dev/tty
		fi
		if [[ -z "${CP_PASSWORD:-}" ]]; then
			fail "control plane: no password (set CP_PASSWORD or run from a terminal)"
			hint "export CP_PASSWORD=... (or set it in the UI .env), or run in a terminal to be prompted"
			return 0
		fi
	fi

	{
		printf '   %s[check] $ curl -sk -X POST %s/sessions -H %s%s\n' "$DIM" "$CP_URL" \
			"'Authorization: Basic <redacted>'" "$RST"
		printf '   %s[check] $ curl -sk %s/v2/organizations/%s/languagemodels?page=1\&perPage=100 -H %s%s\n' \
			"$DIM" "$CP_URL" "$org" "'Authorization: Bearer <session jwt>'" "$RST"
	} | show check
	allowed check || return 0
	RESP_FILE="${RESP_FILE:-$(mktemp)}"
	code=$(curl -sk --max-time 30 -K <(basic_config "$CP_USER:$CP_PASSWORD") -o "$RESP_FILE" \
		-w '%{http_code}' -X POST "$CP_URL/sessions")
	jwt=$(jq -r '.jwt // empty' "$RESP_FILE" 2>/dev/null)
	: >"$RESP_FILE"
	if [[ "$code" == 000 ]]; then
		fail "control plane: cannot reach $CP_URL (check --cp-url)"
		hint "check the URL and that your network or VPN can reach the sandbox"
		return 0
	elif [[ "$code" == 404 ]]; then
		fail "control plane: $CP_URL has no /sessions login (not the public API?); pass --cp-url https://api.<env>.<domain>"
		return 0
	elif [[ -z "$jwt" ]]; then
		fail "control plane: login as $CP_USER failed (HTTP $code)"
		hint "HTTP 401: wrong password, or the user is not in this sandbox; the API needs a password login, not SSO"
		return 0
	fi
	info "logged in to $CP_URL as $CP_USER"

	page=1 last=1
	while ((page <= last && page <= 50)); do
		code=$(curl -sk --max-time 30 -K <(bearer_config "$jwt") -o "$RESP_FILE" -w '%{http_code}' \
			"$CP_URL/v2/organizations/$org/languagemodels?page=$page&perPage=100")
		if [[ "$code" != 200 ]]; then
			fail "control plane: listing language models in org $org returned HTTP $code: $(resp_error)"
			hint "HTTP 403/404: the org id may be wrong; pass --org-id <the UUID after /organizations/ in the console URL>"
			return 0
		fi
		# Items are wrapped as {"data": {...model...}}; accept unwrapped items too.
		all=$(jq -s '.[0] + [.[1].data[]? | (.data // .)]' <(printf '%s' "$all") "$RESP_FILE")
		last=$(jq -r '.cursor.pages.last // 1' "$RESP_FILE")
		[[ "$last" =~ ^[0-9]+$ ]] || last=1
		page=$((page + 1))
	done
	: >"$RESP_FILE"

	jq -r '.[] | "\(.modelConfig.modelName // .name // "-")  region=\(.modelConfig.cloudConfig.region.name // "-")  status=\(.modelConfig.status // "-")  endpoint=\(.network.endpoint // "-")"' \
		<<<"$all" | vindent
	n=$(jq --arg r "$REGION" '[.[] | select((.modelConfig.cloudConfig.region.name // "") == $r)] | length' <<<"$all")
	endpoints=$(jq -r --arg r "$REGION" '.[] | select((.modelConfig.cloudConfig.region.name // "") == $r) |
		.network.endpoint // empty' <<<"$all" | sort -u)
	if [[ -z "$endpoints" ]]; then
		fail "control plane: no language model with an endpoint in $REGION (found: $(jq -r '[.[] | "\(.modelConfig.cloudConfig.region.name // "?")"] | unique | join(", ")' <<<"$all"))"
		hint "deploy a model in $REGION in the Capella console, or pass --region with a region listed above"
		return 0
	fi
	AIGW_URL=$(head -n1 <<<"$endpoints")
	AIGW_URL="${AIGW_URL%/}"
	[[ "$AIGW_URL" == http* ]] || AIGW_URL="https://$AIGW_URL"
	if [[ $(grep -c . <<<"$endpoints") -gt 1 ]]; then
		warn "control plane: several endpoints in $REGION, using $AIGW_URL: $(tr '\n' ' ' <<<"$endpoints")"
	else
		pass "control plane: gateway endpoint $AIGW_URL ($n model(s) in $REGION)"
	fi
}

# ---------- 7. inference: model probes and cache hits ----------

API_KEY="" KEY_ID="" ADMIN_SECRET="" RESP_FILE="" INFERENCE_RAN=false

# call PATH CACHE_TYPE BODY: POST to the gateway with the API key. The response body
# goes to $RESP_FILE; "<http code> <X-Cache> <seconds>" goes to stdout.
call() {
	local hdr out cache code secs
	printf '   %s[check] $ curl -sk -X POST %s -H %s -H %s -d %s%s\n' "$DIM" "$AIGW_URL$1" \
		"'Authorization: Bearer <redacted>'" "'X-cb-cache: $2'" "$(shellquote "$3")" "$RST" | show check
	allowed check || return 0
	hdr=$(mktemp)
	out=$(curl -sk --max-time 120 -K <(bearer_config "$API_KEY") \
		-H 'Content-Type: application/json' -H "X-cb-cache: $2" -D "$hdr" -o "$RESP_FILE" \
		-w '%{http_code} %{time_total}' -X POST --data "$3" "$AIGW_URL$1")
	cache=$(awk -F': *' 'tolower($1) == "x-cache" {gsub("\r", "", $2); v = $2} END {print v}' "$hdr")
	rm -f "$hdr"
	read -r code secs <<<"$out"
	exchange_line "$1" "$2" "$3" "${code:-000}" "${cache:--}" "${secs:-0}"
	printf '%s %s %.1f\n' "${code:-000}" "${cache:--}" "${secs:-0}"
}

# exchange_line PATH CACHE_TYPE BODY CODE X_CACHE SECONDS: one JSON line per model request
# with the question and the answer (or error); shown with --verbose, always in the run log.
exchange_line() {
	jq -nc --arg path "$1" --arg cache "$2" --arg body "$3" --arg code "$4" --arg xc "$5" \
		--arg secs "$6" --rawfile r "$RESP_FILE" '
		($body | fromjson) as $q | ($r | try fromjson catch null) as $j |
		{path: $path, model: $q.model, cache: $cache, request: ($q.messages[-1].content // $q.input),
			code: ($code | tonumber? // 0), xcache: $xc, secs: ($secs | tonumber? // 0),
			usage: ($j.usage? // null),
			response: ((if $j == null then $r
				elif $j.choices then ($j.choices[0].message.content // "")
				elif $j.data then "\($j.data[0].embedding | length)-dimension vector"
				else ($j.error.message // $j.message // $r) end) | tostring | .[0:500])}' 2>/dev/null |
		sed 's/^/   [exchange] /' | show check
}

resp_error() { jq -r '.error.message // .message // empty' "$RESP_FILE" 2>/dev/null | tr '\n' ' ' | sed 's/ *$//' | cut -c1-160; }

# create_api_key: a temporary API key from the gateway admin credential, for this run only.
create_api_key() {
	local body code
	if [[ -z "$ADMIN_KEY_NAME" ]]; then
		fail "api key: adminConfig.adminKey is missing in the config"
		hint "use an existing key instead: --api-key-file FILE (or AIGW_API_KEY)"
		return 1
	fi
	ADMIN_SECRET=$(run check aws secretsmanager get-secret-value --region "$SM_REGION" \
		--secret-id "$ADMIN_KEY_NAME" --query SecretString --output text)
	if allowed check && [[ "$ADMIN_SECRET" != *:* ]]; then
		fail "api key: could not read admin secret '$ADMIN_KEY_NAME' in $SM_REGION (expected 'user:password')"
		hint "check with: aws secretsmanager describe-secret --secret-id $ADMIN_KEY_NAME --region $SM_REGION"
		return 1
	fi
	body=$(jq -nc --arg n "aigw-doctor-$RUN_ID" '{name: $n,
		description: "temporary key created by aigw-doctor", createdByUserID: "aigw-doctor",
		expiryDuration: 3600, accessPolicy: {allowedModels: ["*"], allowedIPs: ["0.0.0.0/0"]}}')
	printf '   %s[check] $ curl -sk -X POST %s/v1/apikeys -H %s -d %s%s\n' "$DIM" "$AIGW_URL" \
		"'Authorization: Basic <redacted>'" "$(shellquote "$body")" "$RST" | show check
	allowed check || return 0
	code=$(curl -sk --max-time 60 -K <(basic_config "$ADMIN_SECRET") -H 'Content-Type: application/json' \
		-o "$RESP_FILE" -w '%{http_code}' -X POST --data "$body" "$AIGW_URL/v1/apikeys")
	if [[ "$code" == 000 ]]; then
		fail "api key: cannot reach $AIGW_URL (pass --cp-user to look up the endpoint, or --aigw-url)"
		hint "the gateway is reached through its load balancer on 443: pass --cp-user to look it up, or --aigw-url https://<endpoint>"
		return 1
	elif [[ "$code" != 200 && "$code" != 201 ]]; then
		fail "api key: create returned HTTP $code${code:+: $(resp_error)}"
		hint "HTTP 401: the admin secret doesn't match the gateway's; HTTP 5xx: check the gateway log"
		return 1
	fi
	API_KEY=$(jq -r '.apiKey // empty' "$RESP_FILE")
	KEY_ID=$(jq -r '.keyId // empty' "$RESP_FILE")
	: >"$RESP_FILE"
	if [[ -z "$API_KEY" ]]; then
		fail "api key: create response has no apiKey"
		hint "check the gateway log for the /v1/apikeys request"
		return 1
	fi
	if [[ -n "$SAVE_KEY_FILE" ]]; then
		(umask 077 && printf '%s\n' "$API_KEY" >"$SAVE_KEY_FILE")
		pass "api key: created $KEY_ID (expires in 1 hour), saved to $SAVE_KEY_FILE"
	else
		pass "api key: created temporary key $KEY_ID (expires in 1 hour, deleted at the end of the run)"
	fi
}

# delete_api_key: revoke the temporary key unless it was saved. Also runs on exit.
delete_api_key() {
	local code id="$KEY_ID"
	[[ -n "$id" && -z "$SAVE_KEY_FILE" ]] || return 0
	KEY_ID=""
	info "deleting temporary API key $id"
	code=$(curl -sk --max-time 30 -K <(basic_config "$ADMIN_SECRET") -o /dev/null -w '%{http_code}' \
		-X DELETE "$AIGW_URL/v1/apikeys/$id")
	if [[ "$code" == 200 || "$code" == 204 ]]; then
		info "temporary API key $id deleted"
	else
		warn "api key: could not delete temporary key $id (HTTP $code); it expires in 1 hour"
		hint "delete it in the Capella console (API keys), or let it expire"
	fi
}

# Topics for the cache questions. Two random topics plus a random reference number make
# each question new to both caches, so a repeat is the only way to get a HIT.
TOPICS=(glaciers volcanoes lighthouses honeybees submarines violins tea coral orchids comets
	bridges chess pottery falcons deserts sourdough telescopes origami canals tides lanterns
	marathons mosaics penguins bamboo typewriters fjords kites saffron sundials compasses
	windmills fossils jazz igloos carousels quartz llamas monsoons scrolls)

# random_question: a question unlike any earlier probe.
random_question() {
	local a b
	a="${TOPICS[RANDOM % ${#TOPICS[@]}]}"
	b="${TOPICS[RANDOM % ${#TOPICS[@]}]}"
	while [[ "$b" == "$a" ]]; do b="${TOPICS[RANDOM % ${#TOPICS[@]}]}"; done
	echo "In one short sentence, what do $a and $b have in common? (ref $RANDOM$RANDOM)"
}

chat_body() { # chat_body MODEL PROMPT
	jq -nc --arg m "$1" --arg p "$2" '{model: $m, max_tokens: 16, temperature: 0, messages: [{role: "user", content: $p}]}'
}

# cache_test MODEL TYPE THRESHOLD: ask a new question twice with X-cb-cache: TYPE. The first
# answer should be a MISS and the repeat a HIT. A first HIT means an older entry matched the
# new question, so try another question (up to three).
cache_test() {
	local model="$1" type="$2" threshold="$3" prompt body code x1 x2 c2 wait attempt
	for attempt in 1 2 3; do
		prompt=$(random_question)
		body=$(chat_body "$model" "$prompt")
		read -r code x1 _ <<<"$(call /v1/chat/completions "$type" "$body")"
		allowed check || return 0
		if [[ "$code" != 200 ]]; then
			fail "inference: $model $type cache: request returned HTTP $code: $(resp_error)"
			hint "see the gateway log for this request; HTTP 401/403 means the key has no access to the model"
			return 0
		elif [[ "$x1" == - ]]; then
			fail "inference: $model $type cache: no X-Cache header, although the config enables it (is the API key's cache role missing?)"
			hint "keys get the cache role when they are created: use --create-api-key for a fresh key after enabling the cache"
			return 0
		elif [[ "$x1" == MISS ]]; then
			break
		fi
		info "$type cache: first request already a HIT (an older entry matched); trying a new question"
	done
	if [[ "$x1" != MISS ]]; then
		warn "inference: $model $type cache: three new questions all hit at once; the cache may match too loosely (threshold $threshold)"
		hint "raise semanticCache.scoreThreshold for this model (now $threshold)"
		return 0
	fi
	# The cache is written after the response, so give it a moment and retry once.
	x2="-" c2=""
	for wait in 2 5; do
		sleep "$wait"
		read -r c2 x2 _ <<<"$(call /v1/chat/completions "$type" "$body")"
		[[ "$x2" == HIT ]] && break
	done
	if [[ "$x2" == HIT ]]; then
		pass "inference: $model $type cache MISS -> HIT"
	else
		fail "inference: $model $type cache: the repeated question was ${x2/-/answered without X-Cache} (HTTP $c2), expected HIT"
		hint "check the cache cluster (reachability, admin and disk checks) and the gateway log for cache write errors"
		hint "semantic cache: the model's vector index must exist (Search/GSI indexes in the Couchbase console)"
		return 0
	fi
	# A reworded question hits only above the score threshold, so this is information only.
	if [[ "$type" == semantic ]]; then
		[[ "$prompt" =~ what\ do\ (.+)\ and\ (.+)\ have\ in\ common\?\ (\(ref\ [0-9]+\)) ]] || return 0
		body=$(chat_body "$model" "Briefly, what is shared by ${BASH_REMATCH[1]} and ${BASH_REMATCH[2]}? ${BASH_REMATCH[3]}")
		read -r _ x2 _ <<<"$(call /v1/chat/completions semantic "$body")"
		info "semantic cache on a reworded question: $x2 (score threshold $threshold)"
	fi
}

# probe_chat MODEL STANDARD SEMANTIC THRESHOLD: a plain chat request, then a cache test for
# each cache type the config enables. STANDARD/SEMANTIC are the type name when enabled,
# "off" when the type is on but cacheConfig.isEnabled is false, or "-" when the type is off.
# Returns 2 when the gateway is unreachable.
probe_chat() {
	local model="$1" std="$2" sem="$3" threshold="$4" code x secs type name
	read -r code x secs <<<"$(call /v1/chat/completions none "$(chat_body "$model" "Reply with only the word OK.")")"
	if allowed check; then
		if [[ "$code" == 000 ]]; then
			fail "inference: cannot reach $AIGW_URL (pass --cp-user to look up the endpoint, or --aigw-url)"
		hint "the gateway is reached through its load balancer on 443; check its target health, or open a shell on the gateway (Terminals tab)"
			hint "the gateway is reached through its load balancer on 443; check its target health, or open a shell on the gateway (Terminals tab)"
			return 2
		elif [[ "$code" == 401 || "$code" == 403 ]]; then
			warn "inference: $model skipped, the API key has no access (HTTP $code: $(resp_error))"
			hint "use --create-api-key (all models), or a key that allows $model"
			return 0
		elif [[ "$code" != 200 ]]; then
			fail "inference: $model chat HTTP $code: $(resp_error)"
			hint "HTTP 5xx: the model backend failed (see the gateway log; for Bedrock check model access and region); HTTP 4xx: check the model name and request"
			return 0
		fi
		INFERENCE_RAN=true
		pass "inference: $model chat OK (${secs}s)"
	fi

	if [[ "$std" == - && "$sem" == - ]]; then
		info "$model: no cache type enabled in the config; cache not tested"
		return 0
	fi
	for name in standard semantic; do
		[[ "$name" == standard ]] && type="$std" || type="$sem"
		case "$type" in
		-) ;;
		off) skip "inference: $model $name cache not tested: cacheConfig.isEnabled is false in the config" ;;
		*) cache_test "$model" "$type" "$threshold" ;;
		esac
	done
}

# gateway_info: the gateway's version, build and per-model status from GET /v1/info.
# Returns 1 when the gateway cannot be reached, so the model probes are skipped.
gateway_info() {
	local code v b c unreachable
	printf '   %s[check] $ curl -sk %s/v1/info -H %s%s\n' "$DIM" "$AIGW_URL" "'Authorization: Bearer <redacted>'" "$RST" |
		show check
	allowed check || return 0
	code=$(curl -sk --max-time 30 -K <(bearer_config "$API_KEY") -o "$RESP_FILE" -w '%{http_code}' "$AIGW_URL/v1/info")
	if [[ "$code" == 000 ]]; then
		fail "inference: cannot reach $AIGW_URL (pass --cp-user to look up the endpoint, or --aigw-url)"
		hint "the gateway is reached through its load balancer on 443; check its target health, or open a shell on the gateway (Terminals tab)"
		return 1
	elif [[ "$code" != 200 ]]; then
		warn "gateway: /v1/info returned HTTP $code: $(resp_error)"
		hint "HTTP 401: the API key is invalid or expired"
		return 0
	fi
	v=$(jq -r '.version // empty' "$RESP_FILE")
	b=$(jq -r '.build_time // empty' "$RESP_FILE")
	c=$(jq -r '.commit_hash // empty' "$RESP_FILE")
	pass "gateway: AI Gateway ${v:-(no version)}${b:+, built $b}${c:+, commit ${c:0:12}}"
	jq -r '.models[]? | "\(.model_name)  status=\(.status)  reachable=\(.server_reachable)\(if .server_message then "  \(.server_message)" else "" end)"' \
		"$RESP_FILE" | vindent
	unreachable=$(jq -r '[.models[]? | select(.server_reachable == false) | .model_name] | unique | join(", ")' "$RESP_FILE")
	if [[ -n "$unreachable" ]]; then
		warn "gateway: reports these models unreachable: $unreachable"
		hint "check those model servers (NIM/vLLM endpoints) or their Bedrock access in this region"
	fi
	return 0
}

# probe_embedding MODEL DIMS: one embeddings request; checks the vector length against
# embeddingDimensions when the config sets it. Returns 2 when the gateway is unreachable.
probe_embedding() {
	local model="$1" dims="$2" body code secs n
	body=$(jq -nc --arg m "$model" '{model: $m, input: "aigw-doctor probe"}')
	read -r code _ secs <<<"$(call /v1/embeddings none "$body")"
	allowed check || return 0
	if [[ "$code" == 000 ]]; then
		fail "inference: cannot reach $AIGW_URL (pass --cp-user to look up the endpoint, or --aigw-url)"
		hint "the gateway is reached through its load balancer on 443; check its target health, or open a shell on the gateway (Terminals tab)"
		return 2
	elif [[ "$code" == 401 || "$code" == 403 ]]; then
		warn "inference: $model skipped, the API key has no access (HTTP $code: $(resp_error))"
		hint "use --create-api-key (all models), or a key that allows $model"
		return 0
	elif [[ "$code" != 200 ]]; then
		fail "inference: $model embeddings HTTP $code: $(resp_error)"
		hint "HTTP 5xx: the embedding backend failed (see the gateway log); HTTP 4xx: check the model name"
		return 0
	fi
	INFERENCE_RAN=true
	n=$(jq '.data[0].embedding | length' "$RESP_FILE" 2>/dev/null)
	if [[ "$dims" != - && -n "$n" && "$n" != "$dims" ]]; then
		warn "inference: $model embeddings returned $n dimensions, config says $dims"
		hint "set embeddingDimensions in the model config to match, or check which embedding model is deployed"
	else
		pass "inference: $model embeddings OK (${n:-?} dimensions, ${secs}s)"
	fi
}

step_inference() {
	step "7. Inference: model probes and cache hits"
	local models model kind std sem threshold dims rc
	# Without a control plane login, try the instance directly (often blocked by its security group).
	[[ -z "$AIGW_URL" && -z "$CP_USER" && -n "$AIGW_PUBLIC" ]] && AIGW_URL="https://$AIGW_PUBLIC:8081"
	allowed check || AIGW_URL="${AIGW_URL:-https://<ai-gateway public dns>:8081}"

	# "modelName kind standard semantic threshold dims" for each model (optionally --models).
	models=$(jq -r --arg f ",$MODELS_FILTER," '.modelConfig.models[]? | . as $m |
		select($f == ",," or ($f | contains("," + ($m.modelName // "") + ",")) or
			($f | contains("," + ($m.id // "") + ","))) |
		[$m.modelName, ($m.kind // "-"),
			(if $m.cacheConfig.standardCache.isEnabled != true then "-"
				elif $m.cacheConfig.isEnabled == true then "standard" else "off" end),
			(if $m.cacheConfig.semanticCache.isEnabled != true then "-"
				elif $m.cacheConfig.isEnabled == true then "semantic" else "off" end),
			($m.cacheConfig.semanticCache.scoreThreshold // "-" | tostring),
			($m.embeddingDimensions // "-" | tostring)] | @tsv' "$CONFIG")

	if $SKIP_INFERENCE; then
		skip "inference: --skip-inference"
		return 0
	elif [[ -z "$models" ]]; then
		skip "inference: no models in the config${MODELS_FILTER:+ matching --models}"
		return 0
	elif [[ -z "$AIGW_URL" && -n "$CP_USER" ]]; then
		skip "inference: no gateway endpoint (see the control plane result above)"
		return 0
	elif [[ -z "$AIGW_URL" ]]; then
		fail "inference: no gateway URL (pass --cp-user to look it up, or --aigw-url)"
		return 0
	fi

	RUN_ID="$(date +%Y%m%d%H%M%S)-$$"
	RESP_FILE=$(mktemp)
	API_KEY="${AIGW_API_KEY:-}"
	[[ -n "$API_KEY_FILE" ]] && API_KEY=$(tr -d '[:space:]' <"$API_KEY_FILE")
	if $CREATE_KEY; then
		create_api_key || return 0
	elif [[ -z "$API_KEY" && "$MODE" != dry-run ]]; then
		skip "inference: pass --api-key-file FILE, set AIGW_API_KEY, or use --create-api-key"
		return 0
	fi

	gateway_info || return 0
	info "gateway $AIGW_URL; each model gets one probe, then one MISS and one HIT per cache type"
	while IFS=$'\t' read -r model kind std sem threshold dims; do
		[[ -n "$model" ]] || continue
		rc=0
		case "$kind" in
		*sparse*) skip "inference: $model ($kind) is not probed" ;;
		*embedding*) probe_embedding "$model" "$dims" || rc=$? ;;
		*text-generation*) probe_chat "$model" "$std" "$sem" "$threshold" || rc=$? ;;
		*) skip "inference: $model ($kind) is not probed" ;;
		esac
		[[ "$rc" == 2 ]] && break
	done <<<"$models"

	delete_api_key
}

# ---------- 8. fix ----------

# volume_of TARGET INSTANCE MOUNT: the EBS volume id behind MOUNT. Uses the NVMe serial
# (vol0123...) when present, else the instance's block device mappings.
volume_of() {
	local target="$1" inst="$2" mount="$3" info disk serial root letter
	info=$(remote check "$target" "mm=\$(findmnt -n -o MAJ:MIN '$mount')
dev=\$(lsblk -rno NAME,MAJ:MIN | awk -v mm=\"\$mm\" '\$2 == mm {print \$1; exit}')
pk=\$(lsblk -no PKNAME \"/dev/\$dev\" 2>/dev/null | head -n1)
disk=\${pk:-\$dev}
echo \"DISK \$disk\"
echo \"SERIAL \$(lsblk -dno SERIAL \"/dev/\$disk\" 2>/dev/null)\"")
	disk=$(sed -n 's/^DISK //p' <<<"$info")
	serial=$(sed -n 's/^SERIAL //p' <<<"$info" | tr -d '[:space:]')
	if [[ "$serial" == vol-* ]]; then
		echo "$serial"
	elif [[ "$serial" == vol* ]]; then
		echo "vol-${serial#vol}"
	elif [[ "$mount" == / ]]; then
		root=$(run check aws ec2 describe-instances --region "$REGION" --instance-ids "$inst" \
			--query 'Reservations[0].Instances[0].RootDeviceName' --output text)
		run check aws ec2 describe-instances --region "$REGION" --instance-ids "$inst" \
			--query "Reservations[0].Instances[0].BlockDeviceMappings[?DeviceName=='${root:-<root-dev>}'].Ebs.VolumeId" \
			--output text
	elif [[ "$disk" =~ ^x?[sv]d([a-z]+)$ ]]; then
		# Xen device names: /dev/xvdf on the host is /dev/sdf or /dev/xvdf in the mapping.
		letter="${BASH_REMATCH[1]}"
		run check aws ec2 describe-instances --region "$REGION" --instance-ids "$inst" \
			--query 'Reservations[0].Instances[0].BlockDeviceMappings[].[DeviceName,Ebs.VolumeId]' --output text |
			awk -v l="$letter" '$1 ~ ("(sd|xvd)" l "[0-9]*$") {print $2; exit}'
	fi
}

# fix_volume TARGET INSTANCE MOUNT: grow the EBS volume behind MOUNT, then its partition
# and filesystem.
fix_volume() {
	local target="$1" inst="$2" mount="$3" label vol cur size asg state resized=false grow out
	label=$(target_label "$target")
	label="${label%% (*}"
	step "8. Fix: grow $mount on $label"
	if [[ "$inst" != i-* && "$MODE" != dry-run ]]; then
		skip "fix: $mount on $label needs the EC2 instance id to resize its EBS volume"
		return 0
	fi
	[[ "$MODE" == check ]] && note "fix for $mount on $label (run with --fix):"
	vol=$(volume_of "$target" "$inst" "$mount")
	vol="${vol:-<vol-id>}"
	if allowed check && [[ "$vol" != vol-* ]]; then
		fail "fix: could not find the EBS volume behind $mount on $label"
		hint "list the node's volumes: aws ec2 describe-instances --instance-ids $inst --query 'Reservations[0].Instances[0].BlockDeviceMappings'"
		return 0
	fi
	cur=$(run check aws ec2 describe-volumes --region "$REGION" --volume-ids "$vol" \
		--query 'Volumes[0].Size' --output text)
	size="${NEW_SIZE:-$([[ "$cur" =~ ^[0-9]+$ ]] && echo $((cur * 2)) || echo '<2x-current>')}"
	allowed check && note "$mount is on $vol (${cur} GiB); target ${size} GiB"

	# A replacement instance boots from the ASG's launch template, not this volume.
	asg=$(run check aws autoscaling describe-auto-scaling-instances --region "$REGION" \
		--instance-ids "$inst" --query 'AutoScalingInstances[0].AutoScalingGroupName' --output text)
	if allowed check && [[ -n "$asg" && "$asg" != None ]]; then
		warn "fix: $label is in ASG '$asg'; raise this volume's size in its launch template too, or a replacement instance comes back at the old size"
	fi

	if allowed fix && [[ "$cur" =~ ^[0-9]+$ && "$size" =~ ^[0-9]+$ ]] && ((size <= cur)); then
		fail "fix: --size $size must be larger than the current $cur GiB of $vol"
		hint "pass a larger --size (GiB), or leave it out to double the volume"
		return 0
	fi
	if $SNAPSHOT && { [[ "$MODE" != fix ]] || confirm "snapshot $vol first?"; }; then
		run fix aws ec2 create-snapshot --region "$REGION" --volume-id "$vol" \
			--description "aigw-doctor before resize" --query SnapshotId --output text
	fi
	if [[ "$MODE" != fix ]] || confirm "resize EBS volume $vol ($mount on $label) from ${cur} to ${size} GiB?"; then
		run fix aws ec2 modify-volume --region "$REGION" --volume-id "$vol" --size "$size" >/dev/null
		printf '   %s[fix] $ aws ec2 describe-volumes-modifications --volume-ids %s  (poll until optimizing)%s\n' \
			"$DIM" "$vol" "$RST"
		if allowed fix; then
			state=""
			for _ in $(seq 1 60); do
				state=$(aws ec2 describe-volumes-modifications --region "$REGION" --volume-ids "$vol" \
					--query 'VolumesModifications[0].ModificationState' --output text)
				[[ "$state" == optimizing || "$state" == completed ]] && break
				sleep 5
			done
			if [[ "$state" == optimizing || "$state" == completed ]]; then
				resized=true
			else
				fail "fix: modification of $vol did not progress (state=$state); AWS allows one change per volume every 6 hours"
				hint "wait and retry later, or snapshot the volume and create a larger one"
			fi
		fi
	fi

	# findmnt may report an alias such as /dev/root, so resolve the device by MAJ:MIN.
	grow="set -e
m='$mount'
mm=\$(findmnt -n -o MAJ:MIN \"\$m\")
dev=\$(lsblk -rno NAME,MAJ:MIN | awk -v mm=\"\$mm\" '\$2 == mm {print \$1; exit}')
case \"\$dev\" in dm-*) echo \"\$m is on LVM (\$dev); extend it with pvresize/lvextend\"; exit 1 ;; esac
pk=\$(lsblk -no PKNAME \"/dev/\$dev\" | head -n1)
fstype=\$(findmnt -n -o FSTYPE \"\$m\")
if [ -n \"\$pk\" ]; then
  sudo growpart \"/dev/\$pk\" \"\$(cat /sys/class/block/\$dev/partition)\" || echo 'growpart: no change'
fi
case \"\$fstype\" in
  ext*) sudo resize2fs \"/dev/\$dev\" ;;
  xfs) sudo xfs_growfs -d \"\$m\" ;;
  *) echo \"unsupported filesystem: \$fstype\"; exit 1 ;;
esac
df -h \"\$m\""
	if [[ "$MODE" != fix ]] || { $resized && confirm "grow the partition and filesystem of $mount on $label?"; }; then
		out=$(remote fix "$target" "$grow") && allowed fix && pass "fix: $mount on $label grown to ${size} GiB"
		allowed fix && vindent <<<"$out"
	fi
}

step_fix() {
	local m any=false restart='sudo systemctl restart couchbase-server && sleep 20 && systemctl is-active couchbase-server'
	if [[ "$MODE" == dry-run ]]; then
		fix_volume "$(target_for "$CB_INSTANCE" "$CB_SSH")" "$CB_INSTANCE" /
		note "only if the admin API is still down after the resize:"
		remote fix "$(target_for "$CB_INSTANCE" "$CB_SSH")" "$restart" >/dev/null
		return 0
	fi
	for m in $CB_FULL_MOUNTS; do any=true; fix_volume "$CB_TARGET" "$CB_INSTANCE" "$m"; done
	for m in $AIGW_FULL_MOUNTS; do any=true; fix_volume "$AIGW_TARGET" "$AIGW_INSTANCE" "$m"; done

	if [[ "$ADMIN_OK" != true && -n "${CB_TARGET:-}" ]]; then
		step "8. Fix: restart couchbase-server"
		if [[ "$MODE" == check ]]; then
			note "if the cache cluster admin API stays down (run with --fix):"
			remote fix "$CB_TARGET" "$restart" >/dev/null
		elif [[ -n "$CB_USER" ]] && ! check_admin &&
			confirm "admin API still down; restart couchbase-server on $(target_label "$CB_TARGET")?"; then
			remote fix "$CB_TARGET" "$restart" | vindent
			check_admin
		fi
	elif ! $any; then
		info "nothing to fix"
	fi
}

# ---------- main ----------

# start_logger: everything printed from here on goes through one logger process, so the
# run log keeps the console's order. It writes every line to the run log without colors
# and prints the untagged lines to the console. It ignores Ctrl-C, so the exit trap can
# still report (and delete a temporary API key) after an interrupt.
RUN_LOG="" LOGGER_PID=""
start_logger() {
	local fifo name
	exec 3>&1 4>&2
	if $RUN_LOG_ENABLED; then
		name=$(basename "$CONFIG")
		name="${name%.json}"
		name="${name%.config}"
		RUN_LOG="$RUN_LOG_DIR/aigw-doctor-$name-$MODE$($INFRA || echo -inference)-$(date +%Y%m%d-%H%M%S)-$$.log"
		if ! { mkdir -p "$RUN_LOG_DIR" && (umask 077 && : >"$RUN_LOG"); } 2>/dev/null; then
			echo "warning: cannot write $RUN_LOG; not saving a run log" >&2
			RUN_LOG=""
		fi
	fi
	fifo=$(mktemp -u "${TMPDIR:-/tmp}/aigw-doctor.XXXXXX")
	mkfifo -m 600 "$fifo" || return 0
	(trap '' INT; exec awk -v logf="$RUN_LOG" -v mark="$MARK" '{
		line = $0
		tagged = substr(line, 1, 1) == mark
		if (tagged) line = substr(line, 2)
		if (logf != "") { clean = line; gsub(/\033\[[0-9;]*m/, "", clean); print clean >> logf; fflush(logf) }
		if (!tagged) { print line; fflush() }
	}') <"$fifo" >&3 &
	LOGGER_PID=$!
	exec >"$fifo" 2>&1
	rm -f "$fifo"
	if [[ -n "$RUN_LOG" ]]; then
		{
			echo "# aigw-doctor run log"
			echo "# started: $(date -u +%Y-%m-%dT%H:%M:%SZ) by $(id -un)@$(hostname)"
			echo "# command: $0 $(shellquote ${ORIG_ARGS[@]+"${ORIG_ARGS[@]}"})"
		} | sed "s/^/$MARK/"
	fi
}

stop_logger() {
	[[ -n "$LOGGER_PID" ]] || return 0
	exec 1>&3 2>&4
	wait "$LOGGER_PID" 2>/dev/null
	LOGGER_PID=""
}

cleanup() {
	local rc=$?
	delete_api_key
	[[ -z "$RESP_FILE" ]] || rm -f "$RESP_FILE"
	[[ -z "$RUN_LOG" ]] || printf '%s# finished: %s, exit %s%s\n' "$MARK" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
		"$rc" "$( ((rc > 128)) && echo ' (interrupted)')"
	stop_logger
}
trap cleanup EXIT
trap 'exit 130' INT TERM
start_logger

printf '%sAI Gateway Doctor%s  mode=%s%s region=%s\n' "$B" "$RST" "$MODE" \
	"$($INFRA || echo ' (inference only)')" "$REGION"
if [[ "$MODE" == dry-run ]]; then
	note "Dry run: nothing is executed. Use --check to run the checks, --fix to repair."
elif ! $VERBOSE; then
	note "${DIM}--verbose shows commands and details${RST}"
fi

# AWS is needed for the infrastructure checks, for --create-api-key (admin secret), and
# to find the gateway URL from the tenant's instances.
# The tenant lookup finds the gateway instance, whose public DNS (or, with --cp-user, whose
# user data) leads to the gateway URL.
NEED_LOOKUP=false
[[ -z "$AIGW_URL" && (-n "$TENANT_ID" || -n "$AIGW_INSTANCE") ]] && NEED_LOOKUP=true
if $INFRA || $CREATE_KEY || $NEED_LOOKUP; then
	step_aws
fi
step_config
if $INFRA; then
	step_locate_tenant
	step_locate_cache_node
	step_log
	step_reachability
	step_admin
	step_disk
elif $NEED_LOOKUP; then
	step_locate_tenant
fi
step_cp_endpoint
step_inference
$INFRA && step_fix

# ---------- summary ----------

if [[ "$MODE" == dry-run ]]; then
	step "Summary"
	note "dry run only. Next: $0 -c $CONFIG --check"
	[[ -z "$RUN_LOG" ]] || note "Full log: $RUN_LOG"
	exit 0
fi

step "Summary"
for line in ${SUMMARY[@]+"${SUMMARY[@]}"}; do info "$line"; done
printf '\n%sResult:%s %s%d passed%s, %s%d warnings%s, %s%d failed%s\n' "$B" "$RST" \
	"$GRN" "$N_PASS" "$RST" "$YEL" "$N_WARN" "$RST" "$RED" "$N_FAIL" "$RST"
if [[ "$FAILED" != 0 ]]; then
	$VERBOSE || note "The full log has the commands and details behind each failure."
elif ! $INFRA; then
	note "The models answer, and repeated requests hit the cache where it is enabled."
elif $INFERENCE_RAN; then
	note "Cache cluster and gateway are healthy, the models answer, and repeated requests hit the cache."
else
	note "Cache cluster and gateway look healthy. Add --api-key-file or --create-api-key to test the models and cache hits."
fi
[[ -z "$RUN_LOG" ]] || note "Full log: $RUN_LOG"
exit "$FAILED"
