// Webpack config for the ANDROID APP bundle.
//
// Differs from the kiosk build (`webpack.config.js`) in exactly three ways:
//
//   1. `__STANDALONE__` is true, which makes `src/index.js` install the in-app
//      API (see src/standalone/) and switches the basemap to the keyless
//      tiles — there is no server to proxy them.
//   2. The `server/` controllers are pulled into the bundle and the handful of
//      Node built-ins they touch resolve to browser shims.
//   3. It emits to `dist-app/`, NOT `dist/`. `dist/` is committed and CI
//      checks its file set against a kiosk build; writing the app bundle
//      there would fail that check on every build.
//
// Build with: npm run app:build

const path = require("path");
const webpack = require("webpack");
const baseConfig = require("./webpack.config");

module.exports = (env) => {
  const config = baseConfig({ ...env, BUILD_PRODUCTION: "true", STANDALONE: true });

  config.output = {
    ...config.output,
    path: path.resolve(__dirname, "dist-app"),
    // Capacitor loads the bundle from a file:// - backed origin where an
    // absolute "/" publicPath resolves to the device filesystem root.
    publicPath: "",
  };

  // The controllers live outside client/src, so the base babel rule (scoped
  // to src/) skips them. Extend it rather than adding a second rule so both
  // trees get the same browserslist targets — the app's floor is Android
  // WebView, which is older than the kiosk's desktop Firefox.
  const babelRule = config.module.rules.find(
    (r) => r.use && r.use.loader === "babel-loader"
  );
  babelRule.include.push(path.resolve(__dirname, "../server"));

  config.resolve = {
    ...config.resolve,
    alias: {
      ...config.resolve.alias,
      // `glmLightningCtrl` imports "h5wasm/node", whose entry reads the WASM
      // binary off disk with fs. The package's default export is the same
      // library built to fetch its WASM instead, which is what a WebView can
      // actually do.
      // Exact-match ($) and resolved to the file, not the package: aliasing to
      // the bare name let webpack's exports-map resolution land back on the
      // node build and fail on `require("module")`. The browser build embeds
      // its WASM, so no separate binary has to be shipped beside the bundle.
      ["h5wasm/node$"]: path.resolve(
        __dirname,
        "../node_modules/h5wasm/dist/esm/hdf5_hl.js"
      ),
    },
    fallback: {
      ...(config.resolve.fallback || {}),
      zlib: path.resolve(__dirname, "src/standalone/shims/zlib.js"),
      fs: path.resolve(__dirname, "src/standalone/shims/fs.js"),
      path: path.resolve(__dirname, "src/standalone/shims/path.js"),
      buffer: require.resolve("buffer/"),
      // Reached only by code paths the app never runs (the Level III parser
      // has a bzip branch for a product this project does not request), but
      // webpack resolves imports statically, so they still need an answer.
      stream: false,
      crypto: false,
      http: false,
      https: false,
      url: false,
      util: false,
      os: false,
      net: false,
      tls: false,
      child_process: false,
    },
  };

  config.plugins = [
    ...config.plugins,
    // The decoders are Buffer-based (Level III radials, MRMS GRIB2, GLM
    // HDF5). Providing the polyfill as a global is what lets those files stay
    // byte-identical to the ones the server tests exercise.
    new webpack.ProvidePlugin({ Buffer: ["buffer", "Buffer"] }),
    // The Level III library builds its product and packet tables by reading
    // its own folders with fs.readdirSync, which a bundle has no way to do.
    // Replaced by static equivalents (src/standalone/shims/nexrad*.js),
    // guarded by test/standaloneProducts.test.js.
    //
    // Matched on the RESOLVED path, not the request: the library reaches these
    // two modules by relative path from inside the package ("./products",
    // "../packets") as well as by package path, and a resolve.alias entry only
    // matches the request string — it missed the relative ones, leaving the
    // readdirSync copies in the bundle.
    new webpack.NormalModuleReplacementPlugin(
      /nexrad-level-3-data[\\/]src[\\/]products[\\/]index\.js$/,
      path.resolve(__dirname, "src/standalone/shims/nexradProducts.js")
    ),
    new webpack.NormalModuleReplacementPlugin(
      /nexrad-level-3-data[\\/]src[\\/]packets[\\/]index\.js$/,
      path.resolve(__dirname, "src/standalone/shims/nexradPackets.js")
    ),
  ];

  // Decoded radar payloads are large; the default 244 KiB asset warning would
  // fire on every build and train the eye to ignore it.
  config.performance = { hints: false };

  return config;
};
