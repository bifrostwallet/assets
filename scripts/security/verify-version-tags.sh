#!/bin/sh

# Fail when a GitHub Actions workflow under .github/workflows:
#   - filters push tags with anything other than [0-9]+.[0-9]+.[0-9]+,
#   - lets a push or create trigger run for every tag,
#   - hides a tag filter inside a flow mapping the line scanner cannot read, or
#   - inlines a ref/tag expression inside a run: block.
#
# Tag values belong in step env (see docs/versioning-and-releases.md).
# Line-oriented POSIX sh + grep -E. Standard workflow layout only.
# Unrecognized tags values, `{` flow mappings under on:, and unfiltered
# push/create triggers fail closed.
# VERSION_TAG_SCAN_DIR overrides the workflow directory (fixture runner).

set -eu

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

ROOT=$(CDPATH='' cd -- "$(dirname "$0")/../.." && pwd)
cd "$ROOT"

STRICT='[0-9]+.[0-9]+.[0-9]+'
# Case-insensitive. `.*` crosses nested `}` so format('{0}', github.ref_name)
# still matches. head.ref / base.ref are the pull_request forms of head_ref /
# base_ref. github.ref also matches github.ref_name.
RUN_EXPR='\$\{[[:space:]]*\{.*(github\.((event\.)?ref)|head[._]ref|base[._]ref|release\.(tag_)?name|inputs\.tag|tag_name)'

SCAN_DIR=${VERSION_TAG_SCAN_DIR:-.github/workflows}

FILE_LIST=$(mktemp)
OUT_LIST=$(mktemp)
trap 'rm -f "$FILE_LIST" "$OUT_LIST"' EXIT INT TERM

if [ -d "$SCAN_DIR" ]; then
  find "$SCAN_DIR" -type f \( -name '*.yml' -o -name '*.yaml' \) >"$FILE_LIST"
else
  : >"$FILE_LIST"
fi

trim() {
  _t=$1
  _t=${_t#"${_t%%[![:space:]]*}"}
  _t=${_t%"${_t##*[![:space:]]}"}
  printf '%s' "$_t"
}

# Drop an unquoted YAML comment (` #...` or a leading `#`). A `#` inside
# quotes is part of the value. `tags: ['[0-9]+.[0-9]+.[0-9]+'] # note` stays
# the strict filter; `on: push # all refs` stays an unfiltered push.
strip_yaml_comment() {
  _s=$1
  _out=
  _q=
  _prev=
  while [ -n "$_s" ]; do
    _c=${_s%"${_s#?}"}
    _s=${_s#?}
    if [ -z "$_q" ] && [ "$_c" = '#' ]; then
      case "$_prev" in
        '' | ' ' | '	')
          break
          ;;
      esac
    fi
    case "$_c" in
      "'" | '"')
        if [ -z "$_q" ]; then
          _q=$_c
        elif [ "$_q" = "$_c" ]; then
          _q=
        fi
        ;;
    esac
    _out=${_out}${_c}
    _prev=$_c
  done
  trim "$_out"
}

unquote() {
  _u=$(trim "$1")
  case "$_u" in
    \"*\")
      _u=${_u#\"}
      _u=${_u%\"}
      ;;
    \'*\')
      _u=${_u#\'}
      _u=${_u%\'}
      ;;
  esac
  printf '%s' "$_u"
}

record() {
  printf '%s:%s: %s\n' "$current" "$1" "$2" >>"$OUT_LIST"
}

check_pattern() {
  _pat=$(strip_yaml_comment "$1")
  _pat=$(unquote "$_pat")
  if [ -z "$_pat" ]; then
    record "$lineno" "empty tag filter entry"
    return
  fi
  if [ "$_pat" != "$STRICT" ]; then
    record "$lineno" "tag filter '${_pat}' is not ${STRICT}"
  fi
}

check_run_text() {
  if printf '%s\n' "$1" | grep -Eiq "$RUN_EXPR"; then
    record "$lineno" "ref or tag expression inline in run: (bind it to env)"
  fi
}

note_unfiltered_event() {
  case "$1" in
    push)
      record "$2" "push trigger is not limited to branches or the strict version-tag filter"
      ;;
    create)
      record "$2" "create trigger runs for every new tag"
      ;;
  esac
}

# $1 is a flow sequence such as [push, pull_request].
flag_event_list() {
  _list=$1
  case "$_list" in
    \[*\])
      _list=${_list#\[}
      _list=${_list%\]}
      ;;
    *)
      return
      ;;
  esac
  while [ -n "$_list" ]; do
    case "$_list" in
      *,*)
        _ev=${_list%%,*}
        _list=${_list#*,}
        ;;
      *)
        _ev=$_list
        _list=
        ;;
    esac
    _ev=$(unquote "$_ev")
    note_unfiltered_event "$_ev" "$lineno"
  done
}

close_push() {
  if [ "$in_push" -eq 1 ]; then
    if [ "$push_filtered" -eq 0 ]; then
      note_unfiltered_event push "$push_at"
    fi
    in_push=0
  fi
}

split_flow() {
  _inner=$1
  case "$_inner" in
    \[*\])
      _inner=${_inner#\[}
      _inner=${_inner%\]}
      ;;
    *)
      record "$lineno" "unrecognized tag filter (expected a list or flow sequence)"
      return
      ;;
  esac
  _saw=0
  while [ -n "$_inner" ]; do
    case "$_inner" in
      *,*)
        _item=${_inner%%,*}
        _inner=${_inner#*,}
        ;;
      *)
        _item=$_inner
        _inner=
        ;;
    esac
    _item=$(trim "$_item")
    if [ -z "$_item" ]; then
      continue
    fi
    _saw=1
    check_pattern "$_item"
  done
  if [ "$_saw" -eq 0 ]; then
    record "$lineno" "tag filter is empty"
  fi
}

