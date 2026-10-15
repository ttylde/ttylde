# Ttylde shell integration, zsh: the first file zsh reads.
#
# Ttylde pointed ZDOTDIR here so that zsh would read this file. It puts
# ZDOTDIR back to what it was, so that zsh reads the rest of the user's
# files (.zprofile, .zshrc, .zlogin) from where they are, loads the user's
# .zshenv, then the integration. None of the user's files is changed.

# Where the integration is, before ZDOTDIR changes.
'builtin' 'typeset' -g _ttylde_dir=${${(%):-%x}:A:h}

if [[ -n ${TTYLDE_ZDOTDIR+set} ]]; then
  'builtin' 'export' ZDOTDIR=$TTYLDE_ZDOTDIR
else
  'builtin' 'unset' ZDOTDIR
fi
'builtin' 'unset' TTYLDE_ZDOTDIR

{
  'builtin' 'typeset' _ttylde_file=${ZDOTDIR-$HOME}/.zshenv
  [[ ! -r $_ttylde_file ]] || 'builtin' 'source' -- $_ttylde_file
} always {
  # Only a shell someone types into has prompts and commands to mark.
  if [[ -o interactive ]]; then
    'builtin' 'source' -- $_ttylde_dir/ttylde-integration.zsh
  fi
  'builtin' 'unset' _ttylde_file _ttylde_dir
}
