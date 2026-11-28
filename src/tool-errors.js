'use strict';

const { ui } = require('./language');

class SoundMcpError extends Error {
  constructor(code, message, hint) {
    super(message);
    this.code = code;
    this.hint = hint;
  }
}

function errorDetails(error) {
  if (error instanceof SoundMcpError) {
    const { code, message, hint } = error;
    return { code, message, ...(hint && { hint }) };
  }
  const message = error instanceof Error ? error.message : String(error);
  if (error?.code === 'ENOENT') {
    return { code: 'FILE_NOT_FOUND', message, hint: ui(
      'Vérifie le chemin ou retrouve la sortie active avec manage_outputs.',
      'Check the path or find the active output with manage_outputs.',
    ) };
  }
  if (['EACCES', 'EPERM', 'EROFS'].includes(error?.code)) {
    return { code: 'FILE_ACCESS_DENIED', message, hint: ui(
      'Vérifie les droits ou choisis un dossier de sortie accessible.',
      'Check permissions or choose a writable output directory.',
    ) };
  }
  return { code: 'TOOL_ERROR', message };
}

module.exports = { SoundMcpError, errorDetails };
