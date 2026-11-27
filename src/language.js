'use strict';

const locale = process.env.SOUNDMCP_LANG?.trim().toLowerCase();
const isEnglish = /^en(?:[-_][a-z0-9]+)*$/.test(locale ?? '');

function ui(french, english) {
  return isEnglish ? english : french;
}

module.exports = { ui };
