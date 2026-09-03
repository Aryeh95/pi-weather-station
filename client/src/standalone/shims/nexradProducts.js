// Static stand-in for `nexrad-level-3-data/src/products/index.js`.
//
// The library builds its product table by reading its own directory at load
// time (`fs.readdirSync(__dirname)` then `require` per entry). A bundle has no
// directory to read, so the app build aliases that module to this one, which
// requires the same set explicitly and exports the identical shape.
//
// The list is written out rather than globbed so it is reviewable, and
// `test/standaloneProducts.test.js` asserts it still matches the installed
// package — a library upgrade that adds a product fails that test instead of
// silently shipping an app that cannot decode it.
//
// Exporting the SAME `products` object the library would is load-bearing:
// `server/radarRadialCtrl.js` registers the product-153 (N0B) and 154 (N0G)
// shims by assigning into it at runtime.

/* eslint-disable global-require */
const productsRaw = [
  require("nexrad-level-3-data/src/products/56"),
  require("nexrad-level-3-data/src/products/58"),
  require("nexrad-level-3-data/src/products/59"),
  require("nexrad-level-3-data/src/products/61"),
  require("nexrad-level-3-data/src/products/62"),
  require("nexrad-level-3-data/src/products/78"),
  require("nexrad-level-3-data/src/products/80"),
  require("nexrad-level-3-data/src/products/94"),
  require("nexrad-level-3-data/src/products/141"),
  require("nexrad-level-3-data/src/products/165"),
  require("nexrad-level-3-data/src/products/170"),
  require("nexrad-level-3-data/src/products/172"),
  require("nexrad-level-3-data/src/products/177"),
];
/* eslint-enable global-require */

const products = {};
productsRaw.forEach((product) => {
  if (products[product.code]) throw new Error(`Duplicate product code ${product.code}`);
  products[product.code] = product;
});

const productAbbreviations = productsRaw.map((product) => product.abbreviation).flat();

module.exports = { products, productAbbreviations };
