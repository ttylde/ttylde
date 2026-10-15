# Ttylde shell integration, fish.
#
# fish loads this file by itself: Ttylde put the folder above `fish/` first
# in XDG_DATA_DIRS, and fish reads `vendor_conf.d` in every data folder.
# None of the user's files is changed.
#
# Tells Ttylde what only the shell knows, with escape sequences it prints
# and Ttylde reads without showing them (see the zsh script for the list).
# fish 4 marks prompts and commands with OSC 133 by itself, without the
# text of the command: there, the script adds only that.
#
# The nonce is a secret Ttylde hands the shell when it starts it: Ttylde
# believes the text of a command only from a sequence that carries it, since
# any program can print OSC 133. The variable is taken out of the
# environment, so the commands the shell runs do not see it.

status is-interactive; or exit 0
set -q _ttylde_loaded; and exit 0
set -g _ttylde_loaded 1

set -g _ttylde_nonce $TTYLDE_NONCE
set -e TTYLDE_NONCE

# Our folder out of XDG_DATA_DIRS again, so that what the shell runs does
# not inherit it.
if set -q TTYLDE_FISH_DATA_DIR
    set -l kept
    for dir in (string split : -- "$XDG_DATA_DIRS")
        test "$dir" = "$TTYLDE_FISH_DATA_DIR"; or set -a kept $dir
    end
    if set -q kept[1]
        set -gx XDG_DATA_DIRS (string join : -- $kept)
    else
        set -e XDG_DATA_DIRS
    end
    set -e TTYLDE_FISH_DATA_DIR
end

set -l major (string split -- . $version)[1]
if test "$major" -ge 4 2>/dev/null
    set -g _ttylde_marks_by_fish 1
end

function _ttylde_prompt --on-event fish_prompt
    printf '\e]7;file://%s%s\a' $hostname (string escape --style=url -- $PWD)
    set -q _ttylde_marks_by_fish; or printf '\e]133;A\a'
end

# `$argv[1]` is the command line as typed.
function _ttylde_preexec --on-event fish_preexec
    set -l line (string escape --style=url -- $argv[1])
    if test -n "$_ttylde_nonce"
        printf '\e]133;C;cmdline_url=%s;nonce=%s\a' $line $_ttylde_nonce
    else
        printf '\e]133;C;cmdline_url=%s\a' $line
    end
end

function _ttylde_postexec --on-event fish_postexec
    set -l status_ $status
    set -q _ttylde_marks_by_fish; or printf '\e]133;D;%d\a' $status_
end
