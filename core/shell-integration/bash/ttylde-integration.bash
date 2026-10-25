# Ttylde shell integration, bash.
#
# Tells Ttylde what only the shell knows, with escape sequences it prints
# and Ttylde reads without showing them (see the zsh script for the list).
#
# The nonce is a secret Ttylde hands the shell when it starts it: Ttylde
# believes the text of a command only from a sequence that carries it, since
# any program can print OSC 133. The variable is taken out of the
# environment, so the commands the shell runs do not see it.
#
# How it gets here. Ttylde starts its shells as login shells, and a login
# bash ignores `--rcfile`: bash comes without `-l` and with
# `--rcfile <this file>` instead, and TTYLDE_BASH_INJECT says what it would
# have read without Ttylde. "login": `/etc/profile`, then the first of
# `~/.bash_profile`, `~/.bash_login`, `~/.profile` that can be read, and
# `~/.bash_logout` on the way out. "rc": `~/.bashrc`. None of the user's
# files is changed. What cannot be replayed: `shopt login_shell` is off,
# and `$0` is `bash`, not `-bash`.
#
# It can also be sourced by hand from .bashrc, and loads only once. Then it
# reads nothing else, and a PROMPT_COMMAND set after it replaces its hooks.
#
# Works with bash 3.2, the one of macOS: no PS0 there. The start of a
# command comes from a DEBUG trap, which bash runs before every simple
# command: only the first one after the prompt counts, as bash-preexec does.

[[ $- == *i* ]] || return 0
[[ -n ${_ttylde_loaded-} ]] && return 0
_ttylde_loaded=1

_ttylde_nonce=${TTYLDE_NONCE-}
unset TTYLDE_NONCE
_ttylde_inject=${TTYLDE_BASH_INJECT-}
unset TTYLDE_BASH_INJECT

# The user's files, at the top level and not in a function: what they set
# is global, as without Ttylde.
case $_ttylde_inject in
  login)
    [[ -r /etc/profile ]] && . /etc/profile
    for _ttylde_file in ~/.bash_profile ~/.bash_login ~/.profile; do
      if [[ -r $_ttylde_file ]]; then
        . "$_ttylde_file"
        break
      fi
    done
    unset _ttylde_file
    ;;
  rc)
    [[ -r ~/.bashrc ]] && . ~/.bashrc
    ;;
esac

# A DEBUG trap the files set waits until ours is there, and runs after it:
# the commands of this script are none of its business.
_ttylde_user_debug=$(builtin trap -p DEBUG)
builtin trap - DEBUG

# A command started and not yet ended.
_ttylde_running=
# Set by the last hook before the prompt: the next DEBUG trap is the
# start of what was typed.
_ttylde_armed=
# The number of the last entry of the history at the prompt: a command
# that does not change it was not added.
_ttylde_histno=
# PROMPT_COMMAND came with the trap still armed: no command was seen.
_ttylde_unseen=

