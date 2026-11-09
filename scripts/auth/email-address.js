'use strict';

function validEmailAddress(value) {
  if (typeof value !== 'string' || value.length > 254) return false;
  const at = value.indexOf('@');
  if (at < 1 || at !== value.lastIndexOf('@') || at > 64) return false;
  const domain = value.slice(at + 1);
  const dot = domain.lastIndexOf('.');
  if (dot < 1 || dot === domain.length - 1) return false;
  for (const character of value) {
    if (character.trim() === '') return false;
  }
  return true;
}

function senderEmailAddress(value) {
  const sender = String(value).trim();
  const addressStart = sender.endsWith('>') ? sender.lastIndexOf('<') : -1;
  return addressStart >= 0 ? sender.slice(addressStart + 1, -1).trim() : sender;
}

module.exports = { senderEmailAddress, validEmailAddress };
