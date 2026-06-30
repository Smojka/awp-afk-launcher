const pkg = require('./package.json');

const base = pkg.build;

module.exports = {
  ...base,
  appId: 'com.smojka.chunkkeeper.web',
  productName: 'ChunkKeeper Web',
  // The Web build (portable EXE / unmanaged DMG) cannot auto-update; disabling publish
  // keeps it from emitting an update-metadata file that would collide with the native build.
  publish: null,
  extraMetadata: {
    main: 'dist-electron/electron/web-main.js'
  },
  mac: {
    ...base.mac,
    artifactName: 'ChunkKeeper-Web-${version}-${arch}.${ext}'
  },
  dmg: {
    ...base.dmg,
    artifactName: 'ChunkKeeper-Web-${version}-${arch}.${ext}'
  },
  win: {
    ...base.win,
    target: [
      'portable'
    ],
    artifactName: 'ChunkKeeper-Web-Portable-${version}-${arch}.${ext}'
  },
  portable: {
    artifactName: 'ChunkKeeper-Web-Portable-${version}-${arch}.${ext}'
  }
};