# Percent-encodes `$1` into REPLY, byte by byte: what is left is letters,
# digits and `_./~-`. Keeps `;`, spaces and newlines out of the sequence.
_ttylde_urlencode() {
  local LC_ALL=C s=$1 out= c n hex i
  for ((i = 0; i < ${#s}; i++)); do
    c=${s:i:1}
    case $c in
      [a-zA-Z0-9_./~-]) out+=$c ;;
      *)
        # bash 3.2 reads a byte past 127 as a negative number.
        builtin printf -v n '%d' "'$c"
        builtin printf -v hex '%%%02X' $(((n + 256) % 256))
        out+=$hex
        ;;
    esac
  done
  REPLY=$out
}

# The last entry of the history: its number in _ttylde_entry_no, its text
# in REPLY. Both empty when the history is off or empty.
_ttylde_last_entry() {
  local line
  line=$(HISTTIMEFORMAT= builtin history 1)
  _ttylde_entry_no=
  REPLY=
  if [[ $line =~ ^\ *([0-9]+)\*?\ \ (.*)$ ]]; then
    _ttylde_entry_no=${BASH_REMATCH[1]}
    REPLY=${BASH_REMATCH[2]}
  fi
}

# First of PROMPT_COMMAND, to read the exit status before anything else
# changes it; it gives it back, for the user's hooks and the prompt.
_ttylde_precmd_status() {
  local status_=$?
  # A line that ran but was never seen: all of it in a subshell, `(cd x &&
  # make)`, where the trap does not run. The history has it: its start
  # comes now, late, so that it counts and has its status.
  if [[ -n $_ttylde_unseen ]]; then
    _ttylde_unseen=
    _ttylde_last_entry
    if [[ -n $_ttylde_entry_no && $_ttylde_entry_no != "$_ttylde_histno" ]]; then
      _ttylde_start "$REPLY"
      _ttylde_running=1
    fi
  fi
  if [[ -n $_ttylde_running ]]; then
    _ttylde_running=
    builtin printf '\e]133;D;%d\a' "$status_"
  fi
  _ttylde_urlencode "$PWD"
  builtin printf '\e]7;file://%s%s\a' "$HOSTNAME" "$REPLY"
  return "$status_"
}

# Last of PROMPT_COMMAND: nothing else prints between it and the prompt.
_ttylde_precmd_prompt() {
  local status_=$?
  builtin printf '\e]133;A\a'
  # Themes rebuild PS1: the end mark goes back on at every prompt.
  if [[ $PS1 != *'\e]133;B'* ]]; then
    PS1+='\[\e]133;B\a\]'
  fi
  _ttylde_last_entry
  _ttylde_histno=$_ttylde_entry_no
  _ttylde_armed=1
  return "$status_"
}

# Sets `$?` to `$1`, without a subshell.
_ttylde_status() {
  return "$1"
}

# Before every simple command. `$1` is `$_`, which the trap passes and,
# being the last word of the call, puts back.
_ttylde_debug() {
  local status_=$?
  # PROMPT_COMMAND starts: nothing was typed, or what was is over. Its
  # commands are not typed ones.
  if [[ $BASH_COMMAND == _ttylde_precmd_status ]]; then
    _ttylde_unseen=$_ttylde_armed
    _ttylde_armed=
  fi
  # Only the first command after the prompt, typed, at the top level: not
  # one of a completion or of a key binding.
  if [[ -n $_ttylde_armed && ${#FUNCNAME[@]} -eq 1 && -z ${COMP_LINE-} &&
    -z ${READLINE_POINT-} ]]; then
    _ttylde_armed=
    _ttylde_running=1
    _ttylde_command
  fi
  if [[ -n $_ttylde_user_debug ]]; then
    _ttylde_status "$status_"
    builtin eval -- "$_ttylde_user_debug"
  fi
}

# The start of the command, with its text from the history. A command bash
# did not add has none: `ignorespace`, HISTIGNORE, the history off. Unless
# it is the last one again, which `ignoredups` leaves out: then its first
# simple command is where the entry starts.
_ttylde_command() {
  _ttylde_last_entry
  if [[ -z $_ttylde_entry_no ]] ||
    [[ $_ttylde_entry_no == "$_ttylde_histno" && $REPLY != "$BASH_COMMAND"* ]]; then
    REPLY=
  fi
  _ttylde_start "$REPLY"
}

# The start mark, with the text `$1` if there is one.
_ttylde_start() {
  if [[ -z $1 ]]; then
    builtin printf '\e]133;C\a'
    return
  fi
  _ttylde_urlencode "$1"
  if [[ -n $_ttylde_nonce ]]; then
    builtin printf '\e]133;C;cmdline_url=%s;nonce=%s\a' "$REPLY" "$_ttylde_nonce"
  else
    builtin printf '\e]133;C;cmdline_url=%s\a' "$REPLY"
  fi
}

# Reads the action of a trap into REPLY, from `$1`, what `trap -p` printed
# for it: a `trap` command to run again, which here only stores its action.
# `trap -p` runs at the top level: in a function, bash 3.2 does not show
# the DEBUG trap.
_ttylde_action() {
  local action=
  trap() { action=$2; }
  builtin eval -- "$1"
  unset -f trap
  REPLY=$action
}

_ttylde_action "$_ttylde_user_debug"
_ttylde_user_debug=$REPLY

# A login shell reads ~/.bash_logout when it exits, before the EXIT trap.
if [[ $_ttylde_inject == login ]]; then
  _ttylde_action "$(builtin trap -p EXIT)"
  _ttylde_user_exit=$REPLY
  _ttylde_exit() {
    [[ -r ~/.bash_logout ]] && . ~/.bash_logout
    [[ -n $_ttylde_user_exit ]] && builtin eval -- "$_ttylde_user_exit"
  }
  builtin trap _ttylde_exit EXIT
fi

# Around the user's PROMPT_COMMAND, an array from bash 5.1 on.
if [[ $(builtin declare -p PROMPT_COMMAND 2>/dev/null) == "declare -a"* ]]; then
  PROMPT_COMMAND=(_ttylde_precmd_status "${PROMPT_COMMAND[@]}" _ttylde_precmd_prompt)
else
  PROMPT_COMMAND="_ttylde_precmd_status${PROMPT_COMMAND:+
$PROMPT_COMMAND}
_ttylde_precmd_prompt"
fi
unset _ttylde_inject

# Last: the user's DEBUG trap runs after ours, with the status it would
# have seen, and neither runs on the lines above.
builtin trap '_ttylde_debug "$_"' DEBUG
