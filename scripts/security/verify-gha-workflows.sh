#!/bin/sh

# Policy for .github/workflows and action.yml. Runs as the "Workflows" job of
# the Security workflow. See the base-repository README, "Workflow policy".
#
#   - runs-on labels that float with a "-latest" component
#     (ubuntu-latest, ubuntu-latest-8-cores, macos-latest-xlarge)
#   - a workflow file with no top-level permissions block
#   - permissions: write-all or read-all
#   - uses: that is not a full 40-character commit SHA
#     (local ./ actions are allowed; docker:// must use @sha256:)
#   - actions/checkout without persist-credentials: false, unless the job
#     comment documents why:
#     workflow-lint: allow-persist-credentials: <why>
#   - untrusted template expressions inside run: and script: values.
#     Allowed there: github.run_id, github.run_number, github.run_attempt,
#     github.sha, github.event.pull_request.number,
#     github.event.pull_request.head.sha, github.event.issue.number,
#     github.event.workflow_run.id, github.event.workflow_run.head_sha,
#     and github.event.check_suite.head_sha.
#     github.head_ref, inputs, and needs.<job>.outputs stay untrusted, and
#     so does a whole context such as toJSON(github) or toJSON(needs).
#
# POSIX sh + awk.

set -eu

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

ROOT=$(CDPATH='' cd -- "$(dirname "$0")/../.." && pwd)
cd "$ROOT"

FILE_LIST=$(mktemp)
OUT_LIST=$(mktemp)
trap 'rm -f "$FILE_LIST" "$OUT_LIST"' EXIT INT TERM

: >"$FILE_LIST"
if [ -d .github/workflows ]; then
  find .github/workflows -maxdepth 1 -type f \( -name '*.yml' -o -name '*.yaml' \) >>"$FILE_LIST"
fi
# Composite and JS actions.
find . \
  \( -path './.git' -o -path './.yarn' -o -path './node_modules' -o -path './vendor' \) -prune \
  -o -type f \( -name 'action.yml' -o -name 'action.yaml' \) -print >>"$FILE_LIST"

