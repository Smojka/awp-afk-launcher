const pkg = require('./package.json');

const base = pkg.build;

module.exports = {
  ...base,
  appId: 'com.smojka.chunkkeeper.web',
  productName: 'ChunkKeeper Web',
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
