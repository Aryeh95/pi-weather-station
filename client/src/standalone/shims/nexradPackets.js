// Static stand-in for `nexrad-level-3-data/src/packets/index.js`, for the same
// reason as ./nexradProducts.js — the library enumerates its own directory,
// which a bundle cannot do. Same exported shape, same generic parser, and the
// same coverage test guards the list.

/* eslint-disable global-require */
const packetsRaw = [
  require("nexrad-level-3-data/src/packets/1"),
  require("nexrad-level-3-data/src/packets/2"),
  require("nexrad-level-3-data/src/packets/6"),
  require("nexrad-level-3-data/src/packets/8"),
  require("nexrad-level-3-data/src/packets/10"),
  require("nexrad-level-3-data/src/packets/13"),
  require("nexrad-level-3-data/src/packets/14"),
  require("nexrad-level-3-data/src/packets/15"),
  require("nexrad-level-3-data/src/packets/16"),
  require("nexrad-level-3-data/src/packets/17"),
  require("nexrad-level-3-data/src/packets/18"),
  require("nexrad-level-3-data/src/packets/19"),
  require("nexrad-level-3-data/src/packets/32"),
  require("nexrad-level-3-data/src/packets/a"),
  require("nexrad-level-3-data/src/packets/af1f"),
  require("nexrad-level-3-data/src/packets/c"),
  require("nexrad-level-3-data/src/packets/f"),
];
/* eslint-enable global-require */

const packets = {};
packetsRaw.forEach((packet) => {
  if (packets[packet.code]) throw new Error(`Duplicate packet code ${packet.code}`);
  packets[packet.code] = packet;
});

/**
 * Generic packet parser — verbatim from the library's own index.
 *
 * @param {object} raf random-access file reader positioned at the packet
 * @param {object} productDescription decoded product description block
 * @returns {object} parsed packet
 */
const parser = (raf, productDescription) => {
  const packetCode = raf.readUShort();
  raf.skip(-2);
  const packetCodeHex = packetCode.toString(16).padStart(4, "0");
  const packet = packets[packetCode];
  if (!packet) throw new Error(`Unsupported packet code 0x${packetCodeHex}`);
  return packet.parser(raf, productDescription);
};

module.exports = { packets, parser };