is_block_scalar() {
  _ind=$(trim "$1")
  case "$_ind" in
    '' | '|' | '|-' | '|+' | '>' | '>-' | '>+' | '|'[0-9] | '|'[0-9][0-9] | '>'[0-9] | '>'[0-9][0-9])
      return 0
      ;;
    '|-'[0-9] | '|+'[0-9] | '>-'[0-9] | '>+'[0-9])
      return 0
      ;;
  esac
  return 1
}

scan_file() {
  current=$1
  in_run=0
  run_indent=0
  in_on=0
  on_indent=0
  in_push=0
  push_indent=0
  push_filtered=0
  push_at=0
  in_tags=0
  tags_count=0
  tags_at=0
  lineno=0

  while IFS= read -r line || [ -n "$line" ]; do
    lineno=$((lineno + 1))
    trimmed=$(trim "$line")
    if [ -z "$trimmed" ]; then
      continue
    fi

    if [ "$in_run" -eq 1 ]; then
      _lead=${line%%[![:space:]]*}
      if [ "${#_lead}" -gt "$run_indent" ]; then
        check_run_text "$trimmed"
        continue
      fi
      in_run=0
    fi

    case "$trimmed" in
      \#*) continue ;;
    esac

    if [ "$in_tags" -eq 1 ]; then
      case "$trimmed" in
        -*)
          _item=${trimmed#-}
          _item=$(trim "$_item")
          tags_count=$((tags_count + 1))
          check_pattern "$_item"
          continue
          ;;
        *)
          if [ "$tags_count" -eq 0 ]; then
            record "$tags_at" "tag filter is empty"
          fi
          in_tags=0
          ;;
      esac
    fi

    content=$trimmed
    case "$content" in
      -*)
        content=${content#-}
        content=$(trim "$content")
        ;;
    esac

    case "$content" in
      *:*) ;;
      *) continue ;;
    esac

    key=${content%%:*}
    key=$(unquote "$key")
    rest=$(strip_yaml_comment "$(trim "${content#*:}")")

    _lead=${line%%[![:space:]]*}
    _indent=${#_lead}

    if [ "$in_push" -eq 1 ] && [ "$_indent" -le "$push_indent" ]; then
      close_push
    fi

    if [ "$in_on" -eq 1 ] && [ "$_indent" -le "$on_indent" ] && [ "$key" != "on" ]; then
      in_on=0
    fi

    if [ "$key" = "on" ]; then
      in_on=1
      on_indent=$_indent
    fi

    if [ "$in_on" -eq 1 ]; then
      case "$line" in
        *'{'*)
          record "$lineno" "unrecognized flow mapping under on:"
          ;;
      esac
    fi

    if [ "$key" = "run" ]; then
      if is_block_scalar "$rest"; then
        in_run=1
        # `- run:` is indented at the dash. Sibling keys (`env`) sit at dash+2.
        run_indent=$_indent
        case "$trimmed" in
          -*) run_indent=$((_indent + 2)) ;;
        esac
      else
        check_run_text "$rest"
      fi
    fi

    if [ "$key" = "on" ] && [ -n "$rest" ]; then
      case "$rest" in
        \[*\]) flag_event_list "$rest" ;;
        *) note_unfiltered_event "$(unquote "$rest")" "$lineno" ;;
      esac
    fi

    if [ "$in_on" -eq 1 ] && [ "$key" = "create" ]; then
      note_unfiltered_event create "$lineno"
    fi

    if [ "$in_on" -eq 1 ] && [ "$key" = "push" ] && [ -z "$rest" ]; then
      in_push=1
      push_indent=$_indent
      push_filtered=0
      push_at=$lineno
    fi

    if [ "$in_push" -eq 1 ]; then
      case "$key" in
        branches | branches-ignore | tags | tags-ignore) push_filtered=1 ;;
      esac
    fi

    if [ "$in_on" -eq 1 ] && [ "$key" = "tags-ignore" ]; then
      record "$lineno" "tags-ignore is not an x.y.z allowlist"
    fi

    if [ "$in_on" -eq 1 ] && [ "$key" = "tags" ]; then
      case "$rest" in
        '')
          in_tags=1
          tags_count=0
          tags_at=$lineno
          ;;
        \[*\])
          split_flow "$rest"
          ;;
        *)
          check_pattern "$rest"
          ;;
      esac
    fi
  done <"$current"

  close_push

  if [ "$in_tags" -eq 1 ] && [ "$tags_count" -eq 0 ]; then
    record "$tags_at" "tag filter is empty"
  fi
}

: >"$OUT_LIST"
while IFS= read -r file || [ -n "$file" ]; do
  [ -n "$file" ] || continue
  scan_file "$file"
done <"$FILE_LIST"

matches=$(cat "$OUT_LIST" 2>/dev/null || true)
cleaned=$(printf '%s' "$matches" | tr -d '[:space:]')
if [ -n "$cleaned" ]; then
  printf '%b\n' "${RED}Error: version-tag policy failed in ${SCAN_DIR}${NC}"
  echo
  printf '%s\n' "$matches"
  echo
  printf '%b\n' "${YELLOW}Tag filters must be [0-9]+.[0-9]+.[0-9]+. Bind ref and tag expressions to step env; do not inline them in run.${NC}"
  exit 1
fi

printf '%b\n' "${GREEN}No loose version-tag filters or inline ref expressions in .github/workflows${NC}"
exit 0