scan_file() {
  awk '
function trim(s) {
  sub(/^[[:space:]]+/, "", s)
  sub(/[[:space:]]+$/, "", s)
  return s
}

function indent_of(line) {
  if (match(line, /[^[:space:]]/)) return RSTART - 1
  return length(line)
}

function strip_yaml_comment(line,   i, n, c, q, out, prev) {
  n = length(line)
  q = ""
  prev = ""
  out = ""
  for (i = 1; i <= n; i++) {
    c = substr(line, i, 1)
    if (q == "" && c == "#" && (prev == "" || prev == " " || prev == "\t")) break
    if (c == "'"'"'" || c == "\"") {
      if (q == "") q = c
      else if (q == c) q = ""
    }
    out = out c
    prev = c
  }
  return trim(out)
}

function unquote(s) {
  s = trim(s)
  if (s ~ /^".*"$/ || s ~ /^'"'"'.*'"'"'$/) return substr(s, 2, length(s) - 2)
  return s
}

function record(line, msg) {
  printf "%s:%d: %s\n", FILENAME, line, msg
}

function has_floating_word(s,   work, w) {
  work = s
  while (match(work, /[A-Za-z0-9._-]+/)) {
    w = substr(work, RSTART, RLENGTH)
    if (w ~ /(^|-)latest($|-)/) return 1
    work = substr(work, RSTART + RLENGTH)
  }
  return 0
}

function note_matrix_refs(s,   work, k) {
  work = s
  while (match(work, /matrix[[:space:]]*\.[[:space:]]*[A-Za-z_][A-Za-z0-9_-]*/)) {
    k = substr(work, RSTART, RLENGTH)
    sub(/^matrix[[:space:]]*\.[[:space:]]*/, "", k)
    matrix_refs[k] = 1
    work = substr(work, RSTART + RLENGTH)
  }
}

function check_runs_token(s, line,   token) {
  token = unquote(trim(s))
  if (token == "") return
  note_matrix_refs(token)
  if (has_floating_word(token)) record(line, "floating runner label")
}

function add_matrix_val(key, val, line) {
  if (key == "" || key == "include" || key == "exclude") return
  matrix_vals[key] = matrix_vals[key] "\n" val
  if (has_floating_word(val) && matrix_bad_line[key] == "") matrix_bad_line[key] = line
}

function is_block_scalar(s) {
  if (s == "") return 0
  return s ~ /^[|>][0-9+-]*$/
}

function line_allows(line,   i, n, c, q, comment, rest, marker, m) {
  n = length(line)
  q = ""
  for (i = 1; i <= n; i++) {
    c = substr(line, i, 1)
    if (q == "") {
      if (c == "'"'"'" || c == "\"") q = c
      else if (c == "#" && (i == 1 || substr(line, i - 1, 1) ~ /[[:space:]]/)) {
        comment = substr(line, i + 1)
        marker = "workflow-lint: allow-persist-credentials:"
        m = index(comment, marker)
        if (m > 0) {
          rest = trim(substr(comment, m + length(marker)))
          if (rest != "") job_allow = 1
        }
        return
      }
    } else if (c == q) q = ""
  }
}

function path_forbidden(path) {
  if (path == "github.head_ref" || index(path, "github.head_ref.") == 1) return 1
  if (path == "inputs" || index(path, "inputs.") == 1) return 1
  if (path ~ /^needs\.[A-Za-z_][A-Za-z0-9_-]*\.outputs(\.|$)/) return 1
  if (path == "github.event" || index(path, "github.event.") == 1) {
    if (path == "github.event.pull_request.head.sha") return 0
    if (path == "github.event.pull_request.number") return 0
    if (path == "github.event.issue.number") return 0
    if (path == "github.event.workflow_run.id") return 0
    if (path == "github.event.workflow_run.head_sha") return 0
    if (path == "github.event.check_suite.head_sha") return 0
    return 1
  }
  return 0
}

function check_expr(body, line,   t, u, q, path) {
  t = body
  gsub(/[[:space:]]*\.[[:space:]]*/, ".", t)
  if (t ~ /(^|[^A-Za-z0-9_])head_ref([^A-Za-z0-9_]|$)/) {
    record(line, "untrusted expression inline in run or script")
    return
  }
  if (t ~ /(^|[^A-Za-z0-9_])inputs([^A-Za-z0-9_]|$)/) {
    record(line, "untrusted expression inline in run or script")
    return
  }
  if (t ~ /needs\.[A-Za-z_][A-Za-z0-9_-]*\.outputs([^A-Za-z0-9_]|$)/) {
    record(line, "untrusted expression inline in run or script")
    return
  }
  if (t ~ /needs[[:space:]]*\[/ || t ~ /github[[:space:]]*\[/) {
    record(line, "untrusted expression inline in run or script")
    return
  }
  u = t
  q = sprintf("%c", 39)
  gsub(q "[^" q "]*" q, q q, u)
  if (u ~ /(^|[^A-Za-z0-9_.])(github|needs)([^A-Za-z0-9_.[]|$)/) {
    record(line, "untrusted expression inline in run or script")
    return
  }
  while (match(t, /[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)+/)) {
    path = substr(t, RSTART, RLENGTH)
    t = substr(t, RSTART + RLENGTH)
    if (path_forbidden(path)) {
      record(line, "untrusted expression inline in run or script")
      return
    }
  }
}

function check_code(text, line,   s, body, e) {
  s = text
  while (match(s, /\$\{[[:space:]]*\{/)) {
    s = substr(s, RSTART + RLENGTH)
    e = index(s, "}}")
    if (e == 0) {
      body = s
      s = ""
    } else {
      body = substr(s, 1, e - 1)
      s = substr(s, e + 2)
    }
    check_expr(body, line)
    if (e == 0) break
  }
}

function flush_code() {
  if (in_code) {
    check_code(code_buf, code_start)
    in_code = 0
    code_buf = ""
  }
}

function clear_matrix(   k) {
  for (k in matrix_refs) delete matrix_refs[k]
  for (k in matrix_vals) delete matrix_vals[k]
  for (k in matrix_bad_line) delete matrix_bad_line[k]
  matrix_key = ""
  in_matrix = 0
  in_strategy = 0
  in_runs_on = 0
}

function flush_step() {
  if (!step_open) return
  if (step_is_checkout && step_persist != "false") {
    checkout_bad = 1
    if (checkout_bad_line == 0) checkout_bad_line = step_line
  }
  step_open = 0
  step_is_checkout = 0
  step_persist = ""
}

function start_step(line) {
  step_open = 1
  step_line = line
  step_is_checkout = 0
  step_persist = ""
}

function flush_job(   k) {
  flush_step()
  if (!in_job) return
  for (k in matrix_refs) {
    if (matrix_bad_line[k] != "") {
      record(matrix_bad_line[k] + 0, "floating runner label")
    }
  }
  if (checkout_bad && !job_allow) {
    record(checkout_bad_line + 0, "actions/checkout must set persist-credentials: false or be allowlisted on the job")
  }
  in_job = 0
  job_allow = 0
  checkout_bad = 0
  checkout_bad_line = 0
  in_steps = 0
  clear_matrix()
}

function begin_job(line) {
  flush_job()
  in_job = 1
  job_line = line
  job_allow = 0
  checkout_bad = 0
  checkout_bad_line = 0
  clear_matrix()
  in_steps = 0
  step_open = 0
}

function reset_file() {
  in_code = 0
  code_buf = ""
  code_mode = ""
  in_jobs = 0
  jobs_indent = -1
  job_indent = -1
  in_job = 0
  single_scope = 0
  in_steps = 0
  step_open = 0
  saw_top_permissions = 0
  clear_matrix()
  if (FILENAME ~ /(^|\/)action\.ya?ml$/ && FILENAME !~ /(^|\/)\.github\/workflows\//) {
    in_job = 1
    job_line = 1
    single_scope = 1
  }
}

END {
  flush_code()
  flush_job()
  if (!single_scope && !saw_top_permissions) {
    record(1, "workflow is missing a top-level permissions block")
  }
}

{
  raw = $0
  sub(/\r$/, "", raw)
  lineno = FNR
  if (FNR == 1) reset_file()

  if (in_code) {
    if (raw ~ /^[[:space:]]*$/) {
      code_buf = code_buf "\n"
      next
    }
    ind = indent_of(raw)
    if (ind > code_indent) {
      t = trim(raw)
      if (code_mode == "pending" && (t ~ /^[A-Za-z0-9_-]+:([[:space:]]|$)/ || t ~ /^-[[:space:]]*[A-Za-z0-9_-]+:([[:space:]]|$)/)) {
        flush_code()
      } else {
        if (code_mode == "pending") code_mode = "inline"
        code_buf = code_buf "\n" raw
        next
      }
    } else {
      flush_code()
    }
  }

  if (raw ~ /^[[:space:]]*$/) next
  line_allows(raw)
  t = trim(raw)
  if (t ~ /^#/) next

  ind = indent_of(raw)
  content = strip_yaml_comment(t)
  is_item = 0
  if (content ~ /^-/) {
    is_item = 1
    content = trim(substr(content, 2))
  }

  if (in_runs_on && ind <= runs_on_indent) in_runs_on = 0
  if (in_matrix && ind <= matrix_indent) {
    in_matrix = 0
    matrix_key = ""
  }
  if (in_strategy && ind <= strategy_indent) {
    in_strategy = 0
    in_matrix = 0
    matrix_key = ""
  }
  if (in_steps && ind <= steps_indent && !is_item) {
    flush_step()
    in_steps = 0
  }

  if (is_item && in_steps && !in_matrix && ind > steps_indent) {
    flush_step()
    start_step(lineno)
  }

  if (content == "" || index(content, ":") == 0) {
    if (is_item && in_runs_on && ind > runs_on_indent) check_runs_token(content, lineno)
    else if (is_item && in_matrix && matrix_key != "" && ind > matrix_indent) add_matrix_val(matrix_key, content, lineno)
    next
  }

  key = content
  sub(/:.*/, "", key)
  key = unquote(trim(key))
  rest = content
  sub(/^[^:]*:/, "", rest)
  rest = trim(rest)

  if (key == "jobs") {
    flush_job()
    in_jobs = 1
    jobs_indent = ind
    job_indent = -1
    next
  }

  if (in_jobs && ind <= jobs_indent) {
    flush_job()
    in_jobs = 0
  }

  if (in_jobs && ind > jobs_indent && !is_item && (job_indent < 0 || ind == job_indent)) {
    if (job_indent < 0) job_indent = ind
    if (ind == job_indent) begin_job(lineno)
  }

  if (key == "permissions") {
    perm = tolower(unquote(rest))
    if (perm == "write-all" || perm == "read-all") {
      record(lineno, "permissions " perm " is not allowed")
    }
    if (ind == 0) saw_top_permissions = 1
  }

  if (key == "runs-on") {
    in_runs_on = 1
    runs_on_indent = ind
    if (rest != "" && !is_block_scalar(rest)) check_runs_token(rest, lineno)
  } else if (in_runs_on && ind > runs_on_indent && rest != "" && !is_block_scalar(rest)) {
    check_runs_token(rest, lineno)
  }

  if (in_job && key == "strategy") {
    in_strategy = 1
    strategy_indent = ind
  }
  if (in_strategy && key == "matrix" && ind > strategy_indent) {
    in_matrix = 1
    matrix_indent = ind
    matrix_key = ""
  }
  if (in_matrix && ind > matrix_indent && key != "matrix") {
    matrix_key = key
    if (rest != "" && !is_block_scalar(rest)) add_matrix_val(key, rest, lineno)
  }

  if (key == "steps") {
    flush_step()
    in_steps = 1
    steps_indent = ind
  }

  if (key == "uses") {
    v = unquote(rest)
    if (v ~ /^actions\/checkout(@|\/|$)/ || v == "actions/checkout") {
      step_is_checkout = 1
      if (!step_open) start_step(lineno)
    }
    if (v ~ /^\.\//) {
      # local action
    } else if (v ~ /^docker:\/\//) {
      if (v !~ /^docker:\/\/[^[:space:]]+@sha256:[0-9a-fA-F]{64}$/) {
        record(lineno, "docker action must be pinned with @sha256")
      }
    } else if (v !~ /@[0-9a-fA-F]{40}$/) {
      record(lineno, "action must be pinned to a full 40-character commit SHA")
    }
  }

  if (key == "persist-credentials" && step_open) {
    if (tolower(unquote(rest)) == "false") step_persist = "false"
    else step_persist = "other"
  }

  if (key == "with" && rest ~ /^\{/ && step_open) {
    if (rest ~ /persist-credentials:[[:space:]]*['"'"'"'\"]?false['"'"'"'\"]?/) step_persist = "false"
    else if (rest ~ /persist-credentials:/) step_persist = "other"
  }

  if (key == "run" || key == "script") {
    in_code = 1
    code_indent = ind
    if (t ~ /^-/) code_indent = ind + 2
    code_start = lineno
    code_buf = ""
    if (rest == "") code_mode = "pending"
    else if (is_block_scalar(rest)) code_mode = "block"
    else {
      code_mode = "inline"
      code_buf = rest
    }
  }
}
' "$1"
}

: >"$OUT_LIST"
while IFS= read -r file || [ -n "$file" ]; do
  [ -n "$file" ] || continue
  [ -f "$file" ] || continue
  scan_file "$file" >>"$OUT_LIST"
done <"$FILE_LIST"

matches=$(cat "$OUT_LIST" 2>/dev/null || true)
cleaned=$(printf '%s' "$matches" | tr -d '[:space:]')
if [ -n "$cleaned" ]; then
  printf '%b\n' "${RED}Error: workflow lint failed${NC}"
  echo
  printf '%s\n' "$matches"
  echo
  printf '%b\n' "${YELLOW}Pin runners and actions, declare permissions, and keep untrusted expressions out of run. See the base-repository README, Workflow policy.${NC}"
  exit 1
fi

printf '%b\n' "${GREEN}Workflow lint passed.${NC}"
exit 0
