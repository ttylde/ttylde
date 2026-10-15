# Ttylde shell integration, zsh.
#
# Tells Ttylde what only the shell knows, with escape sequences it prints
# and Ttylde reads without showing them:
#
#   OSC 133 ; A                     a prompt starts
#   OSC 133 ; B                     the prompt ends: what follows is typed
#   OSC 133 ; C ; cmdline_url=… ; nonce=…
#                                   a command starts, with its text
#   OSC 133 ; D ; <exit status>     the command ended
#   OSC 7 ; file://<host><folder>   the folder the shell is in
#
# The nonce is a secret Ttylde hands the shell when it starts it: Ttylde
# believes the text of a command only from a sequence that carries it, since
# any program can print OSC 133. The variable is taken out of the
# environment, so the commands the shell runs do not see it.
#
# Loaded by the .zshenv next to it; it can also be sourced by hand from
# .zshrc, and loads only once.

[[ -o interactive ]] || return 0
(( ${+_ttylde_loaded} )) && return 0
typeset -g _ttylde_loaded=1

typeset -g _ttylde_nonce=${TTYLDE_NONCE-}
unset TTYLDE_NONCE

# A command started by preexec and not yet ended.
typeset -gi _ttylde_running=0

# Percent-encodes `$1` into REPLY, byte by byte: what is left is letters,
# digits and `_./~-`. Keeps `;`, spaces and newlines out of the sequence.
_ttylde_urlencode() {
  emulate -L zsh
  setopt extended_glob
  local LC_ALL=C
  REPLY=${1//(#m)[^_A-Za-z0-9\/._~-]/%${(l:2::0:)$(( [##16] #MATCH & 255 ))}}
}

# First of the precmd hooks, to read the exit status before any other hook
# changes it.
_ttylde_precmd_status() {
  local -i status_=$?
  emulate -L zsh
  if (( _ttylde_running )); then
    _ttylde_running=0
    builtin printf '\e]133;D;%d\a' $status_
  fi
  _ttylde_urlencode $PWD
  builtin printf '\e]7;file://%s%s\a' $HOST $REPLY
}

# Last of the precmd hooks: nothing else prints between it and the prompt.
_ttylde_precmd_prompt() {
  emulate -L zsh
  builtin printf '\e]133;A\a'
  # Themes rebuild PS1: the end mark goes back on at every prompt.
  if [[ -o prompt_percent && $PS1 != *$'\e]133;B'* ]]; then
    PS1+=$'%{\e]133;B\a%}'
  fi
  # A hook added after ours would print after the prompt mark.
  if [[ ${precmd_functions[-1]} != _ttylde_precmd_prompt ]]; then
    precmd_functions=(${precmd_functions:#_ttylde_precmd_prompt} _ttylde_precmd_prompt)
  fi
}

# `$1` is the command line as typed, before aliases and expansion.
_ttylde_preexec() {
  emulate -L zsh
  _ttylde_running=1
  _ttylde_urlencode $1
  if [[ -n $_ttylde_nonce ]]; then
    builtin printf '\e]133;C;cmdline_url=%s;nonce=%s\a' $REPLY $_ttylde_nonce
  else
    builtin printf '\e]133;C;cmdline_url=%s\a' $REPLY
  fi
}

# Installed at the first prompt, after .zshrc: the hooks a theme or a
# plugin manager adds there would otherwise run around ours.
_ttylde_install() {
  emulate -L zsh
  precmd_functions=(
    _ttylde_precmd_status
    ${precmd_functions:#(_ttylde_install|_ttylde_precmd_status|_ttylde_precmd_prompt)}
    _ttylde_precmd_prompt
  )
  preexec_functions=(${preexec_functions:#_ttylde_preexec} _ttylde_preexec)
  unfunction _ttylde_install
  # This prompt too: the hooks after this one still run, ours do not.
  _ttylde_precmd_status
  _ttylde_precmd_prompt
}

typeset -ga precmd_functions preexec_functions
precmd_functions+=(_ttylde_install)
